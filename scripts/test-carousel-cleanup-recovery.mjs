#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  attemptStudioCarouselCleanup,
  runStudioCarouselIdempotentOperation,
  StudioCarouselTransportOutcomeUnknownError,
} from "./studio-carousel-cleanup.mjs";

const runner = readFileSync(new URL("./studio-runner.mjs", import.meta.url), "utf8");

let committedReceipt = false;
let resolvedLossAttempts = 0;
const replayedReceipt = await runStudioCarouselIdempotentOperation({
  stage: "lease-fenced materialization",
  operation: async () => {
    resolvedLossAttempts += 1;
    if (!committedReceipt) {
      committedReceipt = true;
      return { data: null, error: { code: "", message: "fetch failed" }, status: 0 };
    }
    return { data: { state: "materialized", claim_token: "same-token" }, error: null, status: 200 };
  },
});
assert.equal(committedReceipt, true);
assert.equal(resolvedLossAttempts, 2);
assert.equal(replayedReceipt.data.state, "materialized",
  "resolved transport loss did not converge on the committed exact-token receipt");

let deterministicAttempts = 0;
const deterministicPgError = await runStudioCarouselIdempotentOperation({
  stage: "deterministic database failure",
  operation: async () => {
    deterministicAttempts += 1;
    return { data: null, error: { code: "23514", message: "check constraint" }, status: 400 };
  },
});
assert.equal(deterministicAttempts, 1, "a genuine PostgreSQL error was retried as a transport loss");
assert.equal(deterministicPgError.error.code, "23514");

await assert.rejects(
  () => runStudioCarouselIdempotentOperation({
    stage: "deterministic storage upload",
    operation: async () => ({ data: null, error: { code: "", message: "fetch failed" }, status: 0 }),
  }),
  StudioCarouselTransportOutcomeUnknownError,
  "resolved storage transport loss fell through to destructive cleanup",
);
const artifacts = { post: true, media: 10, storage: 11 };
let databaseOutage = true;
let storageOutage = true;
let terminal = false;
let jobStatus = "rendering";

const cleanDatabase = async () => {
  if (databaseOutage) throw new Error("injected RPC response loss");
  artifacts.post = false;
  artifacts.media = 0;
  jobStatus = "cleanup_pending";
  return { state: "cleanup_pending" };
};
const removeStorage = async () => {
  if (storageOutage) throw new Error("injected storage response loss");
  artifacts.storage = 0;
  return { error: null };
};
const completeDatabase = async () => {
  terminal = true;
  jobStatus = "failed";
  return { state: "failed" };
};

// First process: database cleanup cannot be confirmed. No artifacts are
// guessed away and terminal failure remains forbidden.
let result = await attemptStudioCarouselCleanup({ cleanDatabase, removeStorage, completeDatabase });
assert.deepEqual({ complete: result.complete, stage: result.stage }, { complete: false, stage: "database" });
assert.deepEqual(artifacts, { post: true, media: 10, storage: 11 });
assert.equal(terminal, false);

// First restart: database transaction converges, storage response is lost.
databaseOutage = false;
result = await attemptStudioCarouselCleanup({ cleanDatabase, removeStorage, completeDatabase });
assert.deepEqual({ complete: result.complete, stage: result.stage }, { complete: false, stage: "storage" });
assert.deepEqual(artifacts, { post: false, media: 0, storage: 11 });
assert.equal(terminal, false);
assert.equal(jobStatus, "cleanup_pending");
assert.equal(["running", "writing", "rendering", "uploading", "revising"].includes(jobStatus), false,
  "a replacement renderer could claim while old-token storage cleanup is pending");

// Next restart: idempotent DB receipt plus deterministic storage paths reach
// confirmed zero; only now may the runner report terminal failed.
storageOutage = false;
result = await attemptStudioCarouselCleanup({ cleanDatabase, removeStorage, completeDatabase });
assert.deepEqual(result, { complete: true, stage: "complete", error: null });
assert.deepEqual(artifacts, { post: false, media: 0, storage: 0 });
assert.equal(terminal, true);
assert.equal(jobStatus, "failed");

const cleanupFunction = runner.indexOf("async function cleanupUncommittedCarouselDraft");
const beginRpc = runner.indexOf("studio_cleanup_carousel_draft", cleanupFunction);
const storageRemoval = runner.indexOf('storage.from("images").remove(storagePaths)', beginRpc);
const terminalRpc = runner.indexOf("studio_complete_carousel_cleanup", storageRemoval);
assert(cleanupFunction > -1 && beginRpc > cleanupFunction && storageRemoval > beginRpc && terminalRpc > storageRemoval,
  "runner terminalizes before confirmed database and storage cleanup");
assert.match(runner, /if \(!cleanup\)[\s\S]*return "deferred";/,
  "runner does not leave cleanup failure recoverable for restart");
assert.match(runner, /\.eq\("status", "cleanup_pending"\)/,
  "runner has no restart lane for durable cleanup ownership");

let storageTouchedAfterEdit = false;
result = await attemptStudioCarouselCleanup({
  cleanDatabase: async () => ({ state: "preserved_conflict" }),
  removeStorage: async () => {
    storageTouchedAfterEdit = true;
    return { error: null };
  },
  completeDatabase: async () => ({ state: "failed" }),
});
assert.deepEqual(result, { complete: true, stage: "preserved_conflict", error: null });
assert.equal(storageTouchedAfterEdit, false, "member-edited carousel storage was deleted after receipt conflict");

const deletedDraftArtifacts = { post: false, media: 0, storage: 11 };
let deletedDraftTerminal = false;
const deletedDraftCleanup = await attemptStudioCarouselCleanup({
  cleanDatabase: async () => ({ state: "cleanup_pending", post_removed: true }),
  removeStorage: async () => {
    deletedDraftArtifacts.storage = 0;
    return { error: null };
  },
  completeDatabase: async () => {
    deletedDraftTerminal = true;
    return { state: "failed" };
  },
});
assert.deepEqual(deletedDraftCleanup, { complete: true, stage: "complete", error: null });
assert.deepEqual(deletedDraftArtifacts, { post: false, media: 0, storage: 0 },
  "member-deleted draft left deterministic slide/contact objects orphaned");
assert.equal(deletedDraftTerminal, true);
assert.match(runner, /materialized\?\.state === "cleanup_pending"[\s\S]*was not recreated[\s\S]*return "deferred"/,
  "a deleted materialized draft is resurrected or skips its durable storage sweep");
assert.match(runner, /runStudioCarouselIdempotentOperation\(\{[\s\S]*storage upload \$\{storagePath\}/,
  "resolved storage upload loss is not replayed at the deterministic path");
assert.match(runner, /carouselDatabaseMutation[\s\S]*runStudioCarouselIdempotentOperation/,
  "resolved RPC transport envelopes can fall through to destructive cleanup");

// Claim recovery uses this exact lane when a durable checkpoint no longer
// validates (including a template-registry bump). Even if a prior response was
// lost after materialization, all database and deterministic storage artifacts
// must converge before the row may become terminal.
const invalidCheckpointArtifacts = { post: true, media: 10, storage: 11 };
let invalidCheckpointTerminal = false;
const invalidCheckpointCleanup = await attemptStudioCarouselCleanup({
  cleanDatabase: async () => {
    invalidCheckpointArtifacts.post = false;
    invalidCheckpointArtifacts.media = 0;
    return { state: "cleanup_pending", post_removed: true };
  },
  removeStorage: async () => {
    invalidCheckpointArtifacts.storage = 0;
    return { error: null };
  },
  completeDatabase: async () => {
    invalidCheckpointTerminal = true;
    return { state: "failed" };
  },
});
assert.deepEqual(invalidCheckpointCleanup, { complete: true, stage: "complete", error: null });
assert.deepEqual(invalidCheckpointArtifacts, { post: false, media: 0, storage: 0 },
  "an invalid durable checkpoint left its draft, media, or eleven deterministic objects orphaned");
assert.equal(invalidCheckpointTerminal, true);

const quarantinedArtifacts = { post: true, media: 10, storage: 11, receipt: true };
let quarantinedStorageTouched = false;
let quarantinedTerminal = false;
const quarantinedCleanup = await attemptStudioCarouselCleanup({
  cleanDatabase: async () => ({ state: "refused" }),
  removeStorage: async () => {
    quarantinedStorageTouched = true;
    return { error: null };
  },
  completeDatabase: async () => {
    quarantinedTerminal = true;
    return { state: "failed" };
  },
});
assert.deepEqual(quarantinedCleanup, { complete: false, stage: "refused", error: null });
assert.deepEqual(quarantinedArtifacts, { post: true, media: 10, storage: 11, receipt: true });
assert.equal(quarantinedStorageTouched, false,
  "quarantined cleanup touched deterministic objects despite a refused ownership receipt");
assert.equal(quarantinedTerminal, false,
  "quarantined cleanup discarded its durable materialization evidence");

console.log(JSON.stringify({
  ok: true,
  injected_failures: ["database_cleanup", "storage_cleanup"],
  restart_convergence: "zero post + zero media + zero deterministic storage before terminal failed",
}));
