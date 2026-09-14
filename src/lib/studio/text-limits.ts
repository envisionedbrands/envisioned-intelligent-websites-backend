/**
 * Human-authored Studio text is stored in Postgres and later enters a model
 * context. Keep one card from becoming an unbounded request while the context
 * assembler still protects installations that already contain larger legacy
 * values.
 */
export const MAX_STUDIO_CONTEXT_TEXT_CHARS = 64_000;

export type StudioContextTextSaveDecision =
  | { ok: true; legacyPreserved: boolean }
  | { ok: false; error: string; status: 400 | 413; code: "studio_text_invalid" | "studio_text_too_large" };

export function studioContextTextError(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return `${label} must be text`;
  if (value.length > MAX_STUDIO_CONTEXT_TEXT_CHARS) {
    return `${label} is too long. Keep it to ${MAX_STUDIO_CONTEXT_TEXT_CHARS.toLocaleString("en-US")} characters or fewer.`;
  }
  return null;
}

/**
 * A full-board save carries every card, including rows created before the
 * current per-card limit existed. Preserve an oversized legacy value only
 * when the incoming bytes are identical to the saved bytes. New or edited
 * oversized text must become valid before it can be persisted.
 */
export function validateStudioContextTextSave(
  value: unknown,
  label: string,
  persistedValue: unknown,
): StudioContextTextSaveDecision {
  const error = studioContextTextError(value, label);
  if (!error) return { ok: true, legacyPreserved: false };
  if (
    typeof value === "string"
    && value.length > MAX_STUDIO_CONTEXT_TEXT_CHARS
    && typeof persistedValue === "string"
    && value === persistedValue
  ) {
    return { ok: true, legacyPreserved: true };
  }
  return {
    ok: false,
    error,
    status: typeof value === "string" ? 413 : 400,
    code: typeof value === "string" ? "studio_text_too_large" : "studio_text_invalid",
  };
}

/** Bound content created by a browser action before it enters graph state. */
export function limitStudioContextText(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_STUDIO_CONTEXT_TEXT_CHARS) return { text: value, truncated: false };
  return { text: value.slice(0, MAX_STUDIO_CONTEXT_TEXT_CHARS), truncated: true };
}
