'use client';

/**
 * Email review — approval without ever leaving the Studio.
 *
 * Two shapes share this modal:
 *  - broadcast: the newsletter lane. Approve snapshots and enrolls the exact
 *    audience in one database transaction; the CRM engine delivers over ticks.
 *  - email_batch (legacy small batches): per-recipient agent_actions approved
 *    through the trust-layer endpoint.
 */
import { useEffect, useState } from 'react';
import { studioErrorMessage, studioFetchJson, studioFetchOk } from '@/lib/studio/fetch-json';
import { renderStudioMarkdown } from '@/lib/studio/markdown';

type ActionRow = { id: string; status: string; email: string };
type Detail = {
  status: string;
  detail: string;
  preview?: { subject?: string; preheader?: string | null; body_md?: string };
  actions?: ActionRow[];
  audience?: string;
  scheduled_at?: string | null;
  estimated?: number;
  recovery?: boolean;
};

export function EmailReview({
  refType,
  refId,
  onClose,
}: {
  refType: 'email_batch' | 'broadcast';
  refId: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Stable across response-loss retries, distinct across independent human
  // decisions (including the two buttons and another open browser).
  const [decisionOperationIds] = useState<{
    approve: string;
    reject: string;
  }>(() => ({
    approve: crypto.randomUUID(),
    reject: crypto.randomUUID(),
  }));

  const load = (options?: { preserveError?: boolean; clearWhenDecided?: boolean }) =>
    studioFetchJson<{ statuses?: Record<string, Detail> }>(`/api/studio/outputs?refs=${refType}:${refId}&detail=1`)
      .then((j) => {
        const next = j.statuses?.[`${refType}:${refId}`] ?? null;
        setDetail(next);
        if (!next) {
          // Missing is not an authoritative post-decision state. Preserve a
          // real decision error, or make an initial missing review explicit.
          if (!options?.preserveError) setError('This review is no longer available.');
          return;
        }
        // A post-decision GET clears a lost-response error only when the
        // authoritative state actually moved past review. Genuine failures
        // remain visible while the broadcast is still awaiting approval.
        if (!options?.preserveError || (options.clearWhenDecided && next.status !== 'awaiting approval')) {
          setError(null);
        }
      })
      .catch((e) => setError(studioErrorMessage(e, 'Could not load this review.')));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refId]);

  const decideBroadcast = async (decision: 'approve' | 'reject') => {
    setError(null);
    setWorking(decision);
    try {
      const j = await studioFetchJson<{ state: 'applied' | 'replayed'; decision: 'approve' | 'reject'; enrolled: number }>('/api/studio/outputs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'broadcast_decision',
          payload: {
            workflow_id: refId,
            decision,
            decision_operation_id: decisionOperationIds[decision],
          },
        }),
      });

      if (decision === 'approve') {
        setProgress(`${j.enrolled} enrolled atomically — the engine takes it from here.`);
      } else {
        setProgress(j.state === 'replayed' ? 'This broadcast was already rejected.' : 'Broadcast rejected.');
      }
    } catch (e) {
      setError(studioErrorMessage(e, 'Could not save that broadcast decision.'));
    } finally {
      setWorking(null);
      load({ preserveError: true, clearWhenDecided: true });
    }
  };

  const decideBatchAll = async (decision: 'approve' | 'reject') => {
    const pending = (detail?.actions ?? []).filter((a) => a.status === 'proposed');
    if (!pending.length) return;
    setError(null);
    setWorking(decision);
    for (const a of pending) {
      try {
        await studioFetchOk(`/api/agent/actions/${a.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision }),
        });
        setDetail((d) =>
          d
            ? { ...d, actions: d.actions?.map((x) => (x.id === a.id ? { ...x, status: decision === 'approve' ? 'approved' : 'rejected' } : x)) }
            : d
        );
      } catch (e) {
        setError(`${decision} failed at ${a.email}: ${studioErrorMessage(e)}`);
        break;
      }
    }
    setWorking(null);
    load({ preserveError: true });
  };

  const isBroadcast = refType === 'broadcast';
  const pendingCount = (detail?.actions ?? []).filter((a) => a.status === 'proposed').length;
  const awaiting = detail?.status === 'awaiting approval';

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60" onClick={onClose}>
      <div
        className="w-[680px] max-w-[92vw] max-h-[85vh] flex flex-col rounded-xl border border-minimal-border bg-minimal-bg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-minimal-border flex items-center">
          <div>
            <div className="text-sm font-medium">{isBroadcast ? 'Review broadcast' : 'Review email batch'}</div>
            <div className="text-[11px] text-minimal-muted mt-0.5">{detail ? detail.detail : 'Loading…'}</div>
          </div>
          <button onClick={onClose} className="ml-auto text-minimal-muted hover:text-minimal-accent px-2" aria-label="Close review">
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {detail?.preview && (
            <div className="rounded-lg border border-minimal-border bg-minimal-row p-4 mb-4">
              <div className="text-[13px] font-medium">{detail.preview.subject}</div>
              {detail.preview.preheader && <div className="text-[11px] text-minimal-muted mt-0.5">{detail.preview.preheader}</div>}
              <div
                className="agent-md text-[12.5px] leading-relaxed mt-3 pt-3 border-t border-minimal-border"
                dangerouslySetInnerHTML={{ __html: renderStudioMarkdown(detail.preview.body_md ?? '') }}
              />
            </div>
          )}

          {isBroadcast ? (
            <div className="rounded-lg border border-minimal-border p-4 text-[12px] space-y-1">
              <div>
                <span className="text-minimal-muted">Audience:</span> {detail?.audience ?? '…'}
              </div>
              <div>
                <span className="text-minimal-muted">Delivery:</span>{' '}
                {detail?.scheduled_at
                  ? `scheduled for ${String(detail.scheduled_at).slice(0, 16).replace('T', ' ')}`
                  : "after approval, inside the engine's send window"}
              </div>
              <div className="text-minimal-muted">
                Sends run through the CRM engine: suppression, daily budget, bounce protection. Unsubscribed and bounced
                leads are excluded automatically.
              </div>
              {detail?.recovery && (
                <div className="pt-2 text-amber-600 dark:text-amber-400">
                  A previous approval stopped part-way through. Complete approval to enroll the missing recipients and
                  any new subscribers who now match the audience; existing recipients are not duplicated.
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="text-[11px] uppercase tracking-wide text-minimal-muted mb-2">
                Recipients ({detail?.actions?.length ?? 0})
              </div>
              <div className="space-y-1">
                {(detail?.actions ?? []).map((a) => (
                  <div key={a.id} className="flex items-center gap-2 text-[12px]">
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        a.status === 'proposed' ? 'bg-amber-500' : a.status === 'rejected' || a.status === 'failed' ? 'bg-red-500' : 'bg-emerald-500'
                      }`}
                    />
                    <span>{a.email}</span>
                    <span className="ml-auto text-minimal-muted">{a.status}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {progress && <div className="mt-3 text-[12px] text-emerald-500">{progress}</div>}
          {error && <div className="mt-3 text-[12px] text-red-500">{error}</div>}
        </div>

        <footer className="px-5 py-4 border-t border-minimal-border flex gap-2">
          {isBroadcast ? (
            <>
              <button
                disabled={!awaiting || working !== null}
                onClick={() => decideBroadcast('approve')}
                className="flex-1 rounded bg-minimal-accent text-minimal-bg text-[13px] py-2 font-medium disabled:opacity-40"
              >
                {working === 'approve'
                  ? 'Enrolling…'
                  : detail?.recovery
                    ? `Complete approval (~${detail?.estimated ?? '?'})`
                    : `Approve — ${detail?.scheduled_at ? 'schedule' : 'start sending'} (~${detail?.estimated ?? '?'})`}
              </button>
              <button
                disabled={!awaiting || detail?.recovery || working !== null}
                onClick={() => decideBroadcast('reject')}
                className="rounded border border-minimal-border px-4 text-[13px] disabled:opacity-40"
                title={detail?.recovery ? 'A partially enrolled broadcast can only be completed safely.' : undefined}
              >
                Reject
              </button>
            </>
          ) : (
            <>
              <button
                disabled={!pendingCount || working !== null}
                onClick={() => decideBatchAll('approve')}
                className="flex-1 rounded bg-minimal-accent text-minimal-bg text-[13px] py-2 font-medium disabled:opacity-40"
              >
                {working === 'approve' ? 'Sending…' : `Approve all & send (${pendingCount})`}
              </button>
              <button
                disabled={!pendingCount || working !== null}
                onClick={() => decideBatchAll('reject')}
                className="rounded border border-minimal-border px-4 text-[13px] disabled:opacity-40"
              >
                {working === 'reject' ? 'Rejecting…' : 'Reject all'}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
