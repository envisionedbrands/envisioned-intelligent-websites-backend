'use client';

/**
 * /agent — The Operator's dashboard.
 * Chat pane (talk to the agent) · approvals queue (one-click approve/reject)
 * · live activity feed (polls every 2s, shows tool calls as they happen).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import { api, EmptyState, GhostBtn, PrimaryBtn, timeAgo, useToast } from '@/components/crm/kit';

marked.setOptions({ gfm: true, breaks: true });

type ToolCall = { tool: string; summary: string; ok: boolean; at: string };

type Run = {
  id: string;
  trigger: 'chat' | 'tick';
  status: 'running' | 'completed' | 'failed';
  summary: string | null;
  report_md: string | null;
  tool_calls: ToolCall[];
  error: string | null;
  created_at: string;
  completed_at: string | null;
};

type Action = {
  id: string;
  type: 'email' | 'publish' | 'workflow' | 'dm_funnel' | 'other';
  title: string;
  summary: string | null;
  payload: Record<string, unknown>;
  status: string;
  created_at: string;
};

type ChatMessage = { role: 'user' | 'assistant'; content: string };

const TOOL_ICONS: Record<string, string> = {
  list_leads: '◆',
  get_lead: '◆',
  tag_lead: '#',
  add_note: '✎',
  get_crm_overview: '≡',
  get_funnel_stats: '▼',
  get_content_calendar: '▤',
  trend_scan: '◎',
  draft_article: '✎',
  draft_email: '✉',
  draft_personalized_batch: '✉',
  list_engaged_leads: '◆',
  list_pipeline: '⟩',
  create_opportunity: '⟩',
  move_opportunity_stage: '⟩',
  list_recent_replies: '↩',
  get_content_attribution: '▤',
  set_subject_test: '⇄',
  list_subject_tests: '⇄',
  save_insight: '★',
  list_insights: '★',
  propose_publish: '↗',
  propose_action: '☐',
  add_topics: '▤',
  list_workflows: '≡',
  draft_workflow: '✉',
  propose_workflow_activation: '▶',
};

const TYPE_BADGES: Record<Action['type'], { label: string; cls: string }> = {
  email: { label: 'Email', cls: 'border-blue-500/30 bg-blue-500/10 text-blue-400' },
  publish: { label: 'Publish', cls: 'border-violet-500/30 bg-violet-500/10 text-violet-400' },
  workflow: { label: 'Workflow', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-400' },
  dm_funnel: { label: 'DM funnel', cls: 'border-pink-500/30 bg-pink-500/10 text-pink-400' },
  other: { label: 'To-do', cls: 'border-minimal-border bg-minimal-row text-zinc-400' },
};

function Markdown({ md }: { md: string }) {
  return (
    <div
      className="agent-md text-[13.5px] leading-relaxed text-zinc-300"
      dangerouslySetInnerHTML={{ __html: marked.parse(md) as string }}
    />
  );
}

export default function AgentPage() {
  const { show, node: toastNode } = useToast();

  // ── chat state ──────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // ── polled state ────────────────────────────────────────────────────────
  const [runs, setRuns] = useState<Run[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [safeMode, setSafeMode] = useState<boolean | null>(null);
  const [ticking, setTicking] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [decidingBatch, setDecidingBatch] = useState<string | null>(null);
  const [expandedAction, setExpandedAction] = useState<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const [runsRes, actionsRes] = await Promise.all([
        api<{ runs: Run[]; safe_mode: boolean }>('/api/agent/runs'),
        api<{ actions: Action[] }>('/api/agent/actions?status=proposed'),
      ]);
      setRuns(runsRes.runs);
      setSafeMode(runsRes.safe_mode);
      setActions(actionsRes.actions);
    } catch {
      // polling errors are transient; keep the last good state
    }
  }, []);

  useEffect(() => {
    poll();
    const interval = setInterval(poll, 2000);
    return () => clearInterval(interval);
  }, [poll]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  // ── actions ─────────────────────────────────────────────────────────────
  const send = async () => {
    const message = input.trim();
    if (!message || sending) return;
    setInput('');
    const history = messages.slice(-12);
    setMessages((m) => [...m, { role: 'user', content: message }]);
    setSending(true);
    try {
      const res = await api<{ reply: string }>('/api/agent/chat', {
        method: 'POST',
        body: JSON.stringify({ message, history }),
      });
      setMessages((m) => [...m, { role: 'assistant', content: res.reply }]);
    } catch (e) {
      show(e instanceof Error ? e.message : 'The Operator hit an error', 'err');
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: '_Something broke on my end — check the feed and try again._' },
      ]);
    } finally {
      setSending(false);
      poll();
    }
  };

  const runTick = async () => {
    setTicking(true);
    show('Morning review started — watch the feed');
    try {
      await api('/api/agent/tick', { method: 'POST', body: '{}' });
      show('Morning report is in the feed');
    } catch (e) {
      show(e instanceof Error ? e.message : 'Morning review failed', 'err');
    } finally {
      setTicking(false);
      poll();
    }
  };

  const decide = async (id: string, decision: 'approve' | 'reject', fyi = false) => {
    setDeciding(id);
    try {
      const res = await api<{ status: string; result?: { preview_sent_to?: string | null } }>(
        `/api/agent/actions/${id}`,
        { method: 'POST', body: JSON.stringify({ decision }) }
      );
      if (fyi) {
        show('Cleared');
      } else if (decision === 'approve') {
        const preview = res.result?.preview_sent_to;
        show(preview ? `Approved — safe-mode preview sent to ${preview}` : 'Approved and executed');
      } else {
        show('Rejected');
      }
    } catch (e) {
      show(e instanceof Error ? e.message : 'Failed', 'err');
    } finally {
      setDeciding(null);
      poll();
    }
  };

  // Approve a whole batch sequentially — each item executes through the same
  // per-action endpoint, so per-item failures don't stop the rest.
  const approveBatch = async (batchId: string, batchActions: Action[]) => {
    setDecidingBatch(batchId);
    let approved = 0;
    let failed = 0;
    for (const a of batchActions) {
      try {
        await api(`/api/agent/actions/${a.id}`, {
          method: 'POST',
          body: JSON.stringify({ decision: 'approve' }),
        });
        approved++;
      } catch {
        failed++;
      }
    }
    show(
      failed === 0
        ? `Batch approved — ${approved} email${approved === 1 ? '' : 's'} executed`
        : `Batch: ${approved} approved, ${failed} failed`,
      failed === 0 ? undefined : 'err'
    );
    setDecidingBatch(null);
    poll();
  };

  const running = runs.some((r) => r.status === 'running');

  // Split the queue: approving an email/publish/workflow (or a Conversion
  // Radar match) EXECUTES something — those need a real decision. Every other
  // "other" action just acknowledges on approve (see executeAgentAction), so
  // showing Approve/Reject for them is theater; they render as one-tap FYIs.
  const isFyi = (a: Action) => a.type === 'other' && a.payload?.alert_kind !== 'possible_conversion';
  const fyis = actions.filter(isFyi);
  const decisions = actions.filter((a) => !isFyi(a));

  // Group queue items that share a payload.batch_id (personalized batches)
  const batches = new Map<string, Action[]>();
  const singles: Action[] = [];
  for (const a of decisions) {
    const batchId = typeof a.payload?.batch_id === 'string' ? a.payload.batch_id : null;
    if (batchId) {
      batches.set(batchId, [...(batches.get(batchId) || []), a]);
    } else {
      singles.push(a);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {toastNode}
      <header className="h-20 px-12 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold text-white">Operator</h1>
          {safeMode !== null && (
            <span
              className={`inline-flex items-center gap-2 px-2.5 py-0.5 border rounded-full text-xs font-medium ${
                safeMode
                  ? 'border-green-500/30 bg-green-500/10 text-green-400'
                  : 'border-red-500/30 bg-red-500/10 text-red-400'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${safeMode ? 'bg-green-500' : 'bg-red-500'}`} />
              {safeMode ? 'Safe mode on' : 'Safe mode OFF'}
            </span>
          )}
          {running && (
            <span className="text-xs font-medium text-minimal-muted animate-pulse">working…</span>
          )}
        </div>
        <GhostBtn onClick={runTick} disabled={ticking}>
          {ticking ? 'Reviewing the house…' : 'Run morning review'}
        </GhostBtn>
      </header>

      <div className="flex-1 overflow-hidden px-12 pb-10 grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* ── Chat ───────────────────────────────────────────────────────── */}
        <div className="lg:col-span-2 flex flex-col min-h-0 border border-minimal-border rounded-lg overflow-hidden">
          <div className="flex-1 overflow-y-auto px-6 py-6 flex flex-col gap-5">
            {messages.length === 0 && (
              <EmptyState
                title="Talk to your operator"
                hint={`It reads your real leads, funnel, and content calendar — and drafts emails and articles into your approvals queue. Try: "What happened in the funnel this week? Anyone worth following up?"`}
              />
            )}
            {messages.map((m, i) =>
              m.role === 'user' ? (
                <div key={i} className="self-end max-w-[85%] bg-minimal-row border border-minimal-border rounded-lg px-4 py-2.5 text-[13.5px] text-zinc-200 whitespace-pre-wrap">
                  {m.content}
                </div>
              ) : (
                <div key={i} className="max-w-[95%]">
                  <p className="text-[11px] font-semibold text-minimal-muted mb-1.5 tracking-wide uppercase">
                    Operator
                  </p>
                  <Markdown md={m.content} />
                </div>
              )
            )}
            {sending && (
              <div>
                <p className="text-[11px] font-semibold text-minimal-muted mb-1.5 tracking-wide uppercase">
                  Operator
                </p>
                <p className="text-[13px] text-minimal-muted animate-pulse">
                  Working — tool calls show up in the feed →
                </p>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
          <div className="border-t border-minimal-border p-4 flex gap-3">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              placeholder="Ask about leads, the funnel, content — or tell it to draft something…"
              className="flex-1 resize-none bg-minimal-row border border-minimal-border rounded-lg px-3 py-2 text-[14px] text-white placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none transition-colors"
            />
            <div className="flex flex-col justify-end">
              <PrimaryBtn onClick={send} disabled={sending || !input.trim()}>
                {sending ? '…' : 'Send'}
              </PrimaryBtn>
            </div>
          </div>
        </div>

        {/* ── Right rail: approvals + feed ──────────────────────────────── */}
        <div className="flex flex-col gap-8 min-h-0 overflow-y-auto pr-1">
          {/* Approvals queue */}
          <section>
            <h2 className="text-[13px] font-semibold text-zinc-300 mb-3">
              Approvals queue
              {decisions.length > 0 && (
                <span className="ml-2 px-1.5 py-0.5 rounded-full bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 text-[11px]">
                  {decisions.length}
                </span>
              )}
            </h2>
            {decisions.length === 0 ? (
              <p className="text-[13px] text-zinc-600 border border-minimal-border rounded-lg px-4 py-4">
                Nothing waiting. When the Operator drafts an email or wants to publish, it lands here
                first — nothing goes out without you.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {Array.from(batches.entries()).map(([batchId, batchActions]) => {
                  const label =
                    typeof batchActions[0].payload?.batch_label === 'string'
                      ? (batchActions[0].payload.batch_label as string)
                      : 'Personalized batch';
                  const busy = decidingBatch === batchId;
                  return (
                    <div key={batchId} className="border border-blue-500/30 rounded-lg p-4 bg-blue-500/[0.03]">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="px-2 py-0.5 border rounded-full text-[11px] font-medium border-blue-500/30 bg-blue-500/10 text-blue-400">
                          Batch · {batchActions.length} emails
                        </span>
                        <span className="text-xs text-zinc-600">{timeAgo(batchActions[0].created_at)}</span>
                      </div>
                      <p className="text-sm text-zinc-200 leading-snug mb-3">{label}</p>
                      <PrimaryBtn onClick={() => approveBatch(batchId, batchActions)} disabled={busy}>
                        {busy ? 'Executing batch…' : `Approve all ${batchActions.length}`}
                      </PrimaryBtn>
                      <div className="flex flex-col gap-3 mt-4">
                        {batchActions.map((a) => (
                          <ActionCard
                            key={a.id}
                            action={a}
                            deciding={deciding === a.id || busy}
                            expanded={expandedAction === a.id}
                            onToggle={() => setExpandedAction(expandedAction === a.id ? null : a.id)}
                            onDecide={decide}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
                {singles.map((a) => (
                  <ActionCard
                    key={a.id}
                    action={a}
                    deciding={deciding === a.id}
                    expanded={expandedAction === a.id}
                    onToggle={() => setExpandedAction(expandedAction === a.id ? null : a.id)}
                    onDecide={decide}
                  />
                ))}
              </div>
            )}
          </section>

          {/* FYIs: notices where "approve" only acknowledges — one tap clears */}
          {fyis.length > 0 && (
            <section>
              <h2 className="text-[13px] font-semibold text-zinc-300 mb-3">
                FYI
                <span className="ml-2 px-1.5 py-0.5 rounded-full bg-minimal-row border border-minimal-border text-zinc-400 text-[11px]">
                  {fyis.length}
                </span>
              </h2>
              <div className="flex flex-col gap-2">
                {fyis.map((a) => (
                  <FyiCard
                    key={a.id}
                    action={a}
                    deciding={deciding === a.id}
                    expanded={expandedAction === a.id}
                    onToggle={() => setExpandedAction(expandedAction === a.id ? null : a.id)}
                    onClear={() => decide(a.id, 'approve', true)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Live activity feed */}
          <section>
            <h2 className="text-[13px] font-semibold text-zinc-300 mb-3">Activity</h2>
            {runs.length === 0 ? (
              <p className="text-[13px] text-zinc-600 border border-minimal-border rounded-lg px-4 py-4">
                No runs yet. Say something in the chat or run the morning review.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {runs.map((run, index) => (
                  <FeedRun key={run.id} run={run} defaultOpen={index === 0} />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function ActionCard({
  action: a,
  deciding,
  expanded,
  onToggle,
  onDecide,
}: {
  action: Action;
  deciding: boolean;
  expanded: boolean;
  onToggle: () => void;
  onDecide: (id: string, decision: 'approve' | 'reject') => void;
}) {
  // A Conversion Radar match is the one 'other' action where approving
  // executes (links the member to the funnel lead + wins the deal).
  const badge =
    a.payload?.alert_kind === 'possible_conversion'
      ? { label: 'Confirm match', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' }
      : TYPE_BADGES[a.type];
  const bodyMd = typeof a.payload?.body_md === 'string' ? a.payload.body_md : null;
  const description = typeof a.payload?.description === 'string' ? a.payload.description : null;
  return (
    <div className="border border-minimal-border rounded-lg p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className={`px-2 py-0.5 border rounded-full text-[11px] font-medium ${badge.cls}`}>
          {badge.label}
        </span>
        <span className="text-xs text-zinc-600">{timeAgo(a.created_at)}</span>
      </div>
      <p className="text-sm text-zinc-200 leading-snug">{a.title}</p>
      {a.summary && <p className="text-xs text-zinc-500 mt-1">{a.summary}</p>}
      {(bodyMd || description) && (
        <button
          onClick={onToggle}
          className="text-xs text-minimal-muted hover:text-white mt-2 underline underline-offset-2"
        >
          {expanded ? 'Hide' : 'Preview'}
        </button>
      )}
      {expanded && (bodyMd || description) && (
        <div className="mt-3 border-t border-minimal-border pt-3 max-h-64 overflow-y-auto">
          <Markdown md={bodyMd || description || ''} />
        </div>
      )}
      <div className="flex gap-2 mt-3">
        <PrimaryBtn onClick={() => onDecide(a.id, 'approve')} disabled={deciding}>
          {deciding ? '…' : 'Approve'}
        </PrimaryBtn>
        <GhostBtn onClick={() => onDecide(a.id, 'reject')} disabled={deciding} danger>
          Reject
        </GhostBtn>
      </div>
    </div>
  );
}

// Human labels for the notice kinds the system files (payload.alert_kind).
const FYI_LABELS: Record<string, string> = {
  hot_lead: 'Hot lead',
  go_live_reminder: 'Reminder',
};

function FyiCard({
  action: a,
  deciding,
  expanded,
  onToggle,
  onClear,
}: {
  action: Action;
  deciding: boolean;
  expanded: boolean;
  onToggle: () => void;
  onClear: () => void;
}) {
  const kind = typeof a.payload?.alert_kind === 'string' ? a.payload.alert_kind : null;
  const label = (kind && FYI_LABELS[kind]) || 'Note';
  const bodyMd = typeof a.payload?.body_md === 'string' ? a.payload.body_md : null;
  const description = typeof a.payload?.description === 'string' ? a.payload.description : null;
  return (
    <div className="border border-minimal-border rounded-lg px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 border rounded-full text-[11px] font-medium border-minimal-border bg-minimal-row text-zinc-400">
              {label}
            </span>
            <span className="text-xs text-zinc-600">{timeAgo(a.created_at)}</span>
          </div>
          <p className="text-[13px] text-zinc-300 leading-snug mt-1.5">{a.title}</p>
          {a.summary && <p className="text-xs text-zinc-500 mt-0.5">{a.summary}</p>}
          {(bodyMd || description) && (
            <button
              onClick={onToggle}
              className="text-xs text-minimal-muted hover:text-white mt-1.5 underline underline-offset-2"
            >
              {expanded ? 'Hide' : 'Details'}
            </button>
          )}
          {expanded && (bodyMd || description) && (
            <div className="mt-2 border-t border-minimal-border pt-2 max-h-64 overflow-y-auto">
              <Markdown md={bodyMd || description || ''} />
            </div>
          )}
        </div>
        <GhostBtn onClick={onClear} disabled={deciding}>
          {deciding ? '…' : 'Clear'}
        </GhostBtn>
      </div>
    </div>
  );
}

function FeedRun({ run, defaultOpen }: { run: Run; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen && run.trigger === 'tick');
  const toolCalls = Array.isArray(run.tool_calls) ? run.tool_calls : [];

  return (
    <div className="border border-minimal-border rounded-lg p-4">
      <div className="flex items-center gap-2">
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            run.status === 'running'
              ? 'bg-yellow-500 animate-pulse'
              : run.status === 'failed'
                ? 'bg-red-500'
                : 'bg-green-500'
          }`}
        />
        <p className="text-[13px] font-medium text-zinc-300 truncate flex-1">
          {run.trigger === 'tick' ? 'Morning review' : run.summary || 'Chat'}
        </p>
        <span className="text-xs text-zinc-600 shrink-0">{timeAgo(run.created_at)}</span>
      </div>
      {run.error && <p className="text-xs text-red-400 mt-2">{run.error}</p>}
      {toolCalls.length > 0 && (
        <div className="mt-2.5 flex flex-col gap-1.5">
          {toolCalls.map((call, i) => (
            <div key={i} className="flex items-start gap-2.5 text-xs">
              <span className="text-minimal-muted w-3 text-center shrink-0 mt-px">
                {TOOL_ICONS[call.tool] || '·'}
              </span>
              <span className={call.ok ? 'text-zinc-400' : 'text-red-400'}>{call.summary}</span>
            </div>
          ))}
        </div>
      )}
      {run.trigger === 'tick' && run.report_md && (
        <div className="mt-3 border-t border-minimal-border pt-3">
          <button
            onClick={() => setOpen(!open)}
            className="text-xs text-minimal-muted hover:text-white underline underline-offset-2"
          >
            {open ? 'Hide report' : 'View report'}
          </button>
          {open && (
            <div className="mt-3">
              <Markdown md={run.report_md} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
