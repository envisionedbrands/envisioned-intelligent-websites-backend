import {
  classifyStudioAnthropicPaidResponse,
  type StudioAnthropicPaidResponse,
  type StudioWorkerAnthropicCode,
} from "@/lib/studio/worker-anthropic-capability";

export type AnthropicMessage = { role: string; content: unknown };

export type AnthropicResponse = {
  content?: { type: string; text?: string; [key: string]: unknown }[];
  stop_reason?: string;
  error?: { message?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
};

export type AnthropicContinuationResult = {
  reply: string;
  usage: { input: number | null; output: number | null };
  /** Aggregate replay cost across the continuation requests. */
  continuationTokens: number;
};

export const STUDIO_ANTHROPIC_REQUEST_TIMEOUT_MS = 5 * 60_000;

export class AnthropicRequestError extends Error {
  readonly code: StudioWorkerAnthropicCode;

  constructor(message: string, code: StudioWorkerAnthropicCode) {
    super(message);
    this.name = "AnthropicRequestError";
    this.code = code;
  }
}

export function safeAnthropicRequestErrorPayload(error: unknown) {
  return {
    error: error instanceof Error ? error.message : "The writing model request failed. Please retry.",
    ...(error instanceof AnthropicRequestError ? { code: error.code } : {}),
  };
}

function safeAnthropicFailure(result: StudioAnthropicPaidResponse) {
  if (result.action === "fail_closed_permanent") {
    switch (result.upstream_status) {
      case 400:
        return new AnthropicRequestError(
          "Anthropic permanently rejected this request as invalid (HTTP 400). Correct the request or deployed Studio configuration before sending a new request.",
          "worker_anthropic_unavailable",
        );
      case 404:
        return new AnthropicRequestError(
          "Anthropic could not find the configured Messages resource (HTTP 404). Ask your Builder to correct the deployed endpoint or model before sending a new request.",
          "worker_anthropic_unavailable",
        );
      case 413:
        return new AnthropicRequestError(
          "Anthropic permanently rejected this request because its payload was too large (HTTP 413). Reduce the desk context before sending a new request.",
          "worker_anthropic_unavailable",
        );
    }
  }

  const code: StudioWorkerAnthropicCode = result.upstream_status >= 400 && result.upstream_status < 500
    ? "worker_anthropic_unverified_rejection"
    : "worker_anthropic_unavailable";
  return new AnthropicRequestError(
    "Anthropic returned a spend-ambiguous response after this paid request was submitted. Studio did not retry it automatically; ask your Builder to verify the direct Anthropic path before sending a new request.",
    code,
  );
}

/**
 * Run an Anthropic turn that may pause while a server tool is working.
 *
 * Anthropic's repeated `pause_turn` contract requires the newest paused
 * assistant response to replace the previous paused assistant response. It is
 * not a new conversational turn. Appending both creates consecutive assistant
 * messages and replays stale server-tool state on the third request.
 */
export async function runAnthropicWithPauseTurns(opts: {
  apiKey: string;
  model: string;
  system: string;
  messages: AnthropicMessage[];
  tools?: unknown[];
  maxOutputTokens: number;
  maxContinuationRounds: number;
  continuationReserveTokens: number;
  inputCeilingTokens: number;
  plannedInputTokens: number;
  estimateContinuationTokens: (content: unknown) => number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<AnthropicContinuationResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const messages = opts.messages.map((message) => ({ ...message }));
  let json: AnthropicResponse = {};
  let continuationTokens = 0;
  let activePausedTokens = 0;
  let pausedAssistantIndex: number | null = null;
  const timeoutMs = Math.max(
    1_000,
    Math.min(5 * 60_000, Math.round(opts.timeoutMs ?? STUDIO_ANTHROPIC_REQUEST_TIMEOUT_MS)),
  );

  for (let round = 0; round <= opts.maxContinuationRounds; round++) {
    let res: Response;
    try {
      // redirect:"manual", never "error": the Workers runtime throws on
      // "error". A 3xx comes back unfollowed (x-api-key is never forwarded)
      // and classifyStudioAnthropicPaidResponse fails it closed.
      res = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        redirect: "manual",
        headers: {
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model: opts.model,
          max_tokens: opts.maxOutputTokens,
          system: opts.system,
          messages,
          ...(opts.tools ? { tools: opts.tools } : {}),
        }),
      });
    } catch (error) {
      const timedOut = error instanceof Error
        && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new AnthropicRequestError(
        timedOut
          ? "Anthropic did not return a response within the deployed Worker's limit after this paid request was submitted. Studio did not retry the spend-ambiguous request automatically."
          : "The deployed Worker lost the Anthropic response after this paid request was submitted. Studio did not retry the spend-ambiguous request automatically.",
        "worker_anthropic_unavailable",
      );
    }
    const responseResult = classifyStudioAnthropicPaidResponse(res);
    if (responseResult.action !== "accept") {
      const failure = safeAnthropicFailure(responseResult);
      await res.body?.cancel().catch(() => undefined);
      throw failure;
    }
    let raw: string;
    try {
      raw = await res.text();
    } catch {
      throw new AnthropicRequestError(
        "Anthropic returned HTTP 200, but the paid response body was interrupted. Studio did not retry the spend-ambiguous request automatically.",
        "worker_anthropic_unavailable",
      );
    }
    try {
      json = JSON.parse(raw) as AnthropicResponse;
    } catch {
      throw new AnthropicRequestError(
        `Anthropic returned an unreadable paid response (${res.status}). Studio did not retry it automatically.`,
        "worker_anthropic_unavailable",
      );
    }
    if (json.stop_reason !== "pause_turn") break;
    if (round >= opts.maxContinuationRounds) {
      throw new Error("Research did not finish within this desk's safe continuation limit. Narrow the request and try again.");
    }

    const nextTokens = opts.estimateContinuationTokens(json.content ?? []);
    if (continuationTokens + nextTokens > opts.continuationReserveTokens) {
      throw new Error("Research exceeded this desk's safe continuation budget. Narrow the request or raise the desk context limit.");
    }

    // The provider's input usage for a repeated pause already includes the
    // prior paused assistant state. Subtract our conservative estimate before
    // projecting its replacement, otherwise the old and new states are
    // incorrectly charged as if both will be replayed.
    const measuredInputTokens = Number.isFinite(json.usage?.input_tokens)
      ? Number(json.usage?.input_tokens)
      : opts.plannedInputTokens + activePausedTokens;
    const projectedInputTokens = Math.max(
      opts.plannedInputTokens + nextTokens,
      measuredInputTokens - activePausedTokens + nextTokens,
    );
    if (projectedInputTokens > opts.inputCeilingTokens + opts.continuationReserveTokens) {
      throw new Error("Research reached this desk's safe model window. Narrow the request before continuing.");
    }

    continuationTokens += nextTokens;
    const pausedMessage: AnthropicMessage = { role: "assistant", content: json.content ?? [] };
    if (pausedAssistantIndex === null) {
      messages.push(pausedMessage);
      pausedAssistantIndex = messages.length - 1;
    } else {
      messages[pausedAssistantIndex] = pausedMessage;
    }
    activePausedTokens = nextTokens;
  }

  const reply = (json.content ?? [])
    .filter((content) => content.type === "text")
    .map((content) => content.text ?? "")
    .join("")
    .trim();
  return {
    reply,
    usage: {
      input: json.usage?.input_tokens ?? null,
      output: json.usage?.output_tokens ?? null,
    },
    continuationTokens,
  };
}
