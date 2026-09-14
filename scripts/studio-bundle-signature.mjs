import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const STUDIO_RELEASE_SIGNING_IDENTITY = "studio-release";
export const STUDIO_RELEASE_SIGNING_NAMESPACE = "studio-bundle";
export const STUDIO_PRODUCTION_PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJSSVH4wfBJfTVYN8f7SRUpmekye9D7KLiKr4bzOFCXy";

export function normalizeStudioEd25519PublicKey(value) {
  const key = String(value ?? "").trim().split(/\s+/).slice(0, 2).join(" ");
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(key)) {
    throw new Error("Studio bundle verification received an invalid Ed25519 public key");
  }
  return key;
}

export function assertStudioBundleSigningPublicKey({
  publicKey,
  mode = "production",
}) {
  if (mode !== "production" && mode !== "test") {
    throw new Error("Studio bundle signing mode must be production or test");
  }
  const normalized = normalizeStudioEd25519PublicKey(publicKey);
  if (mode === "production" && normalized !== STUDIO_PRODUCTION_PUBLIC_KEY) {
    throw new Error(
      "Studio production signing key does not match the installer trust anchor; refusing to build",
    );
  }
  return Object.freeze({ mode, publicKey: normalized });
}

/**
 * Verify the exact manifest bytes before they are parsed or used to locate an
 * archive. Production always uses the installer trust anchor. Tests may opt
 * into a different explicit pin, but they cannot override production mode.
 */
export function verifyStudioManifestSignature({
  manifestBytes,
  signaturePath,
  mode = "production",
  testPublicKey = null,
}) {
  if (!Buffer.isBuffer(manifestBytes)) {
    throw new TypeError("Studio bundle verification requires the raw manifest bytes");
  }
  if (mode !== "production" && mode !== "test") {
    throw new Error("Studio bundle signature mode must be production or test");
  }
  if (mode === "production" && testPublicKey) {
    throw new Error("Production Studio verification cannot use a test signing key");
  }

  const publicKey = normalizeStudioEd25519PublicKey(
    mode === "test" ? testPublicKey : STUDIO_PRODUCTION_PUBLIC_KEY,
  );
  const scratch = mkdtempSync(join(tmpdir(), "studio-signature-"));
  const allowedSigners = join(scratch, "allowed_signers");
  writeFileSync(
    allowedSigners,
    `${STUDIO_RELEASE_SIGNING_IDENTITY} ${publicKey}\n`,
    { mode: 0o600 },
  );
  try {
    execFileSync(
      "ssh-keygen",
      [
        "-Y",
        "verify",
        "-f",
        allowedSigners,
        "-I",
        STUDIO_RELEASE_SIGNING_IDENTITY,
        "-n",
        STUDIO_RELEASE_SIGNING_NAMESPACE,
        "-s",
        signaturePath,
      ],
      { input: manifestBytes, stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch {
    throw new Error("Studio bundle manifest signature verification failed");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return Object.freeze({ mode, publicKey });
}

export function readAndVerifyStudioManifest({
  manifestPath,
  signaturePath,
  mode = "production",
  testPublicKey = null,
}) {
  const manifestBytes = readFileSync(manifestPath);
  verifyStudioManifestSignature({ manifestBytes, signaturePath, mode, testPublicKey });
  return { manifestBytes, manifest: JSON.parse(manifestBytes.toString("utf8")) };
}
