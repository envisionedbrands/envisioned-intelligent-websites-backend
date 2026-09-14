#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertStudioBundleSigningPublicKey,
  readAndVerifyStudioManifest,
  STUDIO_PRODUCTION_PUBLIC_KEY,
  verifyStudioManifestSignature,
} from "./studio-bundle-signature.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "studio-signature-test-"));
const manifestPath = join(scratch, "manifest.json");
const manifestBytes = Buffer.from('{"product":"studio","version":"test"}\n');
writeFileSync(manifestPath, manifestBytes);

function makeKey(name) {
  const path = join(scratch, name);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path]);
  return {
    path,
    publicKey: readFileSync(`${path}.pub`, "utf8").trim().split(/\s+/).slice(0, 2).join(" "),
  };
}

function snapshotBundleOutput() {
  const path = join(root, "bundle");
  if (!existsSync(path)) return null;
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const bytes = readFileSync(join(path, entry.name));
      return [entry.name, bytes.length, createHash("sha256").update(bytes).digest("hex")];
    })
    .sort(([left], [right]) => left.localeCompare(right));
}

try {
  const keyA = makeKey("key-a");
  const keyB = makeKey("key-b");
  execFileSync(
    "ssh-keygen",
    ["-Y", "sign", "-f", keyA.path, "-n", "studio-bundle", manifestPath],
    { stdio: "ignore" },
  );
  const signaturePath = `${manifestPath}.sig`;

  assert.doesNotThrow(() => verifyStudioManifestSignature({
    manifestBytes,
    signaturePath,
    mode: "test",
    testPublicKey: keyA.publicKey,
  }));
  assert.throws(
    () => verifyStudioManifestSignature({
      manifestBytes,
      signaturePath,
      mode: "test",
      testPublicKey: keyB.publicKey,
    }),
    /signature verification failed/,
  );
  assert.throws(
    () => verifyStudioManifestSignature({
      manifestBytes,
      signaturePath,
      mode: "production",
    }),
    /signature verification failed/,
  );
  assert.throws(
    () => assertStudioBundleSigningPublicKey({
      publicKey: keyA.publicKey,
      mode: "production",
    }),
    /does not match the installer trust anchor/,
  );
  assert.equal(
    STUDIO_PRODUCTION_PUBLIC_KEY,
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJSSVH4wfBJfTVYN8f7SRUpmekye9D7KLiKr4bzOFCXy",
  );

  const builderPath = join(root, "scripts/build-bundle.mjs");
  const coldInstallPath = join(root, "scripts/test-cold-install.mjs");
  const vendorBoundaryProofs = existsSync(builderPath) && existsSync(coldInstallPath);
  if (vendorBoundaryProofs) {
    // Spoof the adjacent public-key file with the real production pin. The
    // builder must derive identity from the private key and fail before it
    // writes or replaces any bundle artifact.
    writeFileSync(`${keyA.path}.pub`, `${STUDIO_PRODUCTION_PUBLIC_KEY} spoofed-adjacent-file\n`);
    const bundleBefore = snapshotBundleOutput();
    const builderFailure = spawnSync(process.execPath, [builderPath], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        STUDIO_SIGNING_KEY: keyA.path,
        STUDIO_BUNDLE_SIGNING_MODE: "production",
      },
    });
    assert.notEqual(builderFailure.status, 0, "production builder accepted a non-pinned key");
    assert.match(
      `${builderFailure.stdout}\n${builderFailure.stderr}`,
      /does not match the installer trust anchor/,
    );
    assert.deepEqual(
      snapshotBundleOutput(),
      bundleBefore,
      "wrong private key with a spoofed pinned .pub changed bundle output before rejection",
    );

    const installBundle = join(scratch, "wrong-key-bundle");
    const installTmp = join(scratch, "cold-install-effects");
    mkdirSync(installBundle);
    mkdirSync(installTmp);
    writeFileSync(join(installBundle, "manifest.json"), manifestBytes);
    writeFileSync(join(installBundle, "manifest.sig"), readFileSync(signaturePath));
    const coldInstallFailure = spawnSync(
      process.execPath,
      [coldInstallPath, installBundle],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          TMPDIR: installTmp,
          STUDIO_COLD_INSTALL_SIGNATURE_MODE: "production",
        },
      },
    );
    assert.notEqual(coldInstallFailure.status, 0, "production cold install accepted a wrong-key manifest");
    assert.match(
      `${coldInstallFailure.stdout}\n${coldInstallFailure.stderr}`,
      /signature verification failed/,
    );
    assert.deepEqual(
      readdirSync(installTmp),
      [],
      "wrong-key cold install created work before rejecting the manifest",
    );
  }

  assert.throws(
    () => readAndVerifyStudioManifest({
      manifestPath,
      signaturePath,
      mode: "production",
    }),
    /signature verification failed/,
  );
  console.log(JSON.stringify({
    ok: true,
    accepted: "matching explicit test pin",
    rejected: [
      "wrong test pin",
      "wrong-key production signature",
      "wrong private key plus spoofed pinned .pub before output",
      "wrong-key cold install before effects",
    ],
    vendor_boundary_proofs: vendorBoundaryProofs ? "executed" : "vendor-only files absent",
  }));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
