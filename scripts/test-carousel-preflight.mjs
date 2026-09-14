#!/usr/bin/env node

import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertStudioCarouselRuntimeReady,
  proveStudioCarouselFitReady,
  proveStudioCarouselBrowserReady,
  studioCarouselBrowserEnv,
  STUDIO_CAROUSEL_FIT_PROBE_ATTEMPTS,
  STUDIO_CAROUSEL_FIT_VIRTUAL_TIME_MS,
  STUDIO_CAROUSEL_RUNTIME_ASSETS,
} from "./studio-carousel-preflight.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "studio-carousel-preflight-"));
const runtime = join(scratch, "scripts");
const fakeChrome = join(scratch, "chrome");

try {
  cpSync(join(scriptsDir, "carousel-assets"), join(runtime, "carousel-assets"), { recursive: true });
  cpSync(join(scriptsDir, "carousel-templates"), join(runtime, "carousel-templates"), { recursive: true });
  writeFileSync(fakeChrome, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeChrome, 0o755);

  const proof = assertStudioCarouselRuntimeReady({
    scriptDir: runtime,
    chromeCandidates: [fakeChrome],
  });
  assert.deepEqual([...proof.loadedLooks].sort(), ["cobalt", "editorial", "explainer", "manifesto", "threshold"]);
  assert.equal(proof.loadedAssets.length, STUDIO_CAROUSEL_RUNTIME_ASSETS.length);

  const fitDetail = Buffer.from(JSON.stringify({ looks: "hermetic-browser-proof" }), "utf8").toString("base64");
  const chromeEnvs = [];
  const browserEnv = studioCarouselBrowserEnv({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ANTHROPIC_API_KEY: "sentinel-anthropic-secret",
    SUPABASE_SERVICE_ROLE_KEY: "sentinel-supabase-secret",
    FAL_KEY: "sentinel-fal-secret",
    OPENAI_API_KEY: "sentinel-openai-secret",
    API_SECRET_KEY: "sentinel-machine-secret",
  });
  const browserProof = await proveStudioCarouselBrowserReady({
    proof,
    scratchParent: scratch,
    env: browserEnv,
    runChrome: async (_chrome, args, options) => {
      chromeEnvs.push(options.env);
      const screenshot = args.find((arg) => arg.startsWith("--screenshot="));
      if (screenshot) {
        writeFileSync(
          screenshot.slice("--screenshot=".length),
          Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]),
        );
        return { stdout: "" };
      }
      return {
        stdout: `<html data-studio-carousel-fit="pass" data-studio-carousel-fit-detail="${fitDetail}"></html>`,
      };
    },
  });
  assert.equal(browserProof.browserProofs.length, 5);
  assert.deepEqual(
    browserProof.browserProofs.map((item) => item.look).sort(),
    ["cobalt", "editorial", "explainer", "manifesto", "threshold"],
  );
  assert(chromeEnvs.length === 10);
  for (const env of chromeEnvs) {
    for (const secret of ["ANTHROPIC_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "FAL_KEY", "OPENAI_API_KEY", "API_SECRET_KEY"]) {
      assert.equal(env[secret], undefined, `${secret} leaked into the Chrome preflight environment`);
    }
  }

  let productionFitAttempts = 0;
  const productionFit = await proveStudioCarouselFitReady({
    chrome: fakeChrome,
    htmlFile: join(runtime, "carousel-templates", "cobalt.html"),
    width: 1080,
    height: 1350,
    label: "production parity",
    env: browserEnv,
    runChrome: async (_chrome, args, options) => {
      productionFitAttempts += 1;
      assert(args.includes(`--virtual-time-budget=${STUDIO_CAROUSEL_FIT_VIRTUAL_TIME_MS}`));
      assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
      if (productionFitAttempts < STUDIO_CAROUSEL_FIT_PROBE_ATTEMPTS) return { stdout: "<html></html>" };
      return { stdout: `<html data-studio-carousel-fit="pass" data-studio-carousel-fit-detail="${fitDetail}"></html>` };
    },
  });
  assert.equal(productionFit.status, "pass");
  assert.equal(productionFitAttempts, 3, "production fit proof did not use the bounded setup retry contract");

  await assert.rejects(
    () => proveStudioCarouselBrowserReady({
      proof,
      scratchParent: scratch,
      runChrome: async () => ({ stdout: "<html></html>" }),
    }),
    /fit proof did not complete/,
    "a browser that never completed the trusted DOM proof passed preflight",
  );

  assert.throws(
    () => assertStudioCarouselRuntimeReady({ scriptDir: runtime, chromeCandidates: [join(scratch, "missing-chrome")] }),
    /No executable Chrome\/Chromium/,
    "missing Chrome did not fail the pre-claim runtime proof",
  );

  const missingAsset = STUDIO_CAROUSEL_RUNTIME_ASSETS[0];
  rmSync(join(runtime, missingAsset));
  assert.throws(
    () => assertStudioCarouselRuntimeReady({ scriptDir: runtime, chromeCandidates: [fakeChrome] }),
    new RegExp(missingAsset.split("/").at(-1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "a missing signed asset passed the runtime proof",
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  chrome: "executable required",
  looks: 5,
  browser_proofs: 5,
  assets: STUDIO_CAROUSEL_RUNTIME_ASSETS.length,
}));
