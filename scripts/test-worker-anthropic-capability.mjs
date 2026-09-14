#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyStudioAnthropicPaidResponse,
  classifyStudioWorkerAnthropicResponse,
  studioWorkerAnthropicHttpStatus,
  studioWorkerAnthropicProbe,
} from "../src/lib/studio/worker-anthropic-capability.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const route = readFileSync(join(root, "src/app/api/studio/runner/check-anthropic/route.ts"), "utf8");
const runner = readFileSync(join(root, "scripts/studio-runner.mjs"), "utf8");
const setup = readFileSync(join(root, "scripts/setup-studio-runner.sh"), "utf8");

const classified = (status, headers = {}) => classifyStudioWorkerAnthropicResponse(
  new Response([204, 205, 304].includes(status) ? null : "UNREAD-SENTINEL-UPSTREAM-BODY", { status, headers }),
);
const paid = (status, headers = {}) => classifyStudioAnthropicPaidResponse(
  new Response([204, 205, 304].includes(status) ? null : "UNREAD-SENTINEL-UPSTREAM-BODY", { status, headers }),
);

assert.deepEqual(
  studioWorkerAnthropicProbe("missing", { configured: false }),
  {
    status: "missing",
    code: "worker_anthropic_missing",
    configured: false,
    upstream_status: null,
    provider_request_id_present: false,
    intermediary_trace_present: false,
    transport: "direct_anthropic",
    probe: "authenticated_read_only_models_list",
  },
);

assert.deepEqual(
  classified(200, { "request-id": "provider-receipt-must-not-be-returned" }),
  studioWorkerAnthropicProbe("valid", {
    configured: true,
    upstreamStatus: 200,
    providerRequestIdPresent: true,
  }),
);
const unreceipted200 = classified(200);
assert.equal(unreceipted200.status, "unavailable");
assert.equal(unreceipted200.code, "worker_anthropic_unverified_response");
for (const status of [204, 206]) {
  const unexpectedSuccess = classified(status, { "request-id": "provider-receipt" });
  assert.equal(unexpectedSuccess.status, "unavailable", `HTTP ${status} falsely passed models proof`);
  assert.equal(unexpectedSuccess.code, "worker_anthropic_unverified_response");
}

const invalid401 = classified(401, {
  "request-id": "provider-receipt-must-not-be-returned",
  "cf-aig-request-id": "intermediary-trace-must-not-win",
});
assert.equal(invalid401.status, "invalid_provider_credential");
assert.equal(invalid401.code, "worker_anthropic_invalid_provider_credential");
assert.equal(invalid401.provider_request_id_present, true);
assert.equal(invalid401.intermediary_trace_present, true);
assert.doesNotMatch(JSON.stringify(invalid401), /provider-receipt|intermediary-trace/);

const denied403 = classified(403, {
  "request-id": "provider-receipt-must-not-be-returned",
  "cf-aig-log-id": "intermediary-trace-must-not-win",
});
assert.equal(denied403.status, "provider_permission_denied");
assert.equal(denied403.code, "worker_anthropic_provider_permission_denied");

for (const [label, status, headers, code] of [
  ["AI Gateway 401", 401, { "cf-aig-request-id": "hidden" }, "worker_anthropic_intermediary_policy_blocked"],
  ["AI Gateway 403", 403, { "cf-aig-trace-id": "hidden" }, "worker_anthropic_intermediary_policy_blocked"],
  ["unreceipted 401", 401, {}, "worker_anthropic_unverified_rejection"],
  ["unreceipted 403", 403, {}, "worker_anthropic_unverified_rejection"],
  ["proxy auth", 407, {}, "worker_anthropic_intermediary_policy_blocked"],
  ["policy unavailable", 451, {}, "worker_anthropic_intermediary_policy_blocked"],
]) {
  const result = classified(status, headers);
  assert.equal(result.status, "intermediary_policy_blocked", label);
  assert.equal(result.code, code, label);
}

assert.equal(classified(402, { "request-id": "hidden" }).status, "billing_required");
assert.equal(classified(402, { "cf-aig-request-id": "hidden" }).status, "intermediary_policy_blocked");
assert.equal(classified(402).code, "worker_anthropic_unverified_rejection");
assert.equal(classified(429, { "request-id": "hidden" }).status, "rate_limited");
assert.equal(classified(429, { "cf-aig-request-id": "hidden" }).status, "intermediary_policy_blocked");
assert.equal(classified(429).code, "worker_anthropic_unverified_rejection");
for (const status of [400, 408, 500, 504, 529]) {
  assert.equal(classified(status).status, "unavailable", `HTTP ${status}`);
}

const strippedPaidSuccess = paid(200);
assert.equal(strippedPaidSuccess.action, "accept");
assert.equal(strippedPaidSuccess.provider_request_id_present, false);
for (const [label, status, headers] of [
  ["stripped 401", 401, {}],
  ["stripped 403", 403, {}],
  ["forwarded then blocked", 451, { "cf-aig-request-id": "intermediary-only" }],
  ["forged request id", 401, { "request-id": "synthetic-not-authentication" }],
  ["transient provider failure", 529, { "request-id": "classification-only" }],
]) {
  assert.equal(paid(status, headers).action, "fail_closed_ambiguous", label);
}
for (const status of [400, 404, 413]) {
  assert.equal(
    paid(status, { "request-id": "classification-only" }).action,
    "fail_closed_permanent",
    `receipted HTTP ${status}`,
  );
  assert.equal(paid(status).action, "fail_closed_ambiguous", `stripped HTTP ${status}`);
}
assert.equal(studioWorkerAnthropicHttpStatus("valid"), 200);
assert.equal(studioWorkerAnthropicHttpStatus("intermediary_policy_blocked"), 502);
assert.equal(studioWorkerAnthropicHttpStatus("billing_required"), 503);

assert.match(route, /studioMachineAuth\(request\)/);
assert.match(route, /https:\/\/api\.anthropic\.com\/v1\/models\?limit=1/);
assert.match(route, /method: "GET"/);
assert.match(route, /cache: "no-store"/);
// The Workers runtime rejects redirect:"error" with a TypeError ("won't be
// implemented ... use manual"). Every deployed Anthropic fetch must use
// "manual" and let the classifiers fail an unfollowed 3xx closed.
assert.match(route, /redirect: "manual"/);
assert.doesNotMatch(route, /redirect: "error"/, "Worker proof uses a redirect mode the Workers runtime rejects");
const redirected = classified(307, { location: "https://example.invalid/never-followed" });
assert.equal(redirected.status, "unavailable", "an unfollowed 3xx must not pass the models proof");
assert.equal(paid(307, { location: "https://example.invalid/never-followed" }).action, "fail_closed_ambiguous",
  "an unfollowed 3xx on a paid call must fail closed");
{
  const { readdirSync, statSync } = await import("node:fs");
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(?:ts|tsx)$/.test(entry) && /redirect: ["']error["']/.test(readFileSync(full, "utf8"))) offenders.push(full.slice(root.length + 1));
    }
  };
  walk(join(root, "src"));
  assert.deepEqual(offenders, [], `deployed Worker code uses redirect:"error", which the Workers runtime throws on: ${offenders.join(", ")}`);
}
assert.match(route, /AbortSignal\.timeout\(ANTHROPIC_PROBE_TIMEOUT_MS\)/);
assert.match(route, /Cache-Control": "no-store"/);
assert.match(route, /Unauthorized[\s\S]*Cache-Control": "no-store"/);
assert.doesNotMatch(route, /gateway\.ai\.cloudflare\.com|\/v1\/messages|cf-aig-authorization/i);
assert.doesNotMatch(route, /upstream\.(?:text|json)\(/,
  "Worker proof reads an upstream body that must remain private");
assert.match(route, /await upstream\.body\?\.cancel\(\)/,
  "Worker proof leaves the unread provider response body open");
const authIndex = route.indexOf("studioMachineAuth(request)");
const missingIndex = route.indexOf("if (!apiKey)");
const fetchIndex = route.indexOf("await fetch(ANTHROPIC_MODELS_PROBE_URL");
assert(authIndex > -1 && missingIndex > authIndex && fetchIndex > missingIndex,
  "Worker proof can call Anthropic before machine auth and missing-secret gates complete");

assert.match(runner, /process\.argv\.includes\("--check-worker-anthropic"\)/);
assert.match(runner, /\/api\/studio\/runner\/check-anthropic/);
assert.match(runner, /worker_anthropic=\$\{workerAnthropic\.status\}/);
assert.match(runner, /probe\.code === "worker_anthropic_valid"/);
assert.match(runner, /provider_permission_denied[\s\S]*do not rotate the key automatically/i);
assert.match(runner, /intermediary_policy_blocked[\s\S]*key has not been marked invalid/);
assert.match(runner, /status === 404[\s\S]*Deploy the current Studio 1\.6\.7 backend first/);
assert(setup.indexOf("--check-pairing") < setup.indexOf("--check-worker-anthropic"));
assert(setup.indexOf("--check-worker-anthropic") < setup.indexOf('pip" install'),
  "setup mutates the toolchain before proving the deployed Worker Anthropic path");

console.log(JSON.stringify({
  ok: true,
  transport: "direct_anthropic",
  probe: "authenticated_read_only_models_list",
  request_id_is_classification_only: true,
  paid_success_requires_request_id: false,
  paid_failures_reset_spend: false,
  response_body_read: false,
  setup_gate: "worker and local paths proven separately before mutation",
}));
