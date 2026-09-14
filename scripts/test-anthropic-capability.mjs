#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  ANTHROPIC_MODELS_PROBE_URL,
  anthropicCapabilityFromResponse,
  anthropicCapabilityRemediation,
  anthropicMessageFailureAction,
  anthropicMessageFailureMessage,
  drainAnthropicGatedQueue,
  probeAnthropicCapability,
} from "./studio-anthropic-capability.mjs";

assert.equal(
  await probeAnthropicCapability({ apiKey: "", fetcher: async () => assert.fail("missing key must not call network") }),
  "missing",
);

for (const [statusCode, headers, expected] of [
  [200, { "request-id": "provider-receipt" }, "valid"],
  [200, {}, "unavailable"],
  [204, { "request-id": "provider-receipt" }, "unavailable"],
  [401, { "request-id": "provider-receipt", "cf-aig-request-id": "gateway-trace" }, "invalid_provider_credential"],
  [403, { "request-id": "provider-receipt", "cf-aig-request-id": "gateway-trace" }, "provider_permission_denied"],
  [401, { "cf-aig-request-id": "gateway-trace" }, "intermediary_policy_blocked"],
  [403, {}, "intermediary_policy_blocked"],
  [402, { "request-id": "provider-receipt" }, "billing_required"],
  [402, {}, "intermediary_policy_blocked"],
  [429, { "request-id": "provider-receipt" }, "rate_limited"],
  [429, {}, "intermediary_policy_blocked"],
  [503, {}, "unavailable"],
]) {
  let request;
  const result = await probeAnthropicCapability({
    apiKey: "test-only-key",
    fetcher: async (...args) => {
      request = args;
      return {
        ok: statusCode >= 200 && statusCode < 300,
        status: statusCode,
        headers: new Headers(headers),
      };
    },
  });
  assert.equal(result, expected, `HTTP ${statusCode}`);
  assert.equal(request[0], ANTHROPIC_MODELS_PROBE_URL);
  assert.equal(request[1].method, "GET");
  assert.equal(request[1].cache, "no-store");
  assert.equal(request[1].redirect, "error");
  assert.equal(request[1].headers["x-api-key"], "test-only-key");
  assert.doesNotMatch(request[0], /messages|complete|generate/i);
  assert.equal(request[1].body, undefined);
}

assert.equal(
  await probeAnthropicCapability({ apiKey: "test-only-key", fetcher: async () => { throw new Error("offline"); } }),
  "unavailable",
);
let cancelledBodies = 0;
assert.equal(
  await probeAnthropicCapability({
    apiKey: "test-only-key",
    fetcher: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "request-id": "provider-receipt" }),
      body: { cancel: async () => { cancelledBodies += 1; } },
    }),
  }),
  "valid",
);
assert.equal(cancelledBodies, 1, "local models proof left the unread provider body open");
assert.match(anthropicCapabilityRemediation("invalid_provider_credential"), /unauthenticated header/i);
assert.doesNotMatch(anthropicCapabilityRemediation("invalid_provider_credential"), /reconnect|rotate/i);
assert.match(anthropicCapabilityRemediation("provider_permission_denied"), /Do not rotate/i);
assert.match(anthropicCapabilityRemediation("billing_required"), /billing/i);
assert.match(anthropicCapabilityRemediation("intermediary_policy_blocked"), /has not been marked invalid/i);
assert.match(anthropicCapabilityRemediation("rate_limited"), /do not replace/i);
assert.match(anthropicCapabilityRemediation("unavailable"), /could not be verified/i);
assert.match(anthropicCapabilityRemediation("unavailable"), /do not replace the key/i);
assert.equal(anthropicCapabilityRemediation("valid"), null);

assert.equal(anthropicCapabilityFromResponse(new Response(null, {
  status: 401,
  headers: { "request-id": "provider-receipt", "cf-aig-request-id": "gateway-trace" },
})), "invalid_provider_credential");
assert.equal(anthropicCapabilityFromResponse(new Response(null, {
  status: 403,
  headers: { "request-id": "provider-receipt", "cf-aig-request-id": "gateway-trace" },
})), "provider_permission_denied");
assert.equal(anthropicCapabilityFromResponse(new Response(null, { status: 403 })), "intermediary_policy_blocked");
assert.equal(anthropicCapabilityFromResponse(new Response(null, { status: 503 })), "unavailable");

for (const [label, status, headers, capability] of [
  ["classification-hint 401", 401, { "request-id": "forged-or-provider" }, "invalid_provider_credential"],
  ["classification-hint 403", 403, { "request-id": "forged-or-provider" }, "provider_permission_denied"],
  ["classification-hint 402", 402, { "request-id": "forged-or-provider" }, "billing_required"],
  ["classification-hint 429", 429, { "request-id": "forged-or-provider" }, "rate_limited"],
  ["gateway rejection", 403, { "cf-aig-request-id": "gateway-trace" }, "intermediary_policy_blocked"],
  ["stripped 401", 401, {}, "intermediary_policy_blocked"],
  ["stripped 407", 407, {}, "intermediary_policy_blocked"],
]) {
  assert.deepEqual(
    anthropicMessageFailureAction(new Response(null, { status, headers })),
    { capability, action: "fail_closed_ambiguous", status },
    `${label} could reset a spend-ambiguous HOUSE job`,
  );
}
for (const status of [500, 504, 529]) {
  assert.deepEqual(
    anthropicMessageFailureAction(new Response(null, { status, headers: { "request-id": "provider-receipt" } })),
    { capability: "unavailable", action: "fail_closed_ambiguous", status },
    `HTTP ${status} could repeat an ambiguous paid request`,
  );
}
for (const status of [400, 404, 413]) {
  const permanent = anthropicMessageFailureAction(new Response(null, {
    status,
    headers: { "request-id": "classification-only" },
  }));
  assert.deepEqual(permanent, { capability: "unavailable", action: "fail_closed_permanent", status });
  assert.match(anthropicMessageFailureMessage(permanent), new RegExp(`HTTP ${status}`));
  assert.doesNotMatch(anthropicMessageFailureMessage(permanent), /temporar|retry/i);
  assert.equal(
    anthropicMessageFailureAction(new Response(null, { status })).action,
    "fail_closed_ambiguous",
    `unreceipted HTTP ${status} was trusted as permanent`,
  );
}

// Model a forwarding intermediary that lets the paid request reach Anthropic,
// then replaces the response with an unreceipted policy rejection. The failure
// can stop this lane pass, but it cannot reset the durable paid-work boundary.
const runtimeCapability = "valid";
let claims = 0;
let paidCalls = 0;
let spendState = "in_flight";
const drain = () => drainAnthropicGatedQueue({
  getCapability: () => runtimeCapability,
  claim: async () => ({ id: `job-${++claims}` }),
  process: async () => {
    paidCalls += 1;
    const blocked = anthropicMessageFailureAction(new Response(null, { status: 403 }));
    if (blocked.action === "defer_unspent") spendState = "not_started";
    return "deferred";
  },
});
assert.equal(await drain(), "deferred");
assert.equal(claims, 1, "the spend-ambiguous pass claimed more than one HOUSE carousel");
assert.equal(paidCalls, 1, "the forwarding-then-blocking simulation submitted twice");
assert.equal(spendState, "in_flight", "an unreceipted paid failure reset the spend ledger");

console.log(JSON.stringify({
  ok: true,
  probe: "authenticated read-only models list",
  statuses: [
    "missing",
    "valid",
    "invalid_provider_credential",
    "provider_permission_denied",
    "billing_required",
    "intermediary_policy_blocked",
    "rate_limited",
    "unavailable",
  ],
  paid_failure: "one claim maximum, spend remains in_flight, lane deferred",
}));
