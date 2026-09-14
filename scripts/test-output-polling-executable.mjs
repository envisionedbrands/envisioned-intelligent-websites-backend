#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createStudioOutputPoller,
  mergeStudioOutputLiveData,
  reconcileStudioOutputItems,
  studioOutputReferenceBatches,
  studioOutputReferenceKey,
} from '../src/lib/studio/output-polling.ts';

class FakeScheduler {
  now = 0;
  nextId = 1;
  timers = new Map();

  setTimeout = (callback, delayMs) => {
    const handle = this.nextId++;
    this.timers.set(handle, { at: this.now + delayMs, callback });
    return handle;
  };

  clearTimeout = (handle) => {
    this.timers.delete(handle);
  };

  async flushMicrotasks() {
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
  }

  async advance(ms) {
    const target = this.now + ms;
    for (;;) {
      await this.flushMicrotasks();
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [handle, timer] = due;
      this.timers.delete(handle);
      this.now = timer.at;
      timer.callback();
      await this.flushMicrotasks();
    }
    this.now = target;
    await this.flushMicrotasks();
  }
}

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

const scheduler = new FakeScheduler();
let visible = true;
let calls = 0;
let inFlight = 0;
let maxInFlight = 0;
let applied = 0;
let pending = deferred();
const poller = createStudioOutputPoller({
  intervalMs: 6_000,
  requestTimeoutMs: 120_000,
  scheduler,
  isVisible: () => visible,
  poll: async (signal) => {
    calls++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      return await pending.promise;
    } finally {
      inFlight--;
      void signal;
    }
  },
  apply: () => {
    applied++;
  },
});

poller.start();
poller.start();
assert.equal(calls, 0, 'start bypassed the cancellable immediate timer');
await scheduler.advance(0);
assert.equal(calls, 1, 'initial mount did not perform exactly one controlled poll');

poller.refresh();
poller.refresh();
await scheduler.advance(60_000);
assert.equal(calls, 1, 'a scheduled or manual poll overlapped the in-flight request');
assert.equal(maxInFlight, 1, 'more than one output request was in flight');

pending.resolve({ status: 'ready' });
await scheduler.advance(0);
assert.equal(calls, 2, 'multiple manual refreshes were not coalesced to one follow-up');
assert.equal(applied, 2, 'the initial and one coalesced response were not each applied once');
assert.equal(calls, 2, 'a successful response/rerender triggered another immediate poll');
await scheduler.advance(5_999);
assert.equal(calls, 2, 'the foreground interval was not respected');
await scheduler.advance(1);
assert.equal(calls, 3, 'the next foreground poll did not run at the configured interval');

await scheduler.advance(0);
visible = false;
poller.visibilityChanged();
await scheduler.advance(60_000);
assert.equal(calls, 3, 'a hidden tab continued polling');

visible = true;
poller.visibilityChanged();
poller.visibilityChanged();
await scheduler.advance(0);
assert.equal(calls, 4, 'visibility restoration did not coalesce to one refresh');

poller.stop();
await scheduler.advance(60_000);
assert.equal(calls, 4, 'cleanup left a poll timer alive');

const cleanupScheduler = new FakeScheduler();
const cleanupRequest = deferred();
let cleanupApplied = 0;
const cleanupPoller = createStudioOutputPoller({
  scheduler: cleanupScheduler,
  isVisible: () => true,
  poll: () => cleanupRequest.promise,
  apply: () => cleanupApplied++,
});
cleanupPoller.start();
await cleanupScheduler.advance(0);
cleanupPoller.stop();
cleanupRequest.resolve({ status: 'late' });
await cleanupScheduler.advance(60_000);
assert.equal(cleanupApplied, 0, 'cleanup allowed a late request to update state');

const errorScheduler = new FakeScheduler();
let errorCalls = 0;
const errorPoller = createStudioOutputPoller({
  intervalMs: 6_000,
  scheduler: errorScheduler,
  isVisible: () => true,
  poll: async () => {
    errorCalls++;
    throw new Error('temporary');
  },
  apply: () => assert.fail('failed polls must not apply data'),
});
errorPoller.start();
await errorScheduler.advance(0);
assert.equal(errorCalls, 1);
await errorScheduler.advance(5_999);
assert.equal(errorCalls, 1, 'a failure created a fast retry loop');
await errorScheduler.advance(1);
assert.equal(errorCalls, 2, 'a failed poll did not retry at the bounded interval');
errorPoller.stop();

const timeoutScheduler = new FakeScheduler();
let timeoutCalls = 0;
const timeoutPoller = createStudioOutputPoller({
  intervalMs: 6_000,
  requestTimeoutMs: 20_000,
  scheduler: timeoutScheduler,
  isVisible: () => true,
  poll: (signal) => {
    timeoutCalls++;
    // Deliberately ignore abort. The controller's own abort race must release
    // ownership and fence this never-settling promise.
    void signal;
    return new Promise(() => {});
  },
  apply: () => assert.fail('a timed-out poll must not apply data'),
});
timeoutPoller.start();
await timeoutScheduler.advance(20_000);
assert.equal(timeoutCalls, 1, 'the hung request was not aborted at its watchdog boundary');
await timeoutScheduler.advance(5_999);
assert.equal(timeoutCalls, 1, 'the timeout created an immediate retry loop');
await timeoutScheduler.advance(1);
assert.equal(timeoutCalls, 2, 'the timed-out poll did not retry at the bounded interval');
timeoutPoller.stop();

const cadenceScheduler = new FakeScheduler();
let cadenceCalls = 0;
const cadencePoller = createStudioOutputPoller({
  intervalMs: 6_000,
  scheduler: cadenceScheduler,
  isVisible: () => true,
  poll: async () => ({ cycle: ++cadenceCalls }),
  apply: () => {},
});
cadencePoller.start();
await cadenceScheduler.advance(600_000);
assert.equal(cadenceCalls, 101, 'ten foreground minutes exceeded the configured request cadence');
cadencePoller.stop();

const hiddenStartScheduler = new FakeScheduler();
let hiddenStartCalls = 0;
let hiddenAtStart = true;
const hiddenStartPoller = createStudioOutputPoller({
  scheduler: hiddenStartScheduler,
  isVisible: () => !hiddenAtStart,
  poll: async () => ++hiddenStartCalls,
  apply: () => {},
});
hiddenStartPoller.start();
await hiddenStartScheduler.advance(600_000);
assert.equal(hiddenStartCalls, 0, 'a board mounted in a hidden tab polled');
hiddenAtStart = false;
hiddenStartPoller.visibilityChanged();
hiddenStartPoller.visibilityChanged();
await hiddenStartScheduler.advance(0);
assert.equal(hiddenStartCalls, 1, 'hidden-to-visible restoration issued more than one request');
hiddenStartPoller.stop();

const strictScheduler = new FakeScheduler();
let strictCalls = 0;
const strictOptions = {
  scheduler: strictScheduler,
  isVisible: () => true,
  poll: async () => ++strictCalls,
  apply: () => {},
};
const speculativePoller = createStudioOutputPoller(strictOptions);
speculativePoller.start();
speculativePoller.stop();
const committedPoller = createStudioOutputPoller(strictOptions);
committedPoller.start();
await strictScheduler.advance(0);
assert.equal(strictCalls, 1, 'a Strict Mode setup/cleanup/setup cycle issued duplicate immediate requests');
committedPoller.stop();

const refChangeScheduler = new FakeScheduler();
const staleRefRequest = deferred();
let oldRefApplied = 0;
let newRefApplied = 0;
let refRequestsInFlight = 0;
let refRequestsMaxInFlight = 0;
const oldRefPoller = createStudioOutputPoller({
  scheduler: refChangeScheduler,
  isVisible: () => true,
  poll: (signal) => {
    refRequestsInFlight++;
    refRequestsMaxInFlight = Math.max(refRequestsMaxInFlight, refRequestsInFlight);
    signal.addEventListener('abort', () => refRequestsInFlight--, { once: true });
    return staleRefRequest.promise;
  },
  apply: () => oldRefApplied++,
});
oldRefPoller.start();
await refChangeScheduler.advance(0);
oldRefPoller.stop();
const newRefPoller = createStudioOutputPoller({
  scheduler: refChangeScheduler,
  isVisible: () => true,
  poll: async () => {
    refRequestsInFlight++;
    refRequestsMaxInFlight = Math.max(refRequestsMaxInFlight, refRequestsInFlight);
    refRequestsInFlight--;
    return { ref: 'new' };
  },
  apply: () => newRefApplied++,
});
newRefPoller.start();
await refChangeScheduler.advance(0);
staleRefRequest.resolve({ ref: 'old' });
await refChangeScheduler.advance(0);
assert.equal(oldRefApplied, 0, 'a stale reference-set response updated the board');
assert.equal(newRefApplied, 1, 'the changed reference set did not start exactly one fresh cycle');
assert.equal(refRequestsMaxInFlight, 1, 'a reference-set change overlapped active network requests');
newRefPoller.stop();

assert.equal(
  studioOutputReferenceKey(['social_post:b', 'calendar_topic:a', 'social_post:b']),
  'calendar_topic:a,social_post:b',
  'output references are not deduplicated and deterministic',
);
assert.deepEqual(
  studioOutputReferenceBatches(
    studioOutputReferenceKey(Array.from({ length: 101 }, (_, index) => `social_post:${String(index).padStart(3, '0')}`)),
  ).map((batch) => batch.split(',').length),
  [50, 50, 1],
  'large boards do not respect the output route batch ceiling',
);

const existing = { live: { nested: { b: 2, a: 1 }, rows: [1, 2] }, onDecide: 'stable' };
assert.equal(
  mergeStudioOutputLiveData(existing, { rows: [1, 2], nested: { a: 1, b: 2 } }, { onDecide: 'new' }),
  existing,
  'unchanged live status replaced node data',
);
assert.notEqual(
  mergeStudioOutputLiveData(existing, { nested: { a: 1, b: 3 }, rows: [1, 2] }, { onDecide: 'new' }),
  existing,
  'changed live status did not replace node data',
);
const unchangedItems = [{ id: 'a' }, { id: 'b' }];
assert.equal(
  reconcileStudioOutputItems(unchangedItems, (item) => item),
  unchangedItems,
  'unchanged output data replaced the node collection',
);
const changedItems = reconcileStudioOutputItems(unchangedItems, (item) => (item.id === 'b' ? { ...item, ready: true } : item));
assert.notEqual(changedItems, unchangedItems);
assert.equal(changedItems[0], unchangedItems[0], 'reconciliation replaced an unaffected node');
assert.notEqual(changedItems[1], unchangedItems[1], 'reconciliation did not replace the affected node');

const referenceKeyForNodes = (nodes) => studioOutputReferenceKey(
  nodes
    .filter((node) => node.type === 'mirror' && node.data.output_type && node.data.ref_id)
    .map((node) => `${node.data.output_type}:${node.data.ref_id}`),
);
let effectKey;
let effectStarts = 0;
const render = (nodes) => {
  const nextKey = referenceKeyForNodes(nodes);
  if (!Object.is(effectKey, nextKey)) {
    effectKey = nextKey;
    effectStarts++;
  }
};
const renderedNodes = [{
  id: 'mirror-a',
  type: 'mirror',
  data: { output_type: 'carousel_job', ref_id: 'job-a' },
}];
render(renderedNodes);
const statusRerender = reconcileStudioOutputItems(renderedNodes, (node) => {
  const data = mergeStudioOutputLiveData(node.data, { status: 'rendering', progress: 20 }, { onDecide: 'stable' });
  return data === node.data ? node : { ...node, data };
});
assert.notEqual(statusRerender, renderedNodes, 'the controlled status response did not model a real rerender');
render(statusRerender);
assert.equal(effectStarts, 1, 'a status-driven rerender restarted the output polling effect');
assert.equal(referenceKeyForNodes([...statusRerender].reverse()), effectKey, 'node ordering changed the polling dependency');

const boardSource = readFileSync(new URL('../src/components/studio/studio-board.tsx', import.meta.url), 'utf8');
assert.match(boardSource, /const outputRefKey = useMemo/);
assert.match(boardSource, /studioOutputReferenceKey/);
assert.match(boardSource, /createStudioOutputPoller/);
assert.match(boardSource, /document\.addEventListener\('visibilitychange'/);
assert.match(boardSource, /outputPollerRef\.current\?\.refresh\(\)/);
assert.match(boardSource, /\}, \[flash, outputRefKey, setNodes\]\);/);
assert.doesNotMatch(
  boardSource.slice(boardSource.indexOf('// ── output polling'), boardSource.indexOf('// Desk panel calls this')),
  /setInterval\(/,
  'output polling still uses an overlapping interval',
);

let emptyCalls = 0;
if (studioOutputReferenceKey([])) emptyCalls++;
assert.equal(emptyCalls, 0, 'a board with no output references can enter the polling effect');

console.log(JSON.stringify({
  ok: true,
  initial_mount_calls: 1,
  maximum_in_flight: maxInFlight,
  bounded_foreground_interval_ms: 6_000,
  request_watchdog_ms: 20_000,
  ten_minute_foreground_calls: cadenceCalls,
  hidden_tab_calls: 0,
  visibility_restore_calls: 1,
  cleanup_late_updates: cleanupApplied,
  unchanged_node_identity: 'preserved',
  status_rerender_effect_starts: effectStarts,
  empty_board_calls: emptyCalls,
}));
