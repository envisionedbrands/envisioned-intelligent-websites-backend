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
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const specimen = resolve(process.argv[2] || process.env.STUDIO_INTEGRATED_CWD || "");
if (!specimen || !existsSync(join(specimen, "package.json"))) {
  throw new Error("Pass the built integrated backend checkout produced by the cold-install test.");
}

const previewBin = join(specimen, "node_modules/.bin/opennextjs-cloudflare");
const nextHtmlPath = join(specimen, ".next/server/app/studio/workspace.html");
const assetHtmlPath = join(specimen, ".open-next/assets/studio/workspace.html");
for (const path of [previewBin, nextHtmlPath, assetHtmlPath, join(specimen, "wrangler.jsonc")]) {
  assert(existsSync(path), `OpenNext runtime proof prerequisite is missing: ${path}`);
}

const nextHtml = readFileSync(nextHtmlPath);
const assetHtml = readFileSync(assetHtmlPath);
assert(nextHtml.equals(assetHtml), "workspace Static Asset differs from the current Next prerender");

const reservePort = () => new Promise((resolvePort, reject) => {
  const server = createNetServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : null;
    server.close((error) => {
      if (error) reject(error);
      else if (!port) reject(new Error("could not reserve an OpenNext proof port"));
      else resolvePort(port);
    });
  });
});

const listenEphemeral = (server) => new Promise((resolvePort, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : null;
    if (!port) reject(new Error("could not start the deterministic auth stub"));
    else resolvePort(port);
  });
});

const fetchBounded = (url) => fetch(url, {
  redirect: "manual",
  signal: AbortSignal.timeout(5_000),
});

const proofScratch = mkdtempSync(join(tmpdir(), "studio-opennext-boundary-"));
const wranglerState = join(proofScratch, "wrangler-state");
const proofEnvPath = join(proofScratch, "runtime.env");
const authRequests = [];
const authServer = createHttpServer((request, response) => {
  authRequests.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
  response.writeHead(401, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify({ message: "No session in OpenNext boundary proof" }));
});

let authListening = false;
let child = null;
let childExited = false;
let childExit = Promise.resolve();
let output = "";

const processGroupAlive = () => {
  if (!child?.pid) return false;
  try {
    if (process.platform === "win32") return !childExited && child.exitCode === null;
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    // ESRCH: the group is gone. EPERM is a permission failure, not proof of
    // exit: fall back to the direct child's own state, which this test
    // observes exactly (exit event). Only other errors are real failures.
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return !childExited && child.exitCode === null;
    throw error;
  }
};

const signalProcessTree = (signal) => {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    // Cannot signal the group: signal the direct child, which we own.
    if (error?.code === "EPERM") { try { child.kill(signal); } catch (inner) { if (inner?.code !== "ESRCH") throw inner; } return; }
    throw error;
  }
};

const waitForProcessTreeExit = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (processGroupAlive() && Date.now() < deadline) await delay(50);
  return !processGroupAlive();
};

try {
  const authPort = await listenEphemeral(authServer);
  authListening = true;
  const authOrigin = `http://127.0.0.1:${authPort}`;
  const proofVars = {
    NEXT_PUBLIC_SUPABASE_URL: authOrigin,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "studio-runtime-proof-anon-key",
    SUPABASE_URL: authOrigin,
    SUPABASE_ANON_KEY: "studio-runtime-proof-anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "studio-runtime-proof-service-key",
    API_SECRET_KEY: "studio-runtime-proof-api-key",
  };
  writeFileSync(
    proofEnvPath,
    Object.entries(proofVars).map(([key, value]) => `${key}=${value}`).join("\n") + "\n",
    { mode: 0o600 },
  );

  const [previewPort, inspectorPort] = await Promise.all([reservePort(), reservePort()]);
  child = spawn(
    previewBin,
    [
      "preview",
      "--ip", "127.0.0.1",
      "--port", String(previewPort),
      "--inspector-ip", "127.0.0.1",
      "--inspector-port", String(inspectorPort),
      "--persist-to", wranglerState,
      "--env-file", proofEnvPath,
      "--log-level", "error",
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: specimen,
      detached: process.platform !== "win32",
      env: { ...process.env, ...proofVars },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  childExit = new Promise((resolveExit) => {
    child.once("error", (error) => {
      output = `${output}\nOpenNext preview spawn failed: ${error.message}`.slice(-20_000);
      childExited = true;
      resolveExit();
    });
    child.once("exit", (code, signal) => {
      output = `${output}\nOpenNext preview exited: code=${code} signal=${signal}`.slice(-20_000);
      childExited = true;
      resolveExit();
    });
  });
  child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-20_000); });
  child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-20_000); });

  const origin = `http://127.0.0.1:${previewPort}`;
  let apiReady = false;
  let lastProbe = "no response";
  const startupDeadline = Date.now() + 45_000;
  while (!apiReady && Date.now() < startupDeadline) {
    if (childExited) throw new Error(`OpenNext preview exited before becoming ready.\n${output}`);
    try {
      const response = await fetchBounded(`${origin}/api/studio/boards`);
      lastProbe = `HTTP ${response.status}`;
      await response.arrayBuffer();
      apiReady = response.status === 401;
    } catch (error) {
      lastProbe = error instanceof Error ? error.message : String(error);
    }
    if (!apiReady) await delay(200);
  }
  assert(apiReady, `OpenNext preview did not reach the unauthenticated API boundary (${lastProbe}).\n${output}`);

  const workspaceResponse = await fetchBounded(`${origin}/studio/workspace`);
  assert.equal(workspaceResponse.status, 200, "workspace did not resolve through the actual OpenNext preview");
  assert.equal(
    workspaceResponse.headers.get("x-opennext"),
    null,
    "workspace reached the OpenNext Worker instead of Cloudflare Static Assets",
  );
  assert(
    Buffer.from(await workspaceResponse.arrayBuffer()).equals(assetHtml),
    "actual OpenNext preview did not serve the byte-identical workspace Static Asset",
  );

  const studioResponse = await fetchBounded(`${origin}/studio`);
  assert.equal(studioResponse.status, 307, "logged-out /studio did not preserve the middleware auth redirect");
  const location = studioResponse.headers.get("location");
  assert(location, "logged-out /studio redirect omitted Location");
  const loginUrl = new URL(location, origin);
  assert.equal(loginUrl.origin, origin, "logged-out /studio redirected away from the member backend");
  assert.equal(loginUrl.pathname, "/login", "logged-out /studio did not redirect to /login");

  const boardsResponse = await fetchBounded(`${origin}/api/studio/boards`);
  assert.equal(boardsResponse.status, 401, "logged-out Studio boards API did not preserve its 401 boundary");
  const boardsBody = await boardsResponse.json().catch(() => null);
  assert(
    boardsBody && typeof boardsBody.error === "string",
    "logged-out Studio boards API did not return its structured auth error",
  );

  const workerAnthropicResponse = await fetchBounded(`${origin}/api/studio/runner/check-anthropic`);
  assert.equal(
    workerAnthropicResponse.status,
    401,
    "deployed Worker Anthropic proof accepted a browser or anonymous caller",
  );
  assert.match(
    workerAnthropicResponse.headers.get("cache-control") ?? "",
    /no-store/i,
    "deployed Worker Anthropic auth failure can be cached",
  );
  const workerAnthropicBody = await workerAnthropicResponse.json().catch(() => null);
  assert.deepEqual(workerAnthropicBody, { error: "Unauthorized" });

  console.log(JSON.stringify({
    ok: true,
    runtime: "actual opennextjs-cloudflare preview",
    workspace: {
      status: workspaceResponse.status,
      bytes: assetHtml.length,
      x_opennext: null,
      byte_identical: true,
    },
    logged_out_studio: { status: studioResponse.status, location: loginUrl.pathname },
    logged_out_boards_api: { status: boardsResponse.status },
    machine_only_worker_anthropic: {
      status: workerAnthropicResponse.status,
      cache_control: "no-store",
    },
    deterministic_auth_stub_requests: authRequests.length,
  }, null, 2));
} finally {
  if (child?.pid && processGroupAlive()) {
    signalProcessTree("SIGTERM");
    if (!(await waitForProcessTreeExit(5_000))) {
      signalProcessTree("SIGKILL");
      assert(await waitForProcessTreeExit(5_000), "OpenNext preview process tree survived SIGKILL");
    }
  }
  await Promise.race([childExit, delay(1_000)]);
  if (authListening) {
    authServer.closeAllConnections?.();
    await Promise.race([
      new Promise((resolveClose) => authServer.close(resolveClose)),
      delay(2_000),
    ]);
  }
  rmSync(proofScratch, { recursive: true, force: true });
}
