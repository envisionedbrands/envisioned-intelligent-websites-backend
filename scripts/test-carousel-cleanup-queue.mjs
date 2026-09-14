#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  STUDIO_CAROUSEL_CLEANUP_MAX_ATTEMPTS,
  studioCarouselCleanupFailurePatch,
} from "./studio-carousel-cleanup-queue.mjs";

const first = studioCarouselCleanupFailurePatch({
  attempts: 0,
  error: new Error("Injected storage outage"),
  now: Date.parse("2026-09-01T00:00:00.000Z"),
});
assert.equal(first.status, "cleanup_pending");
assert.equal(first.cleanup_attempts, 1);
assert.equal(first.cleanup_retry_at, "2026-09-01T00:00:30.000Z");
assert.equal(first.completed_at, null);

const quarantine = studioCarouselCleanupFailurePatch({
  attempts: STUDIO_CAROUSEL_CLEANUP_MAX_ATTEMPTS - 1,
  error: "Injected persistent object storage failure",
});
assert.equal(quarantine.status, "cleanup_quarantined");
assert.equal(quarantine.cleanup_attempts, 4);
assert.equal(quarantine.cleanup_retry_at, null);
assert.equal(quarantine.completed_at, null);
assert.match(quarantine.cleanup_last_error, /persistent object storage failure/);
assert.equal("claim_token" in quarantine, false, "quarantine must preserve the cleanup ownership token");
assert.equal("materialization_receipt" in quarantine, false, "quarantine must preserve the artifact receipt");

console.log(JSON.stringify({
  ok: true,
  retry: "bounded exponential backoff",
  quarantine_after: STUDIO_CAROUSEL_CLEANUP_MAX_ATTEMPTS,
}));
