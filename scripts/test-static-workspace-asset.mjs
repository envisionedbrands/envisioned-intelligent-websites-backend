#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const stripJsoncComments = (source) => {
  let result = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (character === "\n" || character === "\r") {
        lineComment = false;
        result += character;
      } else {
        result += " ";
      }
      continue;
    }

    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        result += "  ";
        index += 1;
      } else {
        result += character === "\n" || character === "\r" ? character : " ";
      }
      continue;
    }

    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      result += character;
    } else if (character === "/" && next === "/") {
      lineComment = true;
      result += "  ";
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      result += "  ";
      index += 1;
    } else {
      result += character;
    }
  }

  assert(!blockComment, "Wrangler JSONC contains an unterminated block comment");
  assert(!inString, "Wrangler JSONC contains an unterminated string");
  return result;
};

const stripJsoncTrailingCommas = (source) => {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character === ",") {
      let nextIndex = index + 1;
      while (/\s/.test(source[nextIndex] ?? "")) nextIndex += 1;
      if (source[nextIndex] === "}" || source[nextIndex] === "]") continue;
    }
    result += character;
  }

  return result;
};

const parseJsonc = (source, label) => {
  try {
    return JSON.parse(stripJsoncTrailingCommas(stripJsoncComments(source)));
  } catch (error) {
    throw new Error(
      `Could not parse ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const specimen = resolve(process.argv[2] || process.env.STUDIO_INTEGRATED_CWD || "");
if (!specimen || !existsSync(join(specimen, "package.json"))) {
  throw new Error(
    "Pass the integrated backend checkout produced by the cold-install test.",
  );
}

const nextHtmlPath = join(specimen, ".next/server/app/studio/workspace.html");
const assetHtmlPath = join(specimen, ".open-next/assets/studio/workspace.html");
const nextBuildIdPath = join(specimen, ".next/BUILD_ID");
const assetBuildIdPath = join(specimen, ".open-next/assets/BUILD_ID");
const memberWranglerPath = join(specimen, "wrangler.jsonc");

for (const path of [nextHtmlPath, assetHtmlPath, nextBuildIdPath, assetBuildIdPath, memberWranglerPath]) {
  assert(existsSync(path), `required production artifact is missing: ${path}`);
}

const memberWrangler = parseJsonc(readFileSync(memberWranglerPath, "utf8"), memberWranglerPath);
const memberAssets = memberWrangler?.assets;
assert(
  memberAssets && typeof memberAssets === "object" && !Array.isArray(memberAssets),
  "merged member Wrangler config has no Static Assets object",
);
assert.equal(
  memberAssets.directory,
  ".open-next/assets",
  "merged member Wrangler config points at a different Static Assets directory",
);
assert.equal(
  memberAssets.binding,
  "ASSETS",
  "merged member Wrangler config must preserve OpenNext's ASSETS binding",
);
assert.equal(
  memberAssets.run_worker_first,
  false,
  "merged member Wrangler config must use literal run_worker_first=false",
);
assert(
  memberAssets.html_handling === undefined || memberAssets.html_handling === "auto-trailing-slash",
  "merged member Wrangler config has incompatible Static Assets html_handling",
);

const nextHtml = readFileSync(nextHtmlPath);
const assetHtml = readFileSync(assetHtmlPath);
assert(nextHtml.length > 1_000, "workspace prerender is implausibly small");
assert(nextHtml.equals(assetHtml), "Cloudflare workspace asset is not byte-identical to this Next build");
assert.equal(
  readFileSync(nextBuildIdPath, "utf8").trim(),
  readFileSync(assetBuildIdPath, "utf8").trim(),
  "Next and OpenNext asset build IDs differ",
);

const htmlText = assetHtml.toString("utf8");
assert.match(htmlText, /<!DOCTYPE html>/i, "workspace asset is not a complete HTML document");
const staticReferences = new Map(
  [...htmlText.matchAll(/(?:href|src)=["'](\/_next\/static\/[^"'?#]+)(?:[?#][^"']*)?["']/g)]
    .map((match) => {
      const reference = match[1];
      const decodedReference = decodeURIComponent(reference);
      return [
        reference,
        join(specimen, ".open-next/assets", decodedReference.replace(/^\//, "")),
      ];
    }),
);
assert(staticReferences.size > 0, "workspace asset contains no generated Next static references");
for (const [reference, generatedPath] of staticReferences) {
  assert(
    existsSync(generatedPath),
    `workspace asset references a missing generated file: ${reference}`,
  );
}

const reservePort = () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : null;
    server.close((error) => {
      if (error) reject(error);
      else if (!port) reject(new Error("could not reserve a Wrangler proof port"));
      else resolvePort(port);
    });
  });
});

const proofScratch = mkdtempSync(join(tmpdir(), "studio-static-routing-proof-"));
const configPath = join(specimen, ".studio-static-routing-proof.wrangler.jsonc");
const workerPath = join(specimen, ".studio-static-routing-proof-worker.mjs");
const wranglerBin = join(specimen, "node_modules/.bin/wrangler");
assert(existsSync(wranglerBin), "cold-install specimen has no local Wrangler binary");

writeFileSync(
  workerPath,
  `export default {
  fetch() {
    return new Response("probe worker invoked", {
      headers: { "x-studio-worker-invoked": "1" },
    });
  },
};
`,
);
writeFileSync(
  configPath,
  JSON.stringify({
    name: "studio-static-routing-proof",
    main: ".studio-static-routing-proof-worker.mjs",
    compatibility_date: memberWrangler.compatibility_date ?? "2026-05-01",
    ...(Array.isArray(memberWrangler.compatibility_flags)
      ? { compatibility_flags: memberWrangler.compatibility_flags }
      : {}),
    // Exercise the exact semantically parsed Static Assets contract that the
    // controlled merge put in the member's real Wrangler configuration.
    assets: memberAssets,
  }, null, 2) + "\n",
);

let child;
let exited = false;
let output = "";
try {
  const port = await reservePort();
  child = spawn(
    wranglerBin,
    [
      "dev",
      "--config", configPath,
      "--local",
      "--ip", "127.0.0.1",
      "--port", String(port),
      "--persist-to", proofScratch,
      "--log-level", "error",
      "--show-interactive-dev-session=false",
    ],
    { cwd: specimen, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.once("exit", () => { exited = true; });
  child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-12_000); });
  child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-12_000); });

  const probeUrl = `http://127.0.0.1:${port}/__studio_worker_probe__`;
  let workerProbe = null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !workerProbe) {
    if (exited) throw new Error(`Wrangler exited before the routing proof was ready.\n${output}`);
    try {
      const response = await fetch(probeUrl, { redirect: "manual" });
      if (response.headers.get("x-studio-worker-invoked") === "1") workerProbe = response;
    } catch {
      // Wrangler is still starting.
    }
    if (!workerProbe) await delay(200);
  }
  assert(workerProbe, `Wrangler did not become ready for the routing proof.\n${output}`);

  const response = await fetch(`http://127.0.0.1:${port}/studio/workspace`, {
    redirect: "manual",
  });
  assert.equal(response.status, 200, "extensionless workspace path was not served directly as an asset");
  assert.equal(
    response.headers.get("x-studio-worker-invoked"),
    null,
    "workspace request invoked the Worker despite asset-first routing",
  );
  assert.equal(response.headers.get("x-opennext"), null, "workspace still came from OpenNext");
  assert(
    Buffer.from(await response.arrayBuffer()).equals(assetHtml),
    "Wrangler did not serve the materialized workspace bytes",
  );

  for (const [reference, generatedPath] of staticReferences) {
    const generatedResponse = await fetch(`http://127.0.0.1:${port}${reference}`, {
      redirect: "manual",
    });
    assert.equal(
      generatedResponse.status,
      200,
      `Wrangler did not serve the workspace's generated asset: ${reference}`,
    );
    assert.equal(
      generatedResponse.headers.get("x-studio-worker-invoked"),
      null,
      `Workspace generated asset fell through to the Worker: ${reference}`,
    );
    assert(
      Buffer.from(await generatedResponse.arrayBuffer()).equals(readFileSync(generatedPath)),
      `Wrangler served different bytes for the workspace's generated asset: ${reference}`,
    );
  }

  assert.equal(
    workerProbe.headers.get("x-studio-worker-invoked"),
    "1",
    "routing harness did not prove that non-assets reach the Worker",
  );

  console.log(JSON.stringify({
    ok: true,
    workspace_asset_bytes: assetHtml.length,
    generated_static_references: staticReferences.size,
    member_assets_binding: memberAssets.binding,
    member_html_handling: memberAssets.html_handling ?? "auto-trailing-slash (default)",
    run_worker_first: memberAssets.run_worker_first,
    worker_invocations_for_workspace: 0,
    generated_assets_served_directly: staticReferences.size,
    worker_fallback_probe: "passed",
  }, null, 2));
} finally {
  if (child && !exited) {
    child.kill("SIGTERM");
    const stoppedByDeadline = await Promise.race([
      new Promise((resolveStopped) => child.once("exit", () => resolveStopped(false))),
      delay(5_000).then(() => true),
    ]);
    if (stoppedByDeadline && !exited) child.kill("SIGKILL");
  }
  rmSync(configPath, { force: true });
  rmSync(workerPath, { force: true });
  rmSync(proofScratch, { recursive: true, force: true });
}
