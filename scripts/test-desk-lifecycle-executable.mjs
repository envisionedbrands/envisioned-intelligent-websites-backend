#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  pruneRemovedPendingDeskNodeIds,
  reconcilePendingDeskNodeIds,
  recoveredPendingDeskNodeIds,
} from '../src/lib/studio/desk-save-readiness.ts';
import { createLatestRequestGate } from '../src/lib/studio/latest-request.ts';
import { runAfterStudioSave } from '../src/lib/studio/save-before-action.ts';

const recovered = recoveredPendingDeskNodeIds(
  [{ id: 'saved-desk', kind: 'desk' }],
  [{ id: 'saved-desk', kind: 'desk' }, { id: 'recovered-fresh-desk', kind: 'desk' }],
);
assert.deepEqual([...recovered], ['recovered-fresh-desk']);
assert.equal(reconcilePendingDeskNodeIds(recovered, [{ id: 'other', kind: 'note' }]), recovered);
const acknowledged = reconcilePendingDeskNodeIds(recovered, [{ id: 'recovered-fresh-desk', kind: 'desk' }]);
assert.equal(acknowledged.size, 0, 'an exact recovery save receipt did not release the recovered desk');

const pending = new Set(['deleted-before-save', 'still-pending']);
const pruned = pruneRemovedPendingDeskNodeIds(pending, new Set(['deleted-before-save']));
assert.deepEqual([...pruned], ['still-pending']);
assert.equal(pending.has('deleted-before-save'), true, 'pending React state was mutated in place');

const gate = createLatestRequestGate();
const applied = [];
const older = gate.begin();
const newer = gate.begin();
await Promise.resolve().then(() => {
  if (gate.isLatest(newer)) applied.push('newer');
});
await Promise.resolve().then(() => {
  if (gate.isLatest(older)) applied.push('older');
});
assert.deepEqual(applied, ['newer'], 'an out-of-order context response overwrote the newest state');

let modelPosts = 0;
await assert.rejects(
  runAfterStudioSave(async () => false, async () => {
    modelPosts++;
    return 'reply';
  }),
  /could not be saved/,
);
assert.equal(modelPosts, 0, 'the model POST ran before the board-save barrier succeeded');
assert.equal(await runAfterStudioSave(async () => true, async () => ++modelPosts), 1);

console.log(JSON.stringify({
  ok: true,
  recovery: 'fresh recovered desks remain pending until their exact save receipt',
  deletion: 'delete-before-receipt prunes pending state immutably',
  context: 'only the newest overlapping refresh may update state',
  model: 'no POST can run before beforeSend succeeds',
}));
