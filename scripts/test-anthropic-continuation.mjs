#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const temp = mkdtempSync(join(tmpdir(), "studio-anthropic-continuation-test-"));
writeFileSync(
  join(temp, "worker-anthropic-capability.ts"),
  read("src/lib/studio/worker-anthropic-capability.ts"),
);
writeFileSync(
  join(temp, "anthropic-continuation.ts"),
  read("src/lib/studio/anthropic-continuation.ts")
    .replace('"@/lib/studio/worker-anthropic-capability"', '"./worker-anthropic-capability.ts"'),
);
const {
  AnthropicRequestError,
  runAnthropicWithPauseTurns,
  safeAnthropicRequestErrorPayload,
} = await import(pathToFileURL(join(temp, "anthropic-continuation.ts")).href);

const chatRoute = readFileSync(join(root, "src/app/api/studio/desks/[id]/chat/route.ts"), "utf8");

const estimateContinuationTokens = (content) => Math.ceil(JSON.stringify(content).length / 3) + 8;

const firstPause = [{ type: "server_tool_use", id: "tool-first", name: "web_search", input: { query: "one" } }];
const secondPause = [
  { type: "server_tool_use", id: "tool-second", name: "web_search", input: { query: "two" } },
  { type: "web_search_tool_result", tool_use_id: "tool-second", content: [{ type: "text", text: "result" }] },
];
const responses = [
  { content: firstPause, stop_reason: "pause_turn", usage: { input_tokens: 1_000, output_tokens: 50 } },
  { content: secondPause, stop_reason: "pause_turn", usage: { input_tokens: 1_200, output_tokens: 70 } },
  { content: [{ type: "text", text: "Research complete." }], stop_reason: "end_turn", usage: { input_tokens: 1_350, output_tokens: 10 } },
];
const requests = [];
const redirectModes = [];
const fetchImpl = async (_input, init) => {
  assert(init?.signal instanceof AbortSignal, "Anthropic request has no bounded abort signal");
  redirectModes.push(init?.redirect);
  requests.push(JSON.parse(String(init?.body ?? "{}")));
  const next = responses.shift();
  assert(next, "provider was called more than three times");
  return new Response(JSON.stringify(next), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const result = await runAnthropicWithPauseTurns({
  apiKey: "test-only",
  model: "claude-sonnet-4-6",
  system: "Use verified evidence.",
  messages: [{ role: "user", content: "Research this." }],
  tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
  maxOutputTokens: 4_000,
  maxContinuationRounds: 2,
  continuationReserveTokens: 16_000,
  inputCeilingTokens: 134_000,
  plannedInputTokens: 1_000,
  estimateContinuationTokens,
  fetchImpl,
});

assert.equal(requests.length, 3, "two pauses did not produce exactly two continuation calls");
// "manual", never "error": the Cloudflare Workers runtime throws a TypeError on
// redirect:"error", which took every deployed Worker model call down in 1.6.7.
assert.deepEqual(redirectModes, ["manual", "manual", "manual"], "a paid continuation could follow a redirect with x-api-key");
assert.deepEqual(requests[0].messages.map(({ role }) => role), ["user"]);
assert.deepEqual(requests[1].messages.map(({ role }) => role), ["user", "assistant"]);
assert.deepEqual(requests[1].messages[1].content, firstPause, "first paused state was not replayed verbatim");
assert.deepEqual(requests[2].messages.map(({ role }) => role), ["user", "assistant"]);
assert.deepEqual(requests[2].messages[1].content, secondPause, "second paused state did not replace the first");
assert.doesNotMatch(JSON.stringify(requests[2]), /tool-first/, "stale paused tool state leaked into the third request");
assert.equal(result.reply, "Research complete.");
assert.equal(
  result.continuationTokens,
  estimateContinuationTokens(firstPause) + estimateContinuationTokens(secondPause),
  "continuation spend accounting stopped covering every replay",
);

const baseFailureOptions = {
  apiKey: "test-only",
  model: "claude-sonnet-4-6",
  system: "Use verified evidence.",
  messages: [{ role: "user", content: "Test safe failure classification." }],
  maxOutputTokens: 100,
  maxContinuationRounds: 0,
  continuationReserveTokens: 0,
  inputCeilingTokens: 10_000,
  plannedInputTokens: 100,
  estimateContinuationTokens,
  timeoutMs: 1_000,
};

for (const [label, status, headers, expectedCode] of [
  ["forged-or-provider 401", 401, { "request-id": "PRIVATE-FORGED-ID", "cf-aig-request-id": "PRIVATE-AIG-ID" }, "worker_anthropic_unverified_rejection"],
  ["forged-or-provider 403", 403, { "request-id": "PRIVATE-FORGED-ID", "cf-aig-request-id": "PRIVATE-AIG-ID" }, "worker_anthropic_unverified_rejection"],
  ["gateway 403", 403, { "cf-aig-request-id": "PRIVATE-AIG-ID" }, "worker_anthropic_unverified_rejection"],
  ["unreceipted 401", 401, {}, "worker_anthropic_unverified_rejection"],
  ["unreceipted 400", 400, {}, "worker_anthropic_unverified_rejection"],
  ["unreceipted 404", 404, {}, "worker_anthropic_unverified_rejection"],
  ["unreceipted 413", 413, {}, "worker_anthropic_unverified_rejection"],
  ["forwarding then blocking 451", 451, { "cf-aig-request-id": "PRIVATE-AIG-ID" }, "worker_anthropic_unverified_rejection"],
  ["billing hint", 402, { "request-id": "PRIVATE-FORGED-ID" }, "worker_anthropic_unverified_rejection"],
  ["rate-limit hint", 429, { "request-id": "PRIVATE-FORGED-ID" }, "worker_anthropic_unverified_rejection"],
  ["provider unavailable", 529, {}, "worker_anthropic_unavailable"],
  ["unfollowed redirect", 307, { location: "https://example.invalid/never-followed" }, "worker_anthropic_unavailable"],
]) {
  await assert.rejects(
    runAnthropicWithPauseTurns({
      ...baseFailureOptions,
      fetchImpl: async (_input, init) => {
        assert(init?.signal instanceof AbortSignal, `${label} had no timeout signal`);
        return new Response("PRIVATE-UPSTREAM-ERROR-BODY", { status, headers });
      },
    }),
    (error) => error instanceof AnthropicRequestError
      && error.code === expectedCode
      && /spend-ambiguous/.test(error.message)
      && /did not retry it automatically/.test(error.message)
      && !/refresh|replace|rotate|reconnect/i.test(error.message)
      && !/PRIVATE|UPSTREAM-ERROR-BODY/.test(error.message),
    `${label} did not return its safe failure code`,
  );
}

for (const [label, error] of [
  ["network", new Error("PRIVATE-NETWORK-DETAIL")],
  ["timeout", new DOMException("PRIVATE-TIMEOUT-DETAIL", "TimeoutError")],
]) {
  await assert.rejects(
    runAnthropicWithPauseTurns({
      ...baseFailureOptions,
      fetchImpl: async () => { throw error; },
    }),
    (failure) => failure instanceof AnthropicRequestError
      && failure.code === "worker_anthropic_unavailable"
      && !/PRIVATE/.test(failure.message),
    `${label} failure leaked transport details`,
  );
}

let strippedSuccessInit;
const strippedSuccess = await runAnthropicWithPauseTurns({
  ...baseFailureOptions,
  fetchImpl: async (_input, init) => {
    strippedSuccessInit = init;
    return new Response(JSON.stringify({
      content: [{ type: "text", text: "HEADER-STRIPPED-SUCCESS" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 12, output_tokens: 3 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  },
});
assert.equal(strippedSuccess.reply, "HEADER-STRIPPED-SUCCESS");
assert.equal(strippedSuccessInit?.redirect, "manual");

for (const [status, messagePattern] of [
  [400, /permanently rejected this request as invalid \(HTTP 400\)/],
  [404, /could not find the configured Messages resource \(HTTP 404\)/],
  [413, /permanently rejected this request because its payload was too large \(HTTP 413\)/],
]) {
  await assert.rejects(
    runAnthropicWithPauseTurns({
      ...baseFailureOptions,
      fetchImpl: async (_input, init) => {
        assert.equal(init?.redirect, "manual");
        return new Response("PRIVATE-PERMANENT-BODY", {
          status,
          headers: { "request-id": "classification-only" },
        });
      },
    }),
    (error) => error instanceof AnthropicRequestError
      && error.code === "worker_anthropic_unavailable"
      && messagePattern.test(error.message)
      && !/temporar|retry|PRIVATE/.test(error.message),
    `receipted HTTP ${status} was not a sanitized permanent failure`,
  );
}

let streamedFailure;
try {
  await runAnthropicWithPauseTurns({
    ...baseFailureOptions,
    fetchImpl: async () => new Response("PRIVATE-NDJSON-UPSTREAM-BODY", {
      status: 403,
      headers: { "cf-aig-request-id": "PRIVATE-NDJSON-GATEWAY-ID" },
    }),
  });
  assert.fail("gateway failure unexpectedly completed");
} catch (error) {
  streamedFailure = error;
}
const ndjsonLine = JSON.stringify({
  type: "error",
  ...safeAnthropicRequestErrorPayload(streamedFailure),
}) + "\n";
assert.deepEqual(JSON.parse(ndjsonLine), {
  type: "error",
  error: "Anthropic returned a spend-ambiguous response after this paid request was submitted. Studio did not retry it automatically; ask your Builder to verify the direct Anthropic path before sending a new request.",
  code: "worker_anthropic_unverified_rejection",
});
assert.doesNotMatch(ndjsonLine, /PRIVATE|UPSTREAM-BODY|GATEWAY-ID/);
assert.match(chatRoute, /write\(\{ type: "error", \.\.\.safeAnthropicRequestErrorPayload\(e\) \}\)/,
  "desk NDJSON path bypasses the safe provider failure envelope");
assert.match(chatRoute, /NextResponse\.json\([\s\S]*safeAnthropicRequestErrorPayload\(e\)/,
  "desk JSON path bypasses the safe provider failure envelope");

rmSync(temp, { recursive: true, force: true });

console.log(JSON.stringify({
  ok: true,
  provider_calls: requests.length,
  third_request_assistant_messages: requests[2].messages.filter(({ role }) => role === "assistant").length,
  stale_pause_replayed: false,
  safe_failure_taxonomy: true,
  stripped_paid_success_accepted: true,
  request_id_authenticates_failure: false,
  bounded_fetch: true,
  ndjson_failure_sanitized: true,
}));
