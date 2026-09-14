export type RefinedCreativePrompt = { label: string | null; prompt: string };

export const CREATIVE_PROMPT_TIMEOUT_MS = 20_000;

/**
 * Prompt refinement is useful but not a queue/spend gate. A provider timeout,
 * throttle, or malformed response falls back to the member's bounded original
 * prompt; it can never hold the generation request open indefinitely.
 */
export async function refineCreativePrompts(opts: {
  apiKey?: string;
  prompt: string;
  split: boolean;
  formatLabel: string;
  formatDetail: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<RefinedCreativePrompt[]> {
  const original: RefinedCreativePrompt[] = [{ label: null, prompt: opts.prompt.trim().slice(0, 6000) }];
  if (!opts.apiKey) return original;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = Math.max(1, Math.min(60_000, Math.round(opts.timeoutMs ?? CREATIVE_PROMPT_TIMEOUT_MS)));
  try {
    // redirect:"manual", never "error" (the Workers runtime throws on it);
    // an unfollowed 3xx is !ok and falls back to the original prompt.
    const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
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
        max_tokens: 1500,
        messages: [{
          role: "user",
          content:
            "You turn a content desk's reply into image-generation prompt(s) for a reference-faithful image model. " +
            `The requested output is a ${opts.formatLabel} (${opts.formatDetail}). ` +
            "IGNORE all conversational meta-text (questions to the user, offers like 'want me to…', 'say the word', next-step talk) — " +
            "extract only the VISUAL concept(s). " +
            (opts.split
              ? "If the text holds several distinct visual concepts (e.g. 3 thumbnail options), return one object per concept (max 4). If a single concept is chosen/locked, return exactly that one. "
              : "Collapse everything into exactly ONE object for the single strongest/chosen concept. ") +
            'Return ONLY a JSON array of {"label": short concept name, "prompt": a complete standalone image prompt}. ' +
            "Each prompt must: replicate the reference image's exact visual format, style, typography treatment and energy; " +
            "describe the full composition concretely (subject, expression, props, layout, color blocking) — enrich thin descriptions " +
            "with detail consistent with the concept; and state any on-image text EXACTLY, quoted, with the words \"correctly spelled\".\n\n" +
            original[0].prompt,
        }],
      }),
    });
    if (!response.ok) return original;
    const raw = await response.text();
    let json: { content?: { text?: string }[] };
    try {
      json = JSON.parse(raw) as { content?: { text?: string }[] };
    } catch {
      return original;
    }
    const match = (json.content?.[0]?.text ?? "").match(/\[[\s\S]*\]/);
    if (!match) return original;
    const parsed = JSON.parse(match[0]) as { label?: unknown; prompt?: unknown }[];
    if (!Array.isArray(parsed)) return original;
    const clean = parsed
      .filter((item) => typeof item?.prompt === "string" && item.prompt.trim())
      .slice(0, opts.split ? 4 : 1)
      .map((item) => ({
        label: typeof item.label === "string" && item.label.trim() ? item.label.trim().slice(0, 120) : null,
        prompt: (item.prompt as string).trim().slice(0, 6000),
      }));
    return clean.length ? clean : original;
  } catch {
    return original;
  }
}
