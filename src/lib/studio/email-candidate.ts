import type { ExtractedEmail } from "@/lib/studio/email-extraction";

export type SignedEmailCandidate = {
  version: 1;
  input_hash: string;
  issued_at: string;
  email: ExtractedEmail;
  signature: string;
};

const RECEIPT_MAX_AGE_MS = 30 * 60 * 1000;

const bytesToBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const base64UrlToBytes = (value: string) => {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const sha256 = async (value: string) =>
  bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));

export const emailCandidateInputHash = (raw: string, subjectOverride?: string) =>
  sha256(JSON.stringify({ raw, subject_override: (subjectOverride ?? "").trim() }));

const unsignedCandidate = (candidate: Omit<SignedEmailCandidate, "signature">) => JSON.stringify(candidate);

const hmacKey = (secret: string, usage: KeyUsage[]) =>
  crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usage,
  );

export async function issueEmailCandidate(
  email: ExtractedEmail,
  raw: string,
  subjectOverride: string | undefined,
  secret: string,
  now = new Date(),
): Promise<SignedEmailCandidate> {
  const candidate = {
    version: 1 as const,
    input_hash: await emailCandidateInputHash(raw, subjectOverride),
    issued_at: now.toISOString(),
    email,
  };
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, ["sign"]),
    new TextEncoder().encode(unsignedCandidate(candidate)),
  );
  return { ...candidate, signature: bytesToBase64Url(new Uint8Array(signature)) };
}

const isExtractedEmail = (value: unknown): value is ExtractedEmail => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const email = value as Record<string, unknown>;
  return typeof email.subject === "string"
    && Boolean(email.subject.trim())
    && (email.preheader === null || typeof email.preheader === "string")
    && typeof email.body_md === "string"
    && Boolean(email.body_md.trim());
};

export async function verifyEmailCandidate(
  value: unknown,
  raw: string,
  subjectOverride: string | undefined,
  secret: string,
  now = new Date(),
): Promise<ExtractedEmail | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<SignedEmailCandidate>;
  if (
    candidate.version !== 1
    || typeof candidate.input_hash !== "string"
    || typeof candidate.issued_at !== "string"
    || typeof candidate.signature !== "string"
    || !isExtractedEmail(candidate.email)
  ) return null;
  const issuedAt = Date.parse(candidate.issued_at);
  if (!Number.isFinite(issuedAt) || issuedAt > now.getTime() + 60_000 || now.getTime() - issuedAt > RECEIPT_MAX_AGE_MS) return null;
  if (candidate.input_hash !== await emailCandidateInputHash(raw, subjectOverride)) return null;

  const unsigned = {
    version: 1 as const,
    input_hash: candidate.input_hash,
    issued_at: candidate.issued_at,
    email: candidate.email,
  };
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret, ["verify"]),
      base64UrlToBytes(candidate.signature),
      new TextEncoder().encode(unsignedCandidate(unsigned)),
    );
    return valid ? candidate.email : null;
  } catch {
    return null;
  }
}
