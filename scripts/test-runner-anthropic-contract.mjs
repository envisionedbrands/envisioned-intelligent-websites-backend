#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const runner = read("scripts/studio-runner.mjs");
const setup = read("scripts/setup-studio-runner.sh");
const helper = read("scripts/configure-studio-runner-secret.sh");
const health = read("src/app/api/studio/runner/health/route.ts");

assert.match(runner, /probeAnthropicCapability/);
assert.match(runner, /anthropic_configured: Boolean\(ANTHROPIC_KEY\)/);
assert.match(runner, /anthropic_status: anthropicCapability/);
assert.match(runner, /process\.argv\.includes\("--check-anthropic"\)/);
assert.match(runner, /anthropic=\$\{anthropicCapability\}/);
assert.match(runner, /anthropicMessageFailureAction\(res\)/);
assert.match(runner, /class AnthropicMessageFailureError/);
assert.match(runner, /anthropicCapabilityCheckedAt = 0/);
assert.doesNotMatch(runner, /anthropicCapability = messageCapability/,
  "a paid response rewrites the zero-cost capability classification");
assert.match(runner, /capability_deferred: e\.capability/);
assert.match(runner, /AnthropicCapabilityDeferredError/);
assert.match(runner, /e instanceof AnthropicMessageFailureError \? "deferred" : "complete"/);

const paidAnthropicPosts = runner.match(/boundedFetch\(["']https:\/\/api\.anthropic\.com\/v1\/messages[\s\S]*?\}, MODEL_TIMEOUT_MS/g) ?? [];
assert.equal(paidAnthropicPosts.length, 4, "runner Anthropic POST inventory changed without updating the redirect gate");
for (const block of paidAnthropicPosts) {
  assert.match(block, /redirect: ["']error["']/,
    "a runner Anthropic POST can forward x-api-key through a redirect");
}

const drainStart = runner.indexOf("async function drainCarouselJobs()");
const drainEnd = runner.indexOf("// ── Passes", drainStart);
const drain = runner.slice(drainStart, drainEnd);
assert(drain.indexOf("refreshAnthropicCapability") > -1);
assert(drain.indexOf('capability !== "valid"') > drain.indexOf("refreshAnthropicCapability"));
assert(drain.indexOf('capability !== "valid"') < drain.indexOf('/api/studio/carousel-jobs/claim'),
  "carousel jobs can be claimed before Anthropic capability is valid");
assert.match(drain, /return "deferred"/);
assert.match(drain, /drainAnthropicGatedQueue/);

const checkStart = runner.indexOf("if (checkMode)");
const checkEnd = runner.indexOf("runnerLock =", checkStart);
const check = runner.slice(checkStart, checkEnd);
assert(check.indexOf('anthropicCapability !== "valid"') > -1);
assert(check.indexOf('anthropicCapability !== "valid"') < check.indexOf("runner check passed"),
  "full runner check can claim success before rejecting Anthropic capability");

assert.match(setup, /configure-studio-runner-secret\.sh ANTHROPIC_API_KEY/);
assert(setup.indexOf("--check-pairing") < setup.indexOf("--check-anthropic"));
assert(setup.indexOf("--check-pairing") < setup.indexOf("--check-worker-anthropic"));
assert(setup.indexOf("--check-worker-anthropic") < setup.indexOf("--check-anthropic"));
assert(setup.indexOf("--check-pairing") < setup.indexOf("--check-carousel"));
assert(setup.indexOf("--check-carousel") < setup.indexOf('pip" install'),
  "missing Chrome, fonts, images, or signed templates are discovered only after local tool mutation");
assert(setup.indexOf("--check-anthropic") < setup.indexOf('pip" install'),
  "invalid Anthropic credentials are discovered only after local tool mutation");
assert.match(helper, /ANTHROPIC_API_KEY\|FAL_KEY\|OPENAI_API_KEY/);
assert.doesNotMatch(setup, /read -r(?: -s)? .*ANTHROPIC/,
  "setup shell collects the secret instead of the consent-aware masked helper");

assert.match(health, /STUDIO_ANTHROPIC_CAPABILITY_STATUSES/);
assert.match(health, /anthropic_configured/);
assert.match(health, /anthropic_status/);
assert.match(health, /anthropicStatus !== "missing"/);

for (const status of [
  "invalid_provider_credential",
  "provider_permission_denied",
  "billing_required",
  "intermediary_policy_blocked",
  "rate_limited",
  "unavailable",
]) {
  assert.match(runner, new RegExp(status), `runner omits Anthropic state ${status}`);
  assert.match(health, new RegExp("STUDIO_ANTHROPIC_CAPABILITY_STATUSES"),
    `health route does not validate ${status}`);
}

console.log(JSON.stringify({
  ok: true,
  setup: "pairing then separate deployed-Worker and local read-only Anthropic proofs before mutation",
  daemon: "lane-scoped deferral before claim",
  health: "safe capability taxonomy",
}));
