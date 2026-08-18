'use client';

/**
 * Automations — the screen the DM funnels never had.
 *
 * Three questions this page exists to answer without a database client:
 *   1. What will the account actually say to a stranger?  → the copy fields
 *   2. Is it switched on, and does "on" mean sending?     → status + safe mode
 *   3. Did anything happen, and if not, why?              → the activity feed
 *
 * The safe-mode banner is not decoration. A funnel marked Active while safe
 * mode is on receives messages, walks every branch, writes every row — and
 * sends nothing. Those two states are indistinguishable from inside Instagram,
 * so the page says it in words.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  api,
  EmptyState,
  Field,
  GhostBtn,
  Loading,
  PageHeader,
  PrimaryBtn,
  Select,
  TextArea,
  TextInput,
  timeAgo,
  useToast,
} from '@/components/crm/kit';

type Funnel = {
  id: string;
  name: string;
  keyword: string;
  status: 'draft' | 'active' | 'paused';
  trigger_source: 'comment' | 'dm' | 'both';
  public_comment_reply: string | null;
  opening_dm: string;
  welcome_dm: string | null;
  follow_prompt_dm: string | null;
  email_prompt_dm: string | null;
  delivery_dm: string;
  require_follow: boolean;
  ask_email: boolean;
  delivery_link: string | null;
  delivery_card_title: string | null;
  delivery_card_subtitle: string | null;
  delivery_card_image: string | null;
  delivery_button_label: string | null;
  in_flight: number;
  stat_triggered: number;
  stat_delivered: number;
  stat_emails_captured: number;
};

type Account = {
  username: string | null;
  status: string;
  dms_connected: boolean;
  dm_token_expires_at: string | null;
};

type Activity = { at: string; kind: string; label: string; detail: string | null; ok: boolean };

const KIND_ICON: Record<string, string> = {
  webhook: '↓',
  inbound: '💬',
  outbound: '↑',
  run: '◆',
};

export default function AutomationsPage() {
  const [funnels, setFunnels] = useState<Funnel[]>([]);
  const [safeMode, setSafeMode] = useState(true);
  const [account, setAccount] = useState<Account | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Funnel | null>(null);
  const [testText, setTestText] = useState('');
  const [testLog, setTestLog] = useState<{ direction: string; body: string }[]>([]);
  const [testing, setTesting] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const [f, a] = await Promise.all([
        api<{ funnels: Funnel[]; safe_mode: boolean; account: Account | null }>('/api/crm/automations'),
        api<{ items: Activity[] }>('/api/crm/automations/activity?limit=40'),
      ]);
      setFunnels(f.funnels);
      setSafeMode(f.safe_mode);
      setAccount(f.account);
      setActivity(a.items);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : 'Could not load automations');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  async function patch(id: string, changes: Partial<Funnel>, message: string) {
    try {
      await api('/api/crm/automations', {
        method: 'PATCH',
        body: JSON.stringify({ id, ...changes }),
      });
      toast.show(message);
      load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : 'Save failed');
    }
  }

  async function runTest(action?: 'reset') {
    setTesting(true);
    try {
      if (action === 'reset') {
        await api('/api/crm/automations/test', { method: 'POST', body: JSON.stringify({ action: 'reset' }) });
        setTestLog([]);
        toast.show('Test conversation cleared');
        return;
      }
      const res = await api<{ replies: { direction: string; body: string }[]; result: { note?: string } }>(
        '/api/crm/automations/test',
        { method: 'POST', body: JSON.stringify({ text: testText }) }
      );
      setTestLog((prev) => [...prev, ...res.replies]);
      setTestText('');
      if (!res.replies.some((r) => r.direction === 'outbound')) {
        // Silence in a test is a result, not a bug — but it needs saying,
        // otherwise it reads exactly like the request failed.
        toast.show(res.result?.note ? 'No reply — keyword matched nothing' : 'No reply generated');
      }
      load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : 'Test failed');
    } finally {
      setTesting(false);
    }
  }

  if (loading) return <Loading />;

  return (
    <div className="h-full flex flex-col">
      <PageHeader title="Automations">
        <GhostBtn onClick={load}>Refresh</GhostBtn>
      </PageHeader>

      <div className="flex-1 overflow-y-auto px-12 pb-16 flex flex-col gap-8">
        {/* ── Connection + sending state ───────────────────────────────── */}
        <div className="grid md:grid-cols-2 gap-4">
          <div className="border border-minimal-border rounded-lg p-5">
            <p className="text-[11px] uppercase tracking-[0.12em] text-zinc-600 mb-2">Instagram</p>
            {account?.dms_connected ? (
              <>
                <p className="text-[14px] text-white">@{account.username}</p>
                <p className="text-xs text-green-500 mt-1">DMs connected</p>
                {account.dm_token_expires_at && (
                  <p className="text-xs text-zinc-500 mt-1">
                    Access expires {new Date(account.dm_token_expires_at).toLocaleDateString()}
                  </p>
                )}
              </>
            ) : (
              <p className="text-[14px] text-yellow-500">Not connected — no DM will ever arrive</p>
            )}
          </div>

          <div
            className={`border rounded-lg p-5 ${
              safeMode ? 'border-yellow-500/20 bg-yellow-500/5' : 'border-green-500/20 bg-green-500/5'
            }`}
          >
            <p className="text-[11px] uppercase tracking-[0.12em] text-zinc-600 mb-2">Sending</p>
            <p className={`text-[14px] ${safeMode ? 'text-yellow-500' : 'text-green-500'}`}>
              {safeMode ? 'Safe mode — replies are written, never sent' : 'Live — replies really send'}
            </p>
            <p className="text-xs text-zinc-500 mt-1">
              {safeMode
                ? 'An Active funnel below will still reply to nobody until this is off.'
                : 'Anyone who sends a keyword gets a real reply.'}{' '}
              Change it in CRM → Setup.
            </p>
          </div>
        </div>

        {/* ── The funnels ──────────────────────────────────────────────── */}
        <section className="flex flex-col gap-4">
          <h2 className="text-[13px] font-semibold text-zinc-300">Keyword funnels</h2>

          {!funnels.length && <EmptyState title="No funnels yet" hint="Nothing is listening for keywords." />}

          {funnels.map((f) => (
            <div key={f.id} className="border border-minimal-border rounded-lg p-5 flex flex-col gap-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[15px] text-white">{f.name}</p>
                  <p className="text-xs text-zinc-500 mt-1">
                    Listens for{' '}
                    {f.keyword
                      .split(',')
                      .map((k) => k.trim())
                      .filter(Boolean)
                      .map((k, i) => (
                        <span key={k}>
                          {i > 0 && <span className="text-zinc-600"> / </span>}
                          <span className="text-zinc-300 font-mono">{k}</span>
                        </span>
                      ))}{' '}
                    in{' '}
                    {f.trigger_source === 'both' ? 'comments and DMs' : `${f.trigger_source}s`}
                    {f.in_flight > 0 && ` · ${f.in_flight} conversation${f.in_flight === 1 ? '' : 's'} in progress`}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={`text-xs px-2 py-1 rounded ${
                      f.status === 'active'
                        ? 'text-green-500 bg-green-500/10'
                        : f.status === 'paused'
                          ? 'text-yellow-500 bg-yellow-500/10'
                          : 'text-zinc-500 bg-zinc-500/10'
                    }`}
                  >
                    {f.status}
                  </span>
                  <GhostBtn
                    onClick={() =>
                      patch(
                        f.id,
                        { status: f.status === 'active' ? 'draft' : 'active' },
                        f.status === 'active' ? 'Back to draft — it will stop replying' : 'Live'
                      )
                    }
                  >
                    {f.status === 'active' ? 'Take offline' : 'Go live'}
                  </GhostBtn>
                  <GhostBtn onClick={() => setEditing(editing?.id === f.id ? null : f)}>
                    {editing?.id === f.id ? 'Close' : 'Edit replies'}
                  </GhostBtn>
                </div>
              </div>

              <div className="flex gap-6 text-xs text-zinc-500">
                <span>{f.stat_triggered} triggered</span>
                <span>{f.stat_delivered} delivered</span>
                <span>{f.stat_emails_captured} emails captured</span>
              </div>

              {editing?.id === f.id && (
                <div className="border-t border-minimal-border pt-4 flex flex-col gap-4">
                  <p className="text-xs text-zinc-500">
                    Every word below is said to a stranger in your name. <code>{'{{link}}'}</code> becomes the
                    delivery link; <code>{'{{first_name}}'}</code> their name if Instagram gives us one.
                  </p>

                  <div className="grid md:grid-cols-2 gap-4">
                    <Field
                      label="Words that set it off"
                      hint="Separate with commas. The first one is what leads get filed under."
                    >
                      <TextInput
                        defaultValue={editing.keyword}
                        onBlur={(e) => setEditing({ ...editing, keyword: e.target.value })}
                      />
                      <p className="text-xs text-zinc-500 mt-2">
                        Capitals and near-misses are already covered — <span className="font-mono">behind</span> also
                        catches <span className="font-mono">BEHIND</span>, <span className="font-mono">behinds</span>,{' '}
                        <span className="font-mono">behnid</span>, <span className="font-mono">behid</span>. Add
                        commas only for genuinely different words.
                      </p>
                    </Field>
                    <Field label="Triggers on">
                      <Select
                        defaultValue={editing.trigger_source}
                        onChange={(e) =>
                          setEditing({ ...editing, trigger_source: e.target.value as Funnel['trigger_source'] })
                        }
                      >
                        <option value="both">Comments and DMs</option>
                        <option value="comment">Comments only</option>
                        <option value="dm">DMs only</option>
                      </Select>
                    </Field>
                  </div>

                  <Field label="Public reply under their comment" hint="Everyone can see this one">
                    <TextInput
                      defaultValue={editing.public_comment_reply ?? ''}
                      onBlur={(e) => setEditing({ ...editing, public_comment_reply: e.target.value })}
                    />
                  </Field>

                  <Field label="First DM after a comment" hint="The private reply that opens the thread">
                    <TextArea
                      rows={4}
                      defaultValue={editing.opening_dm}
                      onBlur={(e) => setEditing({ ...editing, opening_dm: e.target.value })}
                    />
                  </Field>

                  <Field label="First DM after a direct message" hint="When they message you instead of commenting">
                    <TextArea
                      rows={3}
                      defaultValue={editing.welcome_dm ?? ''}
                      onBlur={(e) => setEditing({ ...editing, welcome_dm: e.target.value })}
                    />
                  </Field>

                  <Field label="Asking for their email">
                    <TextArea
                      rows={2}
                      defaultValue={editing.email_prompt_dm ?? ''}
                      onBlur={(e) => setEditing({ ...editing, email_prompt_dm: e.target.value })}
                    />
                  </Field>

                  <Field label="Delivering the thing">
                    <TextArea
                      rows={3}
                      defaultValue={editing.delivery_dm}
                      onBlur={(e) => setEditing({ ...editing, delivery_dm: e.target.value })}
                    />
                  </Field>

                  <Field label="Delivery link">
                    <TextInput
                      defaultValue={editing.delivery_link ?? ''}
                      onBlur={(e) => setEditing({ ...editing, delivery_link: e.target.value })}
                    />
                  </Field>

                  {/* The card. Filling in a headline changes the delivery from a
                      text message with a link in it — which Instagram draws as
                      a preview panel AND a raw URL, so the link looks sent
                      twice — into a single panel with a button. */}
                  <div className="rounded-lg border border-zinc-800 p-4 space-y-4">
                    <div>
                      <h3 className="text-[13px] font-semibold text-zinc-300">Send it as a card with a button</h3>
                      <p className="text-xs text-zinc-500 mt-1">
                        Leave the headline blank and the link goes out as plain text — which Instagram shows as a
                        picture <em>and</em> the raw web address underneath, so the same link appears twice. Fill it
                        in and they get one panel: image, headline, and a button. Nothing else changes.
                      </p>
                    </div>

                    <Field label="Headline on the card" hint="80 characters max — Instagram cuts it off after that.">
                      <TextInput
                        defaultValue={editing.delivery_card_title ?? ''}
                        onBlur={(e) => setEditing({ ...editing, delivery_card_title: e.target.value })}
                      />
                    </Field>

                    <Field label="Line under the headline" hint="Optional. 80 characters max.">
                      <TextInput
                        defaultValue={editing.delivery_card_subtitle ?? ''}
                        onBlur={(e) => setEditing({ ...editing, delivery_card_subtitle: e.target.value })}
                      />
                    </Field>

                    <Field
                      label="Picture on the card"
                      hint="A web address for the image. Instagram fetches it, so it has to be public."
                    >
                      <TextInput
                        defaultValue={editing.delivery_card_image ?? ''}
                        onBlur={(e) => setEditing({ ...editing, delivery_card_image: e.target.value })}
                      />
                    </Field>

                    <Field label="Words on the button" hint='Blank becomes "Read it".'>
                      <TextInput
                        defaultValue={editing.delivery_button_label ?? ''}
                        onBlur={(e) => setEditing({ ...editing, delivery_button_label: e.target.value })}
                      />
                    </Field>
                  </div>

                  <div className="flex gap-2">
                    <PrimaryBtn
                      onClick={() => {
                        const { id, in_flight, stat_triggered, stat_delivered, stat_emails_captured, ...rest } =
                          editing;
                        void in_flight;
                        void stat_triggered;
                        void stat_delivered;
                        void stat_emails_captured;
                        patch(id, rest, 'Replies saved');
                        setEditing(null);
                      }}
                    >
                      Save replies
                    </PrimaryBtn>
                    <GhostBtn onClick={() => setEditing(null)}>Cancel</GhostBtn>
                  </div>
                </div>
              )}
            </div>
          ))}
        </section>

        {/* ── Test without Instagram ───────────────────────────────────── */}
        <section className="border border-minimal-border rounded-lg p-5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold text-zinc-300">Try it</h2>
            <GhostBtn onClick={() => runTest('reset')}>Start over</GhostBtn>
          </div>
          <p className="text-xs text-zinc-500">
            Pretend to be someone messaging the account. This runs the real funnel and shows you the real replies —
            nothing is sent to Instagram, even when sending is live.
          </p>

          {testLog.length > 0 && (
            <div className="flex flex-col gap-2 py-2">
              {testLog.map((m, i) => (
                <div
                  key={i}
                  className={`text-[13px] px-3 py-2 rounded-lg max-w-[80%] whitespace-pre-wrap ${
                    m.direction === 'inbound'
                      ? 'bg-zinc-800 text-zinc-300 self-end'
                      : 'bg-minimal-bg border border-minimal-border text-white self-start'
                  }`}
                >
                  {m.body}
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <TextInput
              value={testText}
              placeholder="behind"
              onChange={(e) => setTestText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && testText.trim() && !testing) runTest();
              }}
            />
            <PrimaryBtn onClick={() => runTest()} disabled={testing || !testText.trim()}>
              {testing ? 'Running…' : 'Send'}
            </PrimaryBtn>
          </div>
        </section>

        {/* ── What actually happened ───────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <h2 className="text-[13px] font-semibold text-zinc-300">Recent activity</h2>
          {!activity.length && (
            <EmptyState title="Nothing yet" hint="Instagram has not called and no test has run." />
          )}
          <div className="flex flex-col">
            {activity.map((a, i) => (
              <div
                key={i}
                className="flex items-start gap-3 py-2.5 border-b border-minimal-border last:border-0"
              >
                <span className="text-zinc-600 text-xs w-4 shrink-0 pt-0.5">{KIND_ICON[a.kind] ?? '·'}</span>
                <div className="flex-1 min-w-0">
                  <p className={`text-[13px] ${a.ok ? 'text-zinc-300' : 'text-yellow-500'}`}>{a.label}</p>
                  {a.detail && <p className="text-xs text-zinc-600 mt-0.5 whitespace-pre-wrap">{a.detail}</p>}
                </div>
                <span className="text-xs text-zinc-600 shrink-0">{timeAgo(a.at)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
