#!/usr/bin/env node

import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { withStudioCarouselLeaseHeartbeat } from "./studio-carousel-heartbeat.mjs";

let pulses = 0;
const result = await withStudioCarouselLeaseHeartbeat({
  heartbeatMs: 10,
  leaseMs: 50,
  report: async (patch) => {
    assert.deepEqual(patch, {});
    pulses += 1;
  },
  task: async () => {
    await wait(46);
    return "rendered";
  },
});
assert.equal(result, "rendered");
assert(pulses >= 3, `long render emitted only ${pulses} heartbeat(s)`);

await assert.rejects(
  withStudioCarouselLeaseHeartbeat({
    heartbeatMs: 10,
    leaseMs: 50,
    report: async () => { throw new Error("lease changed"); },
    task: async (signal) => {
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        setTimeout(resolve, 100);
      });
    },
  }),
  /lease changed/,
);

const settlementOrder = [];
await assert.rejects(
  withStudioCarouselLeaseHeartbeat({
    heartbeatMs: 10,
    leaseMs: 50,
    report: async () => { throw new Error("lease lost during upload"); },
    // Deliberately ignores AbortSignal to model a provider adapter that has
    // already crossed into an uninterruptible commit boundary.
    task: async () => {
      await wait(35);
      settlementOrder.push("task settled");
    },
  }),
  /lease lost during upload/,
);
settlementOrder.push("cleanup may start");
assert.deepEqual(
  settlementOrder,
  ["task settled", "cleanup may start"],
  "lease loss returned while an abort-insensitive side effect was still detached",
);

await assert.rejects(
  withStudioCarouselLeaseHeartbeat({
    heartbeatMs: 50,
    leaseMs: 50,
    report: async () => {},
    task: async () => {},
  }),
  /shorter than its claim lease/,
);

console.log(JSON.stringify({
  ok: true,
  long_render_heartbeats: pulses,
  lease_loss: "aborts and drains task settlement before cleanup",
}));
