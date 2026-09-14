import { classifyStudioAnthropicPaidResponse } from "@/lib/studio/worker-anthropic-capability";

export type ExtractedEmail = { subject: string; preheader: string | null; body_md: string };

export type EmailExtractionErrorCode =
  | "email_extractor_not_configured"
  | "email_extractor_auth_failed"
  | "email_extractor_policy_blocked"
  | "email_extractor_rate_limited"
  | "email_extractor_timed_out"
  | "email_extractor_too_long"
  | "email_extractor_unavailable"
  | "email_extractor_invalid_response"
  | "email_extractor_unsafe_content"
  | "email_source_too_large"
  | "email_subject_missing";

export class EmailExtractionError extends Error {
  readonly code: EmailExtractionErrorCode;
  readonly status: number;

  constructor(
    message: string,
    code: EmailExtractionErrorCode,
    status: number,
  ) {
    super(message);
    this.name = "EmailExtractionError";
    this.code = code;
    this.status = status;
  }
}

type AnthropicExtractionResponse = {
  content?: { text?: string }[];
  stop_reason?: string;
};

export const EMAIL_EXTRACTION_TIMEOUT_MS = 45_000;
export const EMAIL_SOURCE_MAX_ESTIMATED_TOKENS = 6_000;

export function estimateEmailSourceTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if (character.charCodeAt(0) <= 0x7f) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / 3) + nonAscii;
}

const safeCodePoint = (raw: string, radix: number) => {
  const point = Number.parseInt(raw, radix);
  return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
    ? String.fromCodePoint(point)
    : "";
};

const decodeLinkEntities = (value: string) =>
  value
    .replace(/&#(\d+);?/g, (_match, decimal: string) => safeCodePoint(decimal, 10))
    .replace(/&#x([0-9a-f]+);?/gi, (_match, hex: string) => safeCodePoint(hex, 16))
    .replace(/&colon;/gi, ":")
    .replace(/&tab;/gi, "\t")
    .replace(/&newline;/gi, "\n")
    .replace(/&amp;/gi, "&");

const unsafeEmailLink = (value: string) => {
  const decoded = decodeLinkEntities(value)
    // CommonMark removes a backslash before ASCII punctuation when it parses
    // link destinations. Apply that same normalization before checking the
    // scheme so `javascript\:` cannot become dangerous only after approval.
    .replace(/\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])/g, "$1")
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/[\u0000-\u0020\u007f]+/g, "");
  if (!decoded || decoded.startsWith("#") || (decoded.startsWith("/") && !decoded.startsWith("//"))) return false;
  if (decoded.startsWith("//")) return true;
  const scheme = decoded.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  return Boolean(scheme && !["https", "http", "mailto", "tel"].includes(scheme));
};

/** The host CRM renderer accepts raw HTML, so Studio emails fail closed before
 * they become templates. This keeps test-send, review, and delivered content
 * on one boundary without changing non-Studio CRM templates. */
export function emailMarkdownSafetyIssue(bodyMd: string): string | null {
  if (/<!--|<!doctype|<\?xml|<\/?[a-z][a-z0-9-]*(?=[\s/>])[^>]*>/i.test(bodyMd)) {
    return "raw HTML";
  }
  // CommonMark permits multiline alt text and reference-form images. Studio
  // email deliberately allows no Markdown image syntax, so fail closed at the
  // opener instead of trying to duplicate the parser's full image grammar.
  if (/!\[/.test(bodyMd)) return "embedded Markdown images";

  const destinations: string[] = [];
  // Marked treats angle-bracket destinations as autolinks, including schemes
  // such as `<javascript:...>` that do not use the ordinary `[label](href)`
  // shape. Inspect them through the same protocol allowlist.
  for (const match of bodyMd.matchAll(/<([^<>\n]+)>/g)) {
    destinations.push(match[1] ?? "");
  }
  for (const match of bodyMd.matchAll(/\](?:\[[^\]\n]*\])?\s*\(\s*(?:<([^>\n]+)>|([^\s)\n]+))/g)) {
    destinations.push(match[1] ?? match[2] ?? "");
  }
  // Reference labels may span lines and may contain escaped punctuation.
  // Match the complete definition rather than assuming a single-line label.
  for (const match of bodyMd.matchAll(/^\s{0,3}\[(?:\\[^\n]|[^\]\\])+\]:\s*(?:<([^>\n]+)>|([^\s\n]+))/gm)) {
    destinations.push(match[1] ?? match[2] ?? "");
  }
  // Merge tags are expanded before the CRM's Markdown renderer. Even a safe
  // looking dynamic value can carry an unsafe fallback (or recipient value)
  // that becomes the real href only at delivery time. Personalisation remains
  // supported in prose, but link destinations must be concrete at approval.
  if (destinations.some((destination) => destination.includes("{{"))) {
    return "a merge tag inside a link destination";
  }
  return destinations.some(unsafeEmailLink) ? "an unsafe link protocol" : null;
}

/**
 * Pull the final email out of a conversational desk reply. Queueing is
 * fail-closed: a provider failure can never turn the whole conversation into
 * a list email or create a half-extracted approval draft.
 */
export async function extractEmailWithClaude(opts: {
  raw: string;
  subjectOverride?: string;
  cta?: string | null;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ExtractedEmail> {
  const subjectOverride = (opts.subjectOverride ?? "").trim();
  if (estimateEmailSourceTokens(opts.raw) > EMAIL_SOURCE_MAX_ESTIMATED_TOKENS) {
    throw new EmailExtractionError(
      "This desk reply is larger than the email extractor can preserve safely. Nothing was queued. Shorten the draft and retry.",
      "email_source_too_large",
      422,
    );
  }
  if (!opts.apiKey) {
    throw new EmailExtractionError(
      "The email extractor is not configured. Nothing was queued. Ask your Builder to configure ANTHROPIC_API_KEY, then retry.",
      "email_extractor_not_configured",
      503,
    );
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = Math.max(1, Math.min(60_000, Math.round(opts.timeoutMs ?? EMAIL_EXTRACTION_TIMEOUT_MS)));
  let response: Response;
  try {
    // redirect:"manual", never "error" (the Workers runtime throws on it);
    // an unfollowed 3xx is !ok and fails closed as spend-ambiguous below.
    response = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      redirect: "manual",
      headers: {
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        // The desk itself may produce 4,000 tokens. Leave room for the whole
        // bounded email plus its JSON envelope; truncation fails closed below.
        max_tokens: 5200,
        messages: [{
          role: "user",
          content:
            "Extract the FINAL email from this content-desk reply. Strip meta-text (subject option lists, 'want me to…' chatter, section labels). " +
            'Return ONLY JSON: {"subject": the best subject line' +
            (subjectOverride
              ? ` (the user chose: "${subjectOverride}" — use it verbatim)`
              : " (pick the strongest option if several are listed)") +
            ', "preheader": inbox preview under 90 chars, "body_md": the email body in markdown, ending before any signature block; keep {{first_name|there}} merge tags if present, add none}. ' +
            (opts.cta
              ? `LINKS: if the email contains a bracketed link placeholder with no URL, replace it with a real markdown link using the best-matching URL from this CTA list; if nothing matches, leave the text as-is:\n${opts.cta}\n\n`
              : "") +
            opts.raw,
        }],
      }),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new EmailExtractionError(
      timedOut
        ? "The email extractor timed out after submitting the paid request. Nothing was queued, and Studio did not retry the spend-ambiguous request automatically."
        : "The email extractor lost the response after submitting the paid request. Nothing was queued, and Studio did not retry the spend-ambiguous request automatically.",
      timedOut ? "email_extractor_timed_out" : "email_extractor_unavailable",
      503,
    );
  }

  if (!response.ok) {
    const result = classifyStudioAnthropicPaidResponse(response);
    if (result.action === "fail_closed_permanent") {
      const message = result.upstream_status === 400
        ? "Anthropic permanently rejected the email-extraction request as invalid (HTTP 400). Nothing was queued; correct the request or deployed Studio configuration before sending a new request."
        : result.upstream_status === 404
          ? "Anthropic could not find the configured email-extraction resource (HTTP 404). Nothing was queued; ask your Builder to correct the endpoint or model before sending a new request."
          : "Anthropic permanently rejected the email-extraction payload as too large (HTTP 413). Nothing was queued; shorten the draft before sending a new request.";
      throw new EmailExtractionError(message, "email_extractor_invalid_response", 422);
    }
    throw new EmailExtractionError(
      "Anthropic returned a spend-ambiguous response after the paid email-extraction request was submitted. Nothing was queued, and Studio did not retry it automatically; ask your Builder to verify the direct Anthropic path before sending a new request.",
      "email_extractor_unavailable",
      503,
    );
  }

  let rawResponse: string;
  try {
    rawResponse = await response.text();
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new EmailExtractionError(
      timedOut
        ? "The email extractor timed out while returning the email. Nothing was queued. Please retry."
        : "The email extractor response was interrupted. Nothing was queued. Please retry.",
      timedOut ? "email_extractor_timed_out" : "email_extractor_unavailable",
      503,
    );
  }
  let json: AnthropicExtractionResponse;
  try {
    json = JSON.parse(rawResponse) as AnthropicExtractionResponse;
  } catch {
    throw new EmailExtractionError(
      "The email extractor returned an unreadable response. Nothing was queued. Please retry.",
      "email_extractor_invalid_response",
      502,
    );
  }

  if (!json || typeof json !== "object") {
    throw new EmailExtractionError(
      "The email extractor returned an incomplete response. Nothing was queued. Please retry.",
      "email_extractor_invalid_response",
      502,
    );
  }

  if (json.stop_reason === "max_tokens") {
    throw new EmailExtractionError(
      "This email was too long for the extractor to finish safely. Nothing was queued. Shorten the draft slightly and retry.",
      "email_extractor_too_long",
      422,
    );
  }

  if (
    json.stop_reason !== "end_turn"
    || !Array.isArray(json.content)
    || typeof json.content[0]?.text !== "string"
  ) {
    throw new EmailExtractionError(
      "The email extractor returned an incomplete response. Nothing was queued. Please retry.",
      "email_extractor_invalid_response",
      502,
    );
  }

  const match = json.content[0].text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new EmailExtractionError(
      "The email extractor did not return a usable email. Nothing was queued. Please retry.",
      "email_extractor_invalid_response",
      502,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]) as unknown;
  } catch {
    throw new EmailExtractionError(
      "The email extractor did not finish a usable email. Nothing was queued. Please retry.",
      "email_extractor_invalid_response",
      502,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EmailExtractionError(
      "The email extractor returned an invalid email shape. Nothing was queued. Please retry.",
      "email_extractor_invalid_response",
      502,
    );
  }
  const fields = parsed as Record<string, unknown>;
  if (
    (fields.subject !== undefined && typeof fields.subject !== "string")
    || (fields.preheader !== undefined && fields.preheader !== null && typeof fields.preheader !== "string")
    || (fields.body_md !== undefined && typeof fields.body_md !== "string")
  ) {
    throw new EmailExtractionError(
      "The email extractor returned invalid email fields. Nothing was queued. Please retry.",
      "email_extractor_invalid_response",
      502,
    );
  }

  const subject = subjectOverride || (fields.subject as string | undefined)?.trim() || "";
  const bodyMd = (fields.body_md as string | undefined)?.trim() || "";
  if (!subject) {
    throw new EmailExtractionError(
      "The desk could not choose a subject. Enter a subject override, then retry.",
      "email_subject_missing",
      422,
    );
  }
  if (!bodyMd) {
    throw new EmailExtractionError(
      "The email extractor did not return an email body. Nothing was queued. Please retry.",
      "email_extractor_invalid_response",
      502,
    );
  }
  const safetyIssue = emailMarkdownSafetyIssue(bodyMd);
  if (safetyIssue) {
    throw new EmailExtractionError(
      `The email extractor returned ${safetyIssue}. Nothing was queued. Ask the desk to use plain Markdown links, then retry.`,
      "email_extractor_unsafe_content",
      422,
    );
  }

  return {
    subject,
    preheader: (fields.preheader as string | null | undefined)?.trim() || null,
    body_md: bodyMd,
  };
}
