#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLegacyFactoryCarouselReport,
  classifyStudioCarouselRecovery,
  countStudioCarouselCheckpointWords,
  normalizeStudioCarouselSourceTitle,
  sameStudioCarouselJsonValue,
  STUDIO_CAROUSEL_CONTACT_SHEET_RECEIPT,
  STUDIO_CAROUSEL_MAX_CLOSER_WORDS,
  STUDIO_CAROUSEL_MAX_COVER_WORDS,
  STUDIO_CAROUSEL_MAX_SLIDE_WORDS,
  STUDIO_CAROUSEL_MAX_UNBROKEN_CHARS,
  STUDIO_CAROUSEL_SOURCE_TITLE_MAX_CODE_POINTS,
  validateStudioCarouselCheckpoint,
  validateStudioCarouselReadyEvidence,
} from "../src/lib/studio/carousel-execution.ts";
import { countStudioCarouselWords } from "./studio-carousel-contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const claim = read("src/app/api/studio/carousel-jobs/claim/route.ts");
const report = read("src/app/api/studio/carousel-jobs/[id]/route.ts");
const outputs = read("src/app/api/studio/outputs/route.ts");
const board = read("src/components/studio/studio-board.tsx");
const runner = read("scripts/studio-runner.mjs");
const renderer = read("scripts/studio-carousel-contract.mjs");
const migration = read("supabase/migrations/20260901010000_studio_carousel_execution_hardening.sql");
const schemaContractTest = read("supabase/tests/studio_167_schema_contract.sql");

const expected = {
  house_look: "cobalt",
  template_id: "house-cobalt-v1",
  template_version: "1",
};
const words = (count) => Array.from({ length: count }, (_, index) => `word${index + 1}`).join(" ");
const checkpoint = {
  contract_version: "studio_carousel_render_v1",
  house_look: "cobalt",
  template_id: "house-cobalt-v1",
  template_version: "1",
  slides: Array.from({ length: 10 }, (_, index) => ({
    layout: index === 0 ? "cover" : index === 9 ? "closer" : "body",
    text: index === 0
      ? words(STUDIO_CAROUSEL_MAX_COVER_WORDS)
      : index === 9
        ? words(STUDIO_CAROUSEL_MAX_CLOSER_WORDS)
        : words(STUDIO_CAROUSEL_MAX_SLIDE_WORDS),
  })),
  caption: "A safe caption",
};
assert.equal(validateStudioCarouselCheckpoint(checkpoint, expected).ok, true);
assert.equal(validateStudioCarouselCheckpoint({
  ...checkpoint,
  slides: checkpoint.slides.map((slide, index) => index === 0 ? { ...slide, text: words(13) } : slide),
}, expected).ok, false, "a stale checkpoint bypassed the 12-word cover fit boundary");
assert.equal(validateStudioCarouselCheckpoint({
  ...checkpoint,
  slides: checkpoint.slides.map((slide, index) => index === 5 ? { ...slide, text: words(29) } : slide),
}, expected).ok, false, "a stale checkpoint bypassed the 28-word slide fit boundary");
assert.equal(countStudioCarouselCheckpointWords("界".repeat(28)), 28);
assert.equal(countStudioCarouselCheckpointWords("😀".repeat(28)), 28);
assert.equal(validateStudioCarouselCheckpoint({
  ...checkpoint,
  slides: checkpoint.slides.map((slide, index) => index === 4 ? { ...slide, text: "界".repeat(29) } : slide),
}, expected).ok, false, "a CJK-dense checkpoint bypassed the 28-word boundary");
assert.equal(validateStudioCarouselCheckpoint({
  ...checkpoint,
  slides: checkpoint.slides.map((slide, index) => index === 8 ? { ...slide, text: "😀".repeat(29) } : slide),
}, expected).ok, false, "an emoji-dense checkpoint bypassed the 28-word boundary");
assert.equal(validateStudioCarouselCheckpoint({
  ...checkpoint,
  slides: checkpoint.slides.map((slide, index) => index === 9 ? { ...slide, text: words(21) } : slide),
}, expected).ok, false, "a stale checkpoint bypassed the 20-word closer boundary");
assert.equal(validateStudioCarouselCheckpoint({
  ...checkpoint,
  slides: checkpoint.slides.map((slide, index) => index === 5 ? { ...slide, text: "x".repeat(25) } : slide),
}, expected).ok, false, "a stale checkpoint bypassed the 24-character token boundary");

// A jsonb read may return every object level in a different key order. A lost
// checkpoint ACK must still be recognized immediately, while changed values
// and array order remain immutable.
const jsonbRoundTrip = {
  caption: checkpoint.caption,
  slides: checkpoint.slides.map((slide) => ({ text: slide.text, layout: slide.layout })),
  template_version: checkpoint.template_version,
  template_id: checkpoint.template_id,
  house_look: checkpoint.house_look,
  contract_version: checkpoint.contract_version,
};
assert.notEqual(JSON.stringify(checkpoint), JSON.stringify(jsonbRoundTrip),
  "fixture did not reproduce jsonb key reordering");
assert.equal(sameStudioCarouselJsonValue(checkpoint, jsonbRoundTrip), true,
  "jsonb key reordering turned a lost checkpoint ACK into a lease stall");
assert.equal(sameStudioCarouselJsonValue(checkpoint, {
  ...jsonbRoundTrip,
  slides: jsonbRoundTrip.slides.map((slide, index) => index === 4
    ? { text: `${slide.text} changed`, layout: slide.layout }
    : slide),
}), false, "a changed nested checkpoint value replayed as immutable");
assert.equal(sameStudioCarouselJsonValue({ values: [1, 2] }, { values: [2, 1] }), false,
  "array order stopped being part of the checkpoint receipt");

assert.equal(STUDIO_CAROUSEL_SOURCE_TITLE_MAX_CODE_POINTS, 289);
assert.deepEqual(normalizeStudioCarouselSourceTitle("a".repeat(289)), {
  ok: true,
  title: "a".repeat(289),
});
assert.deepEqual(normalizeStudioCarouselSourceTitle("😀".repeat(289)), {
  ok: true,
  title: "😀".repeat(289),
}, "source_title is bounded by PostgreSQL characters, not UTF-16 code units");
assert.deepEqual(normalizeStudioCarouselSourceTitle("a".repeat(290)), {
  ok: false,
  issue: "source_title_too_long",
  maxCodePoints: 289,
});
assert.deepEqual(normalizeStudioCarouselSourceTitle("   "), { ok: true, title: null });

assert.equal(countStudioCarouselCheckpointWords("A界界界"), 4);
assert.equal(countStudioCarouselWords("A界界界"), 4);
assert.equal(countStudioCarouselCheckpointWords("안녕하세요 세계"), 2);
assert.equal(countStudioCarouselWords("안녕하세요 세계"), 2);
for (const sample of ["界".repeat(28), "😀".repeat(28), "don't stop", "１２ three"]) {
  assert.equal(countStudioCarouselCheckpointWords(sample), countStudioCarouselWords(sample),
    `TypeScript/renderer word-count parity drifted for ${sample}`);
}

assert.equal(classifyStudioCarouselRecovery({
  leaseExpired: false, modelSpendState: "in_flight", structuredPayload: null,
}), "not_stale");
assert.equal(classifyStudioCarouselRecovery({
  leaseExpired: true, modelSpendState: "not_started", structuredPayload: null,
}), "safe_pre_spend");
assert.equal(classifyStudioCarouselRecovery({
  leaseExpired: true, modelSpendState: "checkpointed", structuredPayload: checkpoint,
}), "safe_checkpoint");
assert.equal(classifyStudioCarouselRecovery({
  leaseExpired: true, modelSpendState: "in_flight", structuredPayload: null,
}), "ambiguous_spend");

const legacyFactoryJob = {
  post_id: "factory-post",
  result: {
    slide_urls: ["https://factory.example/01.png"],
    slide_total: 1,
  },
};
assert.deepEqual(
  buildLegacyFactoryCarouselReport(legacyFactoryJob, { stage: "Rendering slide 4", progress: 40 }, "fixed"),
  {
    ok: true,
    update: { stage: "Rendering slide 4", progress: 40 },
    readyPostId: null,
  },
  "legacy FACTORY progress unexpectedly requires HOUSE lease/config evidence",
);
const legacyFactoryReady = buildLegacyFactoryCarouselReport(legacyFactoryJob, {
  status: "ready",
  result: {
    contact_sheet_url: "https://factory.example/contact.png",
    slide_urls: Array.from({ length: 10 }, (_, index) => `https://factory.example/${index + 1}.png`),
    slide_total: 10,
  },
}, "fixed");
assert.equal(legacyFactoryReady.ok, true);
if (!legacyFactoryReady.ok) throw new Error(legacyFactoryReady.issue);
assert.equal(legacyFactoryReady.readyPostId, "factory-post");
assert.equal(legacyFactoryReady.update.status, "ready");
assert.equal(legacyFactoryReady.update.stage, "Ready for review on the board");
assert.equal(legacyFactoryReady.update.progress, 100);
assert.equal(legacyFactoryReady.update.result.config_receipt, undefined,
  "legacy FACTORY ready unexpectedly requires a queue-time config receipt");
assert.equal(legacyFactoryReady.update.result.contact_sheet_receipt, undefined,
  "legacy FACTORY ready was silently upgraded to HOUSE-only evidence");

const slideUrls = Array.from({ length: 10 }, (_, index) => `https://media.example/${index + 1}.png`);
const media = slideUrls.map((url, position) => ({ position, kind: "image", url }));
const ready = {
  result: {
    contact_sheet_url: "https://media.example/contact.png",
    contact_sheet_receipt: STUDIO_CAROUSEL_CONTACT_SHEET_RECEIPT,
    slide_urls: slideUrls,
    slide_total: 10,
  },
  post: { id: "post", status: "draft", post_type: "carousel" },
  media,
};
assert.deepEqual(validateStudioCarouselReadyEvidence(ready), { ok: true });
assert.equal(validateStudioCarouselReadyEvidence({ ...ready, media: media.slice(0, 9) }).ok, false);
assert.equal(validateStudioCarouselReadyEvidence({
  ...ready,
  result: { ...ready.result, contact_sheet_receipt: { ...STUDIO_CAROUSEL_CONTACT_SHEET_RECEIPT, numbered: false } },
}).ok, false);
assert.equal(validateStudioCarouselReadyEvidence({
  ...ready,
  post: { id: "post", status: "scheduled", post_type: "carousel" },
}).ok, false);

// Claim/recovery is lease-CAS, and ambiguous paid work is never reclaimed.
assert.match(claim, /crypto\.randomUUID\(\)/);
assert.match(claim, /\.eq\("claim_token", job\.claim_token\)/);
assert.match(claim, /\.eq\("lease_expires_at", job\.lease_expires_at\)/);
assert.match(claim, /\.eq\("model_spend_state", "in_flight"\)[\s\S]*failAmbiguousSpend/);
assert.match(claim, /\.in\("model_spend_state", \["not_started", "checkpointed"\]\)/);
assert.match(claim, /validateStudioCarouselCheckpoint\(stale\.structured_payload/);
const invalidCheckpointStart = claim.indexOf("if (!checkpoint.ok)");
const invalidCheckpointEnd = claim.indexOf("\n      const claimToken", invalidCheckpointStart);
const invalidCheckpointBranch = claim.slice(invalidCheckpointStart, invalidCheckpointEnd);
assert(invalidCheckpointStart > -1 && invalidCheckpointEnd > invalidCheckpointStart,
  "invalid-checkpoint recovery branch is missing");
assert.match(invalidCheckpointBranch, /queueInvalidCheckpointCleanup/);
assert.doesNotMatch(invalidCheckpointBranch, /failAmbiguousSpend/,
  "an invalid checkpoint still terminalizes before artifact cleanup");
assert.match(claim, /queueInvalidCheckpointCleanup[\s\S]*crypto\.randomUUID\(\)[\s\S]*status: "cleanup_pending"/);
assert.match(claim, /status: "cleanup_pending"[\s\S]*cleanup_attempts: 0[\s\S]*cleanup_last_error: null[\s\S]*cleanup_retry_at: null/);
assert.match(claim, /x-studio-carousel-protocol/);
assert.match(claim, /STUDIO_CAROUSEL_RUNNER_PROTOCOL/);
assert.match(claim, /capabilities\?\.carousel_ready !== true/);

// Machine updates compare observed status plus ownership, while FACTORY keeps
// its compatibility path without being forced into the local lease protocol.
assert.match(report, /const houseExecution = job\.executor === "employee"/);
assert.match(report, /if \(!houseExecution\)[\s\S]*buildLegacyFactoryCarouselReport/);
assert(
  report.indexOf("if (!houseExecution)") < report.indexOf("validateCarouselConfigReceipt(existingReceipt)"),
  "legacy FACTORY reaches the 1.6.7 HOUSE config-receipt gate",
);
assert.match(report, /if \(houseExecution\)[\s\S]*\.eq\("claim_token", body\.claim_token\)[\s\S]*\.gt\("lease_expires_at"/);
assert.match(report, /\.eq\("status", job\.status\)/);
assert.match(report, /human_decision_stands/);
assert.match(report, /sameStudioCarouselJsonValue\(job\.structured_payload, checkpoint\.checkpoint\)/);
assert.doesNotMatch(report, /JSON\.stringify\(job\.structured_payload\)/,
  "checkpoint replay still depends on jsonb object key order");
assert.match(report, /validateStudioCarouselReadyEvidence/);
assert.match(report, /\.from\("social_post_media"\)[\s\S]*\.select\("position,kind,url"\)/);
assert.doesNotMatch(report, /if \(!body\.claim_token[\s\S]{0,80}return/, "FACTORY reports are unconditionally lease-gated");
assert.match(report, /\["not_started", "in_flight"\]\.includes\(job\.model_spend_state\)/,
  "same-token in-flight response-loss replay is not accepted");
assert.match(
  report,
  /capability_deferred[\s\S]*pre_submit_defer_count[\s\S]*update\.status = deferCount >= 3 \? "failed" : "queued"[\s\S]*update\.model_spend_state = "not_started"/,
  "a locally known pre-send Anthropic deferral is not safely returned or bounded",
);
assert.match(report, /houseExecution && body\.status === "failed"[\s\S]*studio_carousel_cleanup_required/,
  "a HOUSE report can terminalize before durable cleanup is confirmed");

// The paid request is bracketed by in-flight then durable checkpoint reports;
// a recovered checkpoint path occurs before (and excludes) claudeJson.
const checkpointBranch = runner.indexOf('job.model_spend_state === "checkpointed"');
const inFlightReport = runner.indexOf('model_spend_state: "in_flight"', checkpointBranch);
const modelCall = runner.indexOf("withCarouselLeaseHeartbeat", inFlightReport);
const checkpointReport = runner.indexOf('model_spend_state: "checkpointed"', modelCall);
const renderLoop = runner.indexOf("for (let i = 0; i < slides.length; i++)", checkpointReport);
assert(checkpointBranch > -1 && inFlightReport > checkpointBranch && modelCall > inFlightReport
  && checkpointReport > modelCall && renderLoop > checkpointReport,
  "model spend/checkpoint/render order is not durable");
assert.match(runner, /class AnthropicMessageFailureError[\s\S]*anthropicCapabilityCheckedAt = 0/,
  "paid Anthropic failure does not force the next pass through a fresh zero-cost probe");
assert.match(runner, /AnthropicMessageFailureError[\s\S]*cleanupUncommittedCarouselDraft[\s\S]*return "deferred"/,
  "a paid Anthropic failure can continue claiming after its current job fails closed");
const paidFailureStart = runner.indexOf("if (!res.ok)", runner.indexOf("async function claudeJson"));
const paidFailureEnd = runner.indexOf("let json", paidFailureStart);
assert.doesNotMatch(runner.slice(paidFailureStart, paidFailureEnd), /AnthropicCapabilityDeferredError|anthropicCapability\s*=/,
  "a post-send Anthropic failure can reset the paid job or demote cached probe state");
assert.match(runner, /CAROUSEL_LEASE_HEARTBEAT_MS = 30_000/);
assert.match(runner, /studio_materialize_carousel_draft/);
assert.doesNotMatch(runner, /supabase\.from\("social_posts"\)\.upsert/,
  "runner bypasses the lease-fenced materialization transaction");
assert.doesNotMatch(runner, /supabase\.from\("social_post_media"\)\.(?:delete|insert)/,
  "runner can interleave media writes across carousel leases");
assert.match(runner, /CAROUSEL_RUNNER_PROTOCOL = "studio_carousel_execution_167_v1"/);
assert.match(runner, /proveStudioCarouselFitReady\(\{[\s\S]*label: contactSheet \? "Studio carousel contact-sheet capture" : "Studio carousel production capture"/,
  "production capture bypasses the shared bounded three-attempt fit proof");
assert.match(runner, /contactSheet\s*\? studioCarouselContactSheetProbeScript\(\)[\s\S]*Studio carousel contact-sheet capture/,
  "production contact sheet bypasses its shared decoded 2x5 DOM proof");
assert.match(runner, /captureCarouselHtml\(chrome, contactHtml, contactPng, 1200, 3600, null, true, signal\)/,
  "contact-sheet screenshot is not routed through the trusted contact proof");
assert.match(runner, /captureCarouselHtml\([\s\S]*runChrome:[\s\S]*\{ \.\.\.options, signal \}[\s\S]*timeout: 60_000, env: safeChildEnv\(\), signal/,
  "Chrome work is not abortable at the lease-loss boundary");
assert.match(runner, /uploadCarouselPng\(storagePath, pngFile, signal\)[\s\S]*carouselSupabase\(signal\)[\s\S]*signal,/,
  "storage uploads are not abortable at the lease-loss boundary");
assert.match(runner, /carouselDatabaseMutation\([\s\S]*carouselSupabase\(signal\)\.rpc\("studio_materialize_carousel_draft"[\s\S]*signal,/,
  "materialization is not abortable at the lease-loss boundary");
assert.match(runner, /CAROUSEL_PROTOCOL_HEADERS/);

// Every outcome-uncertain boundary exits to lease recovery before the generic
// failed transition. These four assertions cover the paid checkpoint, the
// deterministic post checkpoint, media materialization, and final-ready ACK.
assert.match(runner, /model_spend_state: "checkpointed"[\s\S]{0,500}\{ durable: true \}/);
assert.match(runner, /carouselDatabaseMutation\(\s*"lease-fenced draft and media materialization"[\s\S]*studio_materialize_carousel_draft/);
assert.match(migration, /studio_materialize_carousel_draft[\s\S]*from public\.carousel_jobs job[\s\S]*for update[\s\S]*lease_expires_at <= now\(\)[\s\S]*delete from public\.social_post_media[\s\S]*insert into public\.social_post_media/,
  "post/media convergence is not one lease-fenced database transaction");
assert.match(migration, /materialization_receipt[\s\S]*studio_carousel_materialization_v1[\s\S]*content_checksum/,
  "materialization has no durable checksum/revision receipt");
assert.match(migration, /studio_materialize_carousel_draft[\s\S]*v_current_checksum[\s\S]*preserved_conflict[\s\S]*materialization_receipt = v_new_receipt/,
  "response-loss replay can overwrite a member-edited draft/media set");
assert.match(migration, /v_post\.id is null[\s\S]*v_job\.materialization_receipt is not null[\s\S]*status = 'cleanup_pending'[\s\S]*claim_token = p_claim_token/,
  "response-loss replay can resurrect a member-deleted draft or orphan its deterministic storage");
assert.match(runner, /status: "ready"[\s\S]{0,500}\{ terminal: true \}/);
const unknownCatch = runner.indexOf("e instanceof CarouselExecutionOutcomeUnknownError");
const cleanupBeforeFailure = runner.indexOf("const cleanup = await cleanupUncommittedCarouselDraft(job", unknownCatch);
assert(unknownCatch > -1 && cleanupBeforeFailure > unknownCatch,
  "response-loss can fall through to destructive cleanup");
const carouselProcess = runner.slice(
  runner.indexOf("async function processCarouselJob"),
  runner.indexOf("async function drainCarouselCleanupJobs"),
);
assert.doesNotMatch(carouselProcess, /status: "failed"/,
  "runner can terminalize before durable cleanup completion");
assert.match(runner, /if \(!cleanup\)[\s\S]*return "deferred";/,
  "cleanup failure is not durably retried through cleanup_pending");
assert.match(runner, /cleanupUncommittedCarouselDraft[\s\S]*studio_cleanup_carousel_draft/);
assert.match(runner, /drainCarouselCleanupJobs[\s\S]*status", "cleanup_pending"/);
assert.match(runner, /studio_complete_carousel_cleanup/);
assert.match(runner, /storage\.from\("images"\)\.remove\(storagePaths\)/);

// Fit numbers are an explicit parity contract with the executable renderer.
assert.equal(STUDIO_CAROUSEL_MAX_COVER_WORDS, 12);
assert.equal(STUDIO_CAROUSEL_MAX_SLIDE_WORDS, 28);
assert.equal(STUDIO_CAROUSEL_MAX_CLOSER_WORDS, 20);
assert.equal(STUDIO_CAROUSEL_MAX_UNBROKEN_CHARS, 24);
assert.match(renderer, /max 12 words/i);
assert.match(renderer, /max 28 words/i);
assert.match(renderer, /closer: 20/);
assert.match(renderer, /MAX_UNBROKEN_CHARS = 24/);

// Human decisions carry a stable operation id to a row-locked transactional
// RPC; no route-local split post/job update remains.
assert.match(board, /carouselDecisionOperationIds/);
assert.match(board, /decision_operation_id: decisionOperationId/);
assert.match(outputs, /decideStudioCarousel\(supabase/);
const sourceTitleGate = outputs.indexOf("const sourceTitle = normalizeStudioCarouselSourceTitle");
const sourceTitleConfigRead = outputs.indexOf("await loadCarouselConfig", sourceTitleGate);
const sourceTitleQueueWrite = outputs.indexOf(".insert({", sourceTitleGate);
assert(sourceTitleGate > -1 && sourceTitleConfigRead > sourceTitleGate
  && sourceTitleQueueWrite > sourceTitleConfigRead,
  "source_title is not rejected at the queue door before config/database side effects");
assert.match(outputs, /code: sourceTitle\.issue[\s\S]*\{ status: 400 \}/);
assert.doesNotMatch(outputs, /\.from\("social_posts"\)[\s\S]{0,500}status: "scheduled"/);
assert.match(migration, /studio_decide_carousel_operation/);
assert.match(migration, /from public\.carousel_jobs job[\s\S]*for update/);
assert.match(migration, /decision_operation_id = p_decision_operation_id/);
assert.match(migration, /update public\.social_posts[\s\S]*update public\.carousel_jobs/);
assert.match(migration, /studio_cleanup_carousel_draft[\s\S]*from public\.carousel_jobs job[\s\S]*for update[\s\S]*from public\.social_posts post[\s\S]*for update/);
assert.match(migration, /studio_cleanup_carousel_draft[\s\S]*materialization_receipt[\s\S]*v_current_checksum[\s\S]*preserved_conflict[\s\S]*delete from public\.social_post_media/,
  "cleanup can delete a member-edited draft/media set after response loss");
assert.match(migration, /automatic cleanup stopped[\s\S]*preserved_conflict[\s\S]*v_current_checksum/,
  "cleanup can loop forever after the materialized post changes status, type, or owner");
assert.match(migration, /studio_decide_carousel_operation[\s\S]*from public\.social_posts post[\s\S]*for update[\s\S]*v_post\.status <> 'draft'[\s\S]*p_decision = 'approve'/,
  "reject can decide a carousel after its attached post moved out of draft");
assert.match(migration, /status = 'cleanup_pending'[\s\S]*studio_complete_carousel_cleanup[\s\S]*status = 'failed'/,
  "cleanup does not hold an unclaimable durable state across object storage deletion");
assert.match(migration, /cleanup_attempts integer not null default 0/);
assert.match(migration, /cleanup_last_error text/);
assert.match(migration, /cleanup_retry_at timestamptz/);
assert.match(migration, /'cleanup_pending', 'cleanup_quarantined', 'failed'/);
assert.match(migration, /carousel_jobs_cleanup_retry_idx[\s\S]*cleanup_retry_at[\s\S]*status = 'cleanup_pending'/);
assert.match(migration, /'carousel_cleanup_liveness', v_cleanup_liveness/);
assert.match(schemaContractTest, /'carousel_cleanup_liveness'/);
assert.match(schemaContractTest, /status = 'cleanup_quarantined'[\s\S]*cleanup_attempts = 4[\s\S]*cleanup_last_error = 'Injected persistent object storage failure'/);
assert.match(schemaContractTest, /quarantine did not preserve its cleanup evidence/);
assert.match(schemaContractTest, /materialization_receipt ->> 'contract_revision' = 'studio_carousel_materialization_v1'/);
assert.match(schemaContractTest, /post_id = '16700000-0000-4000-8000-000000000012'\) <> 10/);
assert.match(migration, /delete from public\.social_post_media[\s\S]*delete from public\.social_posts[\s\S]*v_deleted <> 1/,
  "cleanup can strip media without proving the runner-owned draft delete");
assert.match(migration, /revoke execute[\s\S]*from public, anon, authenticated/);
assert.match(migration, /grant execute[\s\S]*to service_role/);
assert.match(migration, /v_previous := public\.studio_165_schema_contract\(\)/);
assert.match(migration, /'ready', v_previous_ready and v_columns and v_constraints[\s\S]*v_cleanup_rpc and v_cleanup_acl[\s\S]*v_materialize_rpc and v_materialize_acl/);

console.log(JSON.stringify({
  ok: true,
  lease: "token CAS + 30s heartbeat + bounded stale recovery",
  spend: "ambiguous fails closed; normalized checkpoint resumes without a second call",
  ready: "draft carousel + ten URLs + numbered 2x5 receipt + ten ordered image rows",
  decisions: "session operation id + transactional row-locked RPC",
  factory: "explicit external renderer remains report-compatible",
}));
