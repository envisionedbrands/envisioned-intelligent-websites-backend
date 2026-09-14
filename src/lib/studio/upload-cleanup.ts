/**
 * Durable cleanup for abandoned direct-upload receipts.
 *
 * Upload bytes never pass through the Worker. This helper only claims small
 * receipt rows and asks Supabase Storage to remove their exact object paths.
 * It is shared by the member upload route (opportunistic fallback) and the
 * machine-only runner sweep (autonomous liveness when nobody uploads again).
 */
import type { createAdminClient } from '@/lib/supabase/server';
import {
  removeUploadObjectWithRetries,
  STUDIO_UPLOAD_PURGE_VERIFY_DELAY_MS,
  STUDIO_UPLOAD_TRANSFER_GRACE_MS,
} from '@/lib/studio/uploads';

type AdminClient = ReturnType<typeof createAdminClient>;

export type StudioUploadCleanupReceipt = {
  id: string;
  bucket: string;
  object_path: string;
  failure_code: string | null;
};

type StudioUploadPurgeReceipt = StudioUploadCleanupReceipt & {
  status: 'purge_pending' | 'purged';
  updated_at: string;
};

export type StudioUploadCleanupSummary = {
  inspected: number;
  claimed: number;
  removed: number;
  verified: number;
  failed: number;
};

const finalCleanupStatus = (failureCode: string | null) =>
  failureCode === 'expired' ? 'expired' as const : 'rejected' as const;

/**
 * Remove one already-claimed object. A failed delete or state transition keeps
 * the row cleanup_pending so a later bounded sweep can retry it safely.
 */
export async function removeStudioUploadReceiptObject(
  supabase: AdminClient,
  receipt: StudioUploadCleanupReceipt,
) {
  const removed = await removeUploadObjectWithRetries(
    () => supabase.storage.from(receipt.bucket).remove([receipt.object_path]),
  );
  const { error: stateError } = await supabase
    .from('studio_upload_receipts')
    .update({
      status: removed ? finalCleanupStatus(receipt.failure_code) : 'cleanup_pending',
      ...(!removed ? { failure_code: receipt.failure_code ?? 'cleanup_failed' } : {}),
    })
    .eq('id', receipt.id)
    .eq('status', 'cleanup_pending');
  return removed && !stateError;
}

/**
 * Begin final cleanup only after token expiry plus transfer grace. Successful
 * deletion moves the row to purge_pending rather than declaring absence: a
 * later sweep must prove the path stayed absent before the receipt becomes
 * purged and joins the perpetual audit lane.
 */
async function beginTerminalUploadPurge(
  supabase: AdminClient,
  receipt: StudioUploadCleanupReceipt,
) {
  const removed = await removeUploadObjectWithRetries(
    () => supabase.storage.from(receipt.bucket).remove([receipt.object_path]),
  );
  if (!removed) return false;
  const { error } = await supabase
    .from('studio_upload_receipts')
    .update({ status: 'purge_pending' })
    .eq('id', receipt.id)
    .in('status', ['rejected', 'expired']);
  return !error;
}

const uploadObjectLocation = (path: string) => {
  const slash = path.lastIndexOf('/');
  return {
    folder: path.slice(0, slash),
    objectName: path.slice(slash + 1),
  };
};

/**
 * Claim and inspect one purge lifecycle version. `purge_pending` requires an
 * absence proof before it becomes `purged`; `purged` is deliberately not a
 * terminal/unsweepable state. It remains on a bounded audit lane forever, so a
 * signed PUT that lands after an absence listing can only survive until the
 * next audit. If an object is found in either state, delete it and return the
 * receipt to `purge_pending` for a fresh, separate quiet-window proof.
 */
async function verifyUploadPurgeCandidate(
  supabase: AdminClient,
  candidate: StudioUploadPurgeReceipt,
): Promise<'verified' | 'removed' | 'failed' | 'skipped'> {
  // Claim this exact quiet-window version before reading or deleting Storage.
  // Several browser prepares plus the runner sweep may overlap. Without this
  // CAS, one sweep can delete a late object while another immediately observes
  // absence and marks the receipt purged, collapsing the required quiet window.
  // The table touch trigger advances updated_at, so every competing claim of
  // the version selected above returns no row and performs no Storage action.
  const { data: receipt, error: claimError } = await supabase
    .from('studio_upload_receipts')
    .update({ status: candidate.status })
    .eq('id', candidate.id)
    .eq('status', candidate.status)
    .eq('updated_at', candidate.updated_at)
    .select('id,bucket,object_path,failure_code,status,updated_at')
    .maybeSingle();
  if (claimError) return 'failed';
  if (!receipt) return 'skipped';

  const claimed = receipt as StudioUploadPurgeReceipt;
  const { folder, objectName } = uploadObjectLocation(claimed.object_path);
  const { data, error } = await supabase.storage
    .from(claimed.bucket)
    .list(folder, { search: objectName, limit: 2 });
  if (error) return 'failed';

  const stillPresent = data?.some((item) => item.name === objectName) ?? false;
  if (!stillPresent) {
    // The claim above already touched a purged row's updated_at, keeping it in
    // the perpetual audit rotation. If a PUT lands after this listing, the row
    // remains sweepable and that object is removed on a later audit.
    if (claimed.status === 'purged') return 'verified';

    const { data: promoted, error: stateError } = await supabase
      .from('studio_upload_receipts')
      .update({ status: 'purged' })
      .eq('id', claimed.id)
      .eq('status', 'purge_pending')
      .eq('updated_at', claimed.updated_at)
      .select('id')
      .maybeSingle();
    return stateError || !promoted ? 'failed' : 'verified';
  }

  const removed = await removeUploadObjectWithRetries(
    () => supabase.storage.from(claimed.bucket).remove([claimed.object_path]),
  );
  if (!removed) return 'failed';
  // Return to purge_pending and advance updated_at again after deletion. The
  // next absence proof cannot run until a complete, separate quiet window.
  const { data: retained, error: stateError } = await supabase
    .from('studio_upload_receipts')
    .update({ status: 'purge_pending' })
    .eq('id', claimed.id)
    .eq('status', claimed.status)
    .eq('updated_at', claimed.updated_at)
    .select('id')
    .maybeSingle();
  return stateError || !retained ? 'failed' : 'removed';
}

/**
 * Drain an independent bounded batch from every cleanup lane. A busy or broken
 * cleanup_pending lane cannot consume the expiry or purge lane's liveness
 * budget. Database faults are never mistaken for an empty queue.
 */
export async function cleanupStudioUploads(
  supabase: AdminClient,
  options: { batchSize?: number; now?: Date } = {},
): Promise<StudioUploadCleanupSummary> {
  // `batchSize` is a total Worker/network budget. Reserve part of it for each
  // lane so one class cannot starve another without multiplying the total by
  // the number of lanes. `purged` receipts have their own perpetual audit lane
  // rather than competing with first-time quiet-window verification.
  const laneCount = 5;
  const batchSize = Math.max(laneCount, Math.min(25, Math.trunc(options.batchSize ?? 10)));
  const perLane = Math.floor(batchSize / laneCount);
  const remainder = batchSize % laneCount;
  const laneBudget = {
    verifying: perLane + (remainder > 0 ? 1 : 0),
    auditing: perLane + (remainder > 1 ? 1 : 0),
    pending: perLane + (remainder > 2 ? 1 : 0),
    expired: perLane + (remainder > 3 ? 1 : 0),
    terminal: perLane,
  };
  const nowDate = options.now ?? new Date();
  const now = nowDate.toISOString();
  const terminalPurgeBefore = new Date(
    nowDate.getTime() - STUDIO_UPLOAD_TRANSFER_GRACE_MS,
  ).toISOString();
  const purgeVerifyBefore = new Date(
    nowDate.getTime() - STUDIO_UPLOAD_PURGE_VERIFY_DELAY_MS,
  ).toISOString();
  const summary: StudioUploadCleanupSummary = {
    inspected: 0,
    claimed: 0,
    removed: 0,
    verified: 0,
    failed: 0,
  };

  // Snapshot both purge lanes before changing either. A receipt promoted from
  // purge_pending to purged below cannot be audited again inside this sweep;
  // it must complete another full quiet window first.
  const { data: verifying, error: verifyingError } = await supabase
    .from('studio_upload_receipts')
    .select('id,bucket,object_path,failure_code,status,updated_at')
    .eq('status', 'purge_pending')
    .lt('updated_at', purgeVerifyBefore)
    .order('updated_at', { ascending: true })
    .limit(laneBudget.verifying);
  if (verifyingError) throw new Error(`Could not verify purged Studio uploads: ${verifyingError.message}`);

  const { data: auditing, error: auditingError } = await supabase
    .from('studio_upload_receipts')
    .select('id,bucket,object_path,failure_code,status,updated_at')
    .eq('status', 'purged')
    .lt('updated_at', purgeVerifyBefore)
    .order('updated_at', { ascending: true })
    .limit(laneBudget.auditing);
  if (auditingError) throw new Error(`Could not audit verified-absent Studio uploads: ${auditingError.message}`);

  for (const row of verifying ?? []) {
    summary.inspected += 1;
    const result = await verifyUploadPurgeCandidate(
      supabase,
      row as StudioUploadPurgeReceipt,
    );
    if (result === 'verified') summary.verified += 1;
    else if (result === 'removed') summary.removed += 1;
    else summary.failed += 1;
  }

  for (const row of auditing ?? []) {
    summary.inspected += 1;
    const result = await verifyUploadPurgeCandidate(
      supabase,
      row as StudioUploadPurgeReceipt,
    );
    if (result === 'verified') summary.verified += 1;
    else if (result === 'removed') summary.removed += 1;
    else summary.failed += 1;
  }

  const { data: pending, error: pendingError } = await supabase
    .from('studio_upload_receipts')
    .select('id,bucket,object_path,failure_code')
    .eq('status', 'cleanup_pending')
    .order('updated_at', { ascending: true })
    .limit(laneBudget.pending);
  if (pendingError) throw new Error(`Could not read pending Studio upload cleanup: ${pendingError.message}`);

  for (const row of pending ?? []) {
    summary.inspected += 1;
    const removed = await removeStudioUploadReceiptObject(
      supabase,
      row as StudioUploadCleanupReceipt,
    );
    if (removed) summary.removed += 1;
    else summary.failed += 1;
  }

  const { data: expired, error: expiredError } = await supabase
    .from('studio_upload_receipts')
    .select('id')
    .eq('status', 'prepared')
    .lt('expires_at', now)
    .order('expires_at', { ascending: true })
    .limit(laneBudget.expired);
  if (expiredError) throw new Error(`Could not read expired Studio uploads: ${expiredError.message}`);

  for (const candidate of expired ?? []) {
    summary.inspected += 1;
    const { data: claimed, error: claimError } = await supabase
      .from('studio_upload_receipts')
      .update({ status: 'cleanup_pending', failure_code: 'expired' })
      .eq('id', candidate.id)
      .eq('status', 'prepared')
      .lt('expires_at', now)
      .select('id,bucket,object_path,failure_code')
      .maybeSingle();
    if (claimError) {
      summary.failed += 1;
      continue;
    }
    if (!claimed) continue;
    summary.claimed += 1;
    const removed = await removeStudioUploadReceiptObject(
      supabase,
      claimed as StudioUploadCleanupReceipt,
    );
    if (removed) summary.removed += 1;
    else summary.failed += 1;
  }

  const { data: terminal, error: terminalError } = await supabase
    .from('studio_upload_receipts')
    .select('id,bucket,object_path,failure_code')
    .in('status', ['rejected', 'expired'])
    .lt('expires_at', terminalPurgeBefore)
    .order('expires_at', { ascending: true })
    .limit(laneBudget.terminal);
  if (terminalError) throw new Error(`Could not read terminal Studio upload cleanup: ${terminalError.message}`);

  for (const row of terminal ?? []) {
    summary.inspected += 1;
    const removed = await beginTerminalUploadPurge(
      supabase,
      row as StudioUploadCleanupReceipt,
    );
    if (removed) summary.removed += 1;
    else summary.failed += 1;
  }

  return summary;
}
