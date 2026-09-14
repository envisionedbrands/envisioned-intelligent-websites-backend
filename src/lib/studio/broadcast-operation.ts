export type BroadcastAudienceMode = "all" | "tags";

export type BroadcastOperationInput = {
  message: string;
  subject?: string;
  audienceMode: BroadcastAudienceMode;
  tags: string[];
  scheduledAt: string | null;
  campaignIntent: string;
  /** The verified HMAC receipt for an exact test-send candidate. Binding it
   *  prevents a response-loss retry from returning an older tested email. */
  candidateSignature?: string;
};

const bytesToHex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export function normalizeBroadcastTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((tag) => String(tag).trim())
    .filter((tag) => tag.length > 0 && tag.length <= 100))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 50);
}

export async function broadcastPayloadHash(input: BroadcastOperationInput): Promise<string> {
  const canonical = JSON.stringify({
    message: input.message,
    subject: (input.subject ?? "").trim(),
    audience_mode: input.audienceMode,
    tags: input.tags,
    scheduled_at: input.scheduledAt,
    campaign_intent: input.campaignIntent,
    candidate_signature: input.candidateSignature ?? "",
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return bytesToHex(new Uint8Array(digest));
}
