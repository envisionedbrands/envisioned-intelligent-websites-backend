'use client';

/**
 * Desk panel — the chat surface that opens when a desk node is selected.
 * Shows the live context meter (what's wired, token estimate vs budget),
 * the SOP editor, and the conversation.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { StudioMarkdownEditor } from '@/components/studio/studio-markdown-editor';
import {
  CREATIVE_FORMATS,
  isCreativeFormatKey,
  type CreativeFormatKey,
} from '@/lib/studio/creative-formats';
import { HouseLookPreview } from '@/components/studio/house-look-preview';
import { HOUSE_LOOKS } from '@/lib/studio/house-looks';
import {
  CAROUSEL_CONFIG_ISSUE_MESSAGES,
  resolveCarouselConfig,
  type CarouselConfig,
} from '@/lib/studio/carousel-template-registry';
import {
  studioErrorMessage,
  studioFetchJson,
  studioFetchOk,
  studioFetchResponse,
  studioResponseError,
} from '@/lib/studio/fetch-json';
import { renderStudioMarkdown } from '@/lib/studio/markdown';
import { createLatestRequestGate } from '@/lib/studio/latest-request';
import { runAfterStudioSave } from '@/lib/studio/save-before-action';
import { MAX_STUDIO_CONTEXT_TEXT_CHARS } from '@/lib/studio/text-limits';
import type { SignedEmailCandidate } from '@/lib/studio/email-candidate';
import styles from './desk-panel.module.css';

type Message = { id?: string; role: 'user' | 'assistant'; content: string };
type MessageIds = { user: string; assistant: string };
type UnsavedReply = { boardId: string; nodeId: string; message: string; reply: string; messageIds: MessageIds };
type ChatResult = {
  reply?: string;
  context?: ContextStats;
  error?: string;
  saved?: boolean;
  warning?: string;
  message_ids?: MessageIds;
  desk_name?: string | null;
};
type ContextStats = {
  estTokens: number;
  budgetTokens: number;
  sops?: number;
  notes?: number;
  sopsTruncated?: boolean;
  notesTruncated?: boolean;
  sources: { id: string; title: string; platform: string; tokens: number; truncated: boolean }[];
  sopTexts?: string[];
};
type Desk = {
  id: string;
  name: string;
  persona: string;
  model: string;
  sop: string | null;
  settings?: { web_search?: boolean; creative_format?: string };
};

const replyRecoveryKey = (deskId: string) => `studio-desk-reply-recovery:${deskId}`;

const readReplyRecovery = (deskId: string): UnsavedReply[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(replyRecoveryKey(deskId)) ?? '[]') as UnsavedReply[];
    return Array.isArray(parsed)
      ? parsed.filter((item) =>
          item?.boardId && item.nodeId && item.message && item.reply && item.messageIds?.user && item.messageIds?.assistant
        )
      : [];
  } catch {
    return [];
  }
};

const writeReplyRecovery = (deskId: string, replies: UnsavedReply[]) => {
  try {
    if (replies.length) localStorage.setItem(replyRecoveryKey(deskId), JSON.stringify(replies));
    else localStorage.removeItem(replyRecoveryKey(deskId));
  } catch {
    // The paid reply remains visible in this panel even if hardened/private
    // browser storage is unavailable.
  }
};

// Content pillars are the brand's own — free-form here, matching the
// calendar's nullable pillar_topic. Desk SOPs teach pillar discipline.

// Role presets (§12): research runs deep-context Gemini, writing stays on the
// house Claude (direct — no OpenRouter margin), mechanical work rides a
// flash-class model. Anything with a "/" routes via the member's own
// OpenRouter key; without one it falls back to the house Claude.
const MODEL_PRESETS: { value: string; label: string }[] = [
  { value: 'claude-sonnet-4-6', label: 'Claude · writing (house default)' },
  { value: 'google/gemini-2.5-pro', label: 'Gemini Pro · research' },
  { value: 'google/gemini-2.5-flash', label: 'Gemini Flash · mechanical' },
];

// Starter chips (Poppy's quick actions): one click drops a proven prompt into
// the composer. Each pairs with a Send-to lane the desk already has — hooks
// and breakdowns feed writing, thumbnails feed the gen lane, carousels the
// configured Studio renderer, topics the calendar, emails the broadcast rail.
const STARTER_CHIPS: { label: string; prompt: string }[] = [
  {
    label: 'Hooks',
    prompt:
      'Write 10 scroll-stopping hooks from the wired sources — mix curiosity, contrarian, and outcome-led angles. Number them.',
  },
  {
    label: 'Thumbnail concepts',
    prompt:
      'Give me 3 thumbnail concepts for the wired content. For each: the full visual composition, the exact on-image text (4 words max), and the emotion it should trigger.',
  },
  {
    label: 'Carousel',
    prompt:
      'Draft an exactly 10-slide carousel from the wired context — slide by slide, a scroll-stopping hook on slide 1, one idea per slide, and a CTA on slide 10.',
  },
  {
    label: 'Article angles',
    prompt:
      'Propose 3 article topics grounded in the wired sources. For each: a working title, the target keyword, and the angle that makes it ours.',
  },
  {
    label: 'Email',
    prompt:
      'Write a newsletter email from the wired context in our voice — 3 subject line options first, then the body with one clear CTA.',
  },
  {
    label: 'Why it worked',
    prompt:
      'Break down why the wired sources worked: hooks, structure beats, retention devices. Then list exactly what we should steal for our next piece.',
  },
];

type OutputDraft = { type: 'calendar_topic' | 'carousel_job' | 'gen' | 'email_batch'; message: string };
type CarouselConfigState = CarouselConfig;

export function DeskPanel({
  deskId,
  boardId,
  nodeId,
  graphVersion,
  contextReady,
  beforeSend,
  onClose,
  onOutputCreated,
  onSaveNote,
  onReplied,
  onGenQueued,
  handoffTargets,
  onHandoff,
  initialInput,
  onBusyChange,
  onRenamed,
  imageGenerationIssue,
  carouselGenerationIssue,
}: {
  deskId: string;
  boardId: string;
  nodeId: string;
  graphVersion: number;
  contextReady: boolean;
  beforeSend?: () => Promise<boolean>;
  onClose: () => void;
  onOutputCreated?: (output: { output_type: string; ref_id: string; title?: string }) => void;
  onSaveNote?: (content: string) => void;
  onReplied?: (text: string) => void;
  onGenQueued?: (job: { id: string; count?: number; prompt?: string; asset_type?: string; image_size?: unknown }) => void;
  handoffTargets?: { deskId: string; nodeId: string; name: string }[];
  onHandoff?: (content: string, target: { deskId: string; nodeId: string; name: string }) => void;
  initialInput?: string;
  onBusyChange?: (busy: boolean) => void;
  onRenamed?: (name: string) => void;
  imageGenerationIssue?: string | null;
  carouselGenerationIssue?: string | null;
}) {
  const [desk, setDesk] = useState<Desk | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [context, setContext] = useState<ContextStats | null>(null);
  const [input, setInput] = useState(initialInput ?? '');
  const [sop, setSop] = useState('');
  const [showSop, setShowSop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [unsavedReplies, setUnsavedReplies] = useState<UnsavedReply[]>([]);
  const [draft, setDraft] = useState<OutputDraft | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  // Fullscreen output editing: a reply expands to a big editor; the edited
  // text can be copied or filed to the board as a note.
  const [expanded, setExpanded] = useState<{ draft: string; editing: boolean } | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftKeyword, setDraftKeyword] = useState('');
  const [draftPillar, setDraftPillar] = useState('');
  const [genMode, setGenMode] = useState<'reference' | 'fresh'>('reference');
  const [genCount, setGenCount] = useState(1);
  const [genSplit, setGenSplit] = useState(true);
  const [genFormat, setGenFormat] = useState<CreativeFormatKey>('match_reference');
  const [genWidth, setGenWidth] = useState(1280);
  const [genHeight, setGenHeight] = useState(720);
  const [emailAudience, setEmailAudience] = useState<'all' | 'tag'>('all');
  const [emailTags, setEmailTags] = useState<string[]>([]);
  const [tagList, setTagList] = useState<{ name: string; count: number }[]>([]);
  const [tagLoadState, setTagLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [tagLoadError, setTagLoadError] = useState<string | null>(null);
  const [scheduleAt, setScheduleAt] = useState('');
  const [emailOperationId, setEmailOperationId] = useState('');
  const [testedEmailCandidate, setTestedEmailCandidate] = useState<SignedEmailCandidate | null>(null);
  const [testState, setTestState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const [testWarnings, setTestWarnings] = useState<string[]>([]);
  const [testError, setTestError] = useState<string | null>(null);
  const [filing, setFiling] = useState(false);
  const [filingError, setFilingError] = useState<string | null>(null);
  const [openrouter, setOpenrouter] = useState(false);
  const [carouselConfig, setCarouselConfig] = useState<CarouselConfigState | null>(null);
  const [sendMenuFor, setSendMenuFor] = useState<number | null>(null);
  const [sendMenuUp, setSendMenuUp] = useState(true);
  const [panelW, setPanelW] = useState(() => {
    if (typeof window === 'undefined') return 420;
    return Math.min(760, Math.max(360, Number(localStorage.getItem('studio-desk-w')) || 420));
  });
  const panelWRef = useRef(panelW);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contextRequestGateRef = useRef(createLatestRequestGate());
  const contextAbortRef = useRef<AbortController | null>(null);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWRef.current;
    const move = (ev: MouseEvent) => {
      const w = Math.min(760, Math.max(360, startW + (startX - ev.clientX)));
      panelWRef.current = w;
      setPanelW(w);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      localStorage.setItem('studio-desk-w', String(panelWRef.current));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  useEffect(() => {
    let alive = true;
    studioFetchJson<{ desk?: Desk; messages?: Message[]; openrouter?: boolean }>(`/api/studio/desks/${deskId}`)
      .then((j) => {
        if (!alive || !j.desk) return;
        setDesk(j.desk);
        setSop(j.desk.sop ?? '');
        const serverMessages = j.messages ?? [];
        const serverIds = new Set(serverMessages.map((message) => message.id).filter(Boolean));
        const recovered = readReplyRecovery(deskId).filter(
          (item) => item.boardId === boardId && item.nodeId === nodeId && !serverIds.has(item.messageIds.assistant)
        );
        setMessages([
          ...serverMessages,
          ...recovered.flatMap((item) => [
            { id: item.messageIds.user, role: 'user' as const, content: item.message },
            { id: item.messageIds.assistant, role: 'assistant' as const, content: item.reply },
          ]),
        ]);
        setUnsavedReplies(recovered);
        writeReplyRecovery(deskId, recovered);
        setOpenrouter(Boolean(j.openrouter));
      })
      .catch((e) => setError(studioErrorMessage(e, 'Could not open this desk.')));
    return () => {
      alive = false;
    };
  }, [boardId, deskId, nodeId]);

  const refreshCarouselConfig = useCallback(() => {
    studioFetchJson<{ config?: CarouselConfigState }>('/api/studio/carousel-config')
      .then((j) => {
        if (j?.config) setCarouselConfig(j.config);
      })
      .catch(() => {
        setCarouselConfig(resolveCarouselConfig({ factoryEnabled: false, unavailable: true }));
      });
  }, []);

  // Buzz owns the guided choice; Studio always shows the shared result.
  useEffect(refreshCarouselConfig, [refreshCarouselConfig]);
  useEffect(() => {
    if (draft?.type === 'carousel_job') refreshCarouselConfig();
  }, [draft?.type, refreshCarouselConfig]);

  const refreshContext = useCallback(() => {
    contextAbortRef.current?.abort();
    const requestId = contextRequestGateRef.current.begin();
    if (!contextReady) return;
    const controller = new AbortController();
    contextAbortRef.current = controller;
    studioFetchJson<ContextStats>(`/api/studio/desks/${deskId}/chat?board_id=${boardId}&node_id=${nodeId}`, {
      signal: controller.signal,
    })
      .then((j) => {
        if (!contextRequestGateRef.current.isLatest(requestId)) return;
        if (j.budgetTokens) setContext(j);
        setContextError(null);
      })
      .catch((e) => {
        if (!contextRequestGateRef.current.isLatest(requestId) || controller.signal.aborted) return;
        setContextError(studioErrorMessage(e, 'The desk could not verify its saved wiring.'));
      });
  }, [contextReady, deskId, boardId, nodeId]);

  useEffect(() => {
    const requestGate = contextRequestGateRef.current;
    refreshContext();
    return () => {
      contextAbortRef.current?.abort();
      requestGate.invalidate();
    };
  }, [refreshContext, graphVersion]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, busy]);

  const send = async (preset?: string) => {
    const message = (preset ?? input).trim();
    if (!message || busy) return;
    setMentionOpen(false);
    setError(null);
    setBusy(true);
    onBusyChange?.(true);
    try {
      const { res, messageIds } = await runAfterStudioSave(beforeSend, async () => {
        const messageIds = { user: crypto.randomUUID(), assistant: crypto.randomUUID() };
        setInput('');
        setMessages((m) => [...m, { id: messageIds.user, role: 'user', content: message }]);
        // Ask for the heartbeat stream: long research runs (web search) go
        // minutes between bytes otherwise and get severed at the edge.
        const res = await studioFetchResponse(`/api/studio/desks/${deskId}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
          body: JSON.stringify({ board_id: boardId, node_id: nodeId, message, message_ids: messageIds }),
        });
        return { res, messageIds };
      });
      if (!res.ok) throw await studioResponseError(res);
      let j: ChatResult;
      if ((res.headers.get('content-type') ?? '').includes('application/x-ndjson') && res.body) {
        // NDJSON heartbeat stream: ignore pings, act on the final done/error line.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let final: (ChatResult & { type: string }) | null = null;
        for (;;) {
          const { done, value } = await reader.read();
          if (value) buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = done ? '' : (lines.pop() ?? '');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const evt = JSON.parse(line);
              if (evt.type === 'done' || evt.type === 'error') final = evt;
            } catch {
              // partial/garbled line — skip
            }
          }
          if (done) break;
        }
        if (!final) throw new Error('The connection dropped before the desk finished. Try again.');
        if (final.type === 'error') throw new Error(final.error || 'Desk call failed');
        j = final;
      } else {
        const raw = await res.text();
        try {
          j = JSON.parse(raw);
        } catch {
          throw new Error(
            'The desk run was interrupted before a reply arrived. Try again.',
          );
        }
      }
      if (!j.reply) throw new Error('Desk returned no reply');
      const reply = j.reply;
      const responseIds = j.message_ids ?? messageIds;
      setMessages((m) => [...m, { id: responseIds.assistant, role: 'assistant', content: reply }]);
      onReplied?.(reply);
      if (j.context) setContext((c) => (c ? { ...c, ...j.context } : (j.context as ContextStats)));
      if (j.desk_name) {
        setDesk((current) => current ? { ...current, name: j.desk_name! } : current);
        onRenamed?.(j.desk_name);
      }
      if (j.saved === false) {
        const unsaved: UnsavedReply = { boardId, nodeId, message, reply, messageIds: responseIds };
        setUnsavedReplies((current) => {
          const next = [...current.filter((item) => item.messageIds.assistant !== responseIds.assistant), unsaved];
          writeReplyRecovery(deskId, next);
          return next;
        });
      }
    } catch (e) {
      setError(studioErrorMessage(e, 'The desk could not finish that reply.'));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  const retryUnsavedReply = async (unsaved: UnsavedReply) => {
    try {
      const result = await studioFetchJson<{ saved?: boolean }>(`/api/studio/desks/${deskId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'persist_reply',
          board_id: unsaved.boardId,
          node_id: unsaved.nodeId,
          message: unsaved.message,
          reply: unsaved.reply,
          message_ids: unsaved.messageIds,
        }),
      });
      if (!result.saved) throw new Error('The server did not confirm the recovered reply.');
      setUnsavedReplies((current) => {
        const next = current.filter((item) => item.messageIds.assistant !== unsaved.messageIds.assistant);
        writeReplyRecovery(deskId, next);
        return next;
      });
      setError(null);
    } catch (e) {
      setError(studioErrorMessage(e, 'The reply is still safe here, but its history could not be saved yet.'));
    }
  };

  const expandedOpen = expanded !== null;
  useEffect(() => {
    if (!expandedOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [expandedOpen]);

  const saveRename = async () => {
    setRenaming(false);
    const name = nameDraft.trim();
    if (!desk || !name || name === desk.name) return;
    try {
      await studioFetchOk(`/api/studio/desks/${deskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      setDesk({ ...desk, name });
      onRenamed?.(name);
    } catch (e) {
      setError(studioErrorMessage(e, 'Could not rename this desk.'));
    }
  };

  const saveSop = async () => {
    if (!desk || sop === (desk.sop ?? '')) return;
    try {
      await studioFetchOk(`/api/studio/desks/${deskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sop }),
      });
      setDesk({ ...desk, sop });
      refreshContext();
    } catch (e) {
      setError(studioErrorMessage(e, 'Could not save the desk instructions.'));
    }
  };

  const pct = context ? Math.min(100, Math.round((context.estTokens / context.budgetTokens) * 100)) : 0;

  const openGeneration = (message: string) => {
    if (imageGenerationIssue) {
      setError(imageGenerationIssue);
      return;
    }
    const configured = desk?.settings?.creative_format;
    const preferred = isCreativeFormatKey(configured)
      ? configured
      : /packaging|thumbnail/i.test(desk?.name ?? '')
        ? 'youtube_thumbnail'
        : 'match_reference';
    setGenFormat(preferred);
    setDraft({ type: 'gen', message });
  };

  return (
    <aside
      className="relative shrink-0 border-l border-minimal-border bg-minimal-bg flex flex-col h-full"
      style={{ width: panelW }}
    >
      <div
        onMouseDown={startResize}
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-white/20 z-10"
        aria-label="Resize panel"
      />
      <header className="px-4 py-3 border-b border-minimal-border flex items-center gap-2">
        <div className="min-w-0">
          {renaming ? (
            <input
              autoFocus
              className="w-full rounded border border-minimal-border bg-minimal-row px-1.5 py-0.5 text-sm font-medium focus:outline-none focus:border-white/40"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={saveRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveRename();
                if (e.key === 'Escape') setRenaming(false);
              }}
            />
          ) : (
            <button
              type="button"
              className="text-sm font-medium text-left hover:underline decoration-dotted underline-offset-4"
              title="Rename this desk"
              onClick={() => {
                if (!desk) return;
                setNameDraft(desk.name);
                setRenaming(true);
              }}
            >
              {desk?.name ?? '…'}
            </button>
          )}
          <div className="text-[11px] text-minimal-muted flex items-center gap-2 flex-wrap">
            {desk && (
              <select
                className="nodrag max-w-[220px] rounded border border-minimal-border bg-minimal-bg px-1 py-0.5 text-[11px] focus:outline-none"
                value={MODEL_PRESETS.some((m) => m.value === desk.model) ? desk.model : '__custom'}
                aria-label="Desk model"
                onChange={async (e) => {
                  let model = e.target.value;
                  if (model === '__custom') {
                    const entered = window.prompt(
                      'OpenRouter model id (vendor/model, e.g. openai/gpt-5.2). Runs on your own OpenRouter key.',
                      desk.model.includes('/') ? desk.model : ''
                    );
                    if (!entered?.trim()) return;
                    model = entered.trim();
                  }
                  const prev = desk.model;
                  setDesk({ ...desk, model });
                  try {
                    await studioFetchOk(`/api/studio/desks/${deskId}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ model }),
                    });
                  } catch (e) {
                    setDesk((d) => (d ? { ...d, model: prev } : d));
                    setError(studioErrorMessage(e, 'Could not change the desk model.'));
                  }
                }}
              >
                {MODEL_PRESETS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
                {!MODEL_PRESETS.some((m) => m.value === desk.model) && (
                  <option value="__custom">{desk.model}</option>
                )}
                {MODEL_PRESETS.some((m) => m.value === desk.model) && <option value="__custom">Custom model…</option>}
              </select>
            )}
            {desk?.settings?.web_search && <span className="text-emerald-500">· web search on</span>}
            {carouselConfig?.ready && carouselConfig.house_look && (
              <span className="rounded border border-minimal-border px-1.5 py-0.5">
                {carouselConfig.renderer === 'factory' ? 'Factory' : 'House look'} · {HOUSE_LOOKS[carouselConfig.house_look].label}
              </span>
            )}
            {carouselConfig?.issue && (
              <span
                className="rounded border border-amber-500/50 px-1.5 py-0.5 text-amber-500"
                title={CAROUSEL_CONFIG_ISSUE_MESSAGES[carouselConfig.issue]}
              >
                Carousel setup needs attention
              </span>
            )}
          </div>
          {desk?.model.includes('/') && !openrouter && (
            <div className="mt-1 text-[10px] text-amber-500">
              No OpenRouter key in the backend env — this desk answers with the house Claude until one is added.
            </div>
          )}
        </div>
        <button onClick={onClose} className="ml-auto text-minimal-muted hover:text-minimal-accent text-sm px-2" aria-label="Close desk panel">
          ✕
        </button>
      </header>

      {/* Context meter */}
      <div className="px-4 py-3 border-b border-minimal-border">
        <div className="flex items-center justify-between text-[11px] text-minimal-muted">
          <span>
            <button
              type="button"
              className="hover:text-minimal-accent"
              title="Show exactly what this desk knows"
              onClick={() => setShowContext((v) => !v)}
            >
              {showContext ? '▾' : '▸'} Context:{' '}
              {context
                ? `${context.sources.length} sources · ${context.sops ?? 0} instructions · ${context.notes ?? 0} notes`
                : '…'}
            </button>
          </span>
          <span className={pct > 90 ? 'text-amber-500' : ''}>
            {context ? `${(context.estTokens / 1000).toFixed(1)}k / ${(context.budgetTokens / 1000).toFixed(0)}k tokens` : ''}
          </span>
        </div>
        <div className="mt-1.5 h-1 rounded bg-minimal-border overflow-hidden">
          <div className={`h-full ${pct > 90 ? 'bg-amber-500' : 'bg-white/70'}`} style={{ width: `${pct}%` }} />
        </div>
        {context?.sources.some((s) => s.truncated) && (
          <div className="mt-1 text-[11px] text-amber-500">Some transcripts truncated to fit the budget.</div>
        )}
        {(context?.sopsTruncated || context?.notesTruncated) && (
          <div className="mt-1 text-[11px] text-amber-500">
            {context.sopsTruncated && context.notesTruncated
              ? 'Some instructions and notes were trimmed to fit the budget.'
              : context.sopsTruncated
                ? 'Some instructions were trimmed to fit the budget.'
                : 'Some notes were trimmed to fit the budget.'}
          </div>
        )}
        {showContext && context && (
          <div className="mt-2 space-y-1 rounded border border-minimal-border bg-minimal-row p-2">
            {context.sources.length === 0 && (
              <div className="text-[11px] text-minimal-muted">
                Nothing wired in yet — drag a wire from a source, note, or collection into this desk on the canvas.
              </div>
            )}
            {context.sources.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-[11px]">
                <span className="shrink-0 text-[9px] uppercase tracking-wide text-minimal-muted">{s.platform}</span>
                <span className="truncate">{s.title}</span>
                <span className={`ml-auto shrink-0 ${s.truncated ? 'text-amber-500' : 'text-minimal-muted'}`}>
                  {s.truncated && s.tokens === 0 ? 'over budget' : `${(s.tokens / 1000).toFixed(1)}k tok${s.truncated ? ' · trimmed' : ''}`}
                </span>
              </div>
            ))}
          </div>
        )}
        <button onClick={() => setShowSop((v) => !v)} className="mt-2 text-[11px] text-minimal-muted hover:text-minimal-accent">
          {showSop ? '▾ Hide desk instructions' : '▸ Desk instructions'}
        </button>
        {showSop && (
          <>
            <textarea
              className="mt-2 w-full h-28 rounded border border-minimal-border bg-minimal-row p-2 text-[12px] leading-relaxed focus:outline-none focus:border-white/40"
              placeholder="This desk's own standing rules — its job description, baked into every message…"
              value={sop}
              maxLength={sop.length > MAX_STUDIO_CONTEXT_TEXT_CHARS ? undefined : MAX_STUDIO_CONTEXT_TEXT_CHARS}
              onChange={(e) => {
                // Do not slice a grandfathered value on load. Like legacy
                // canvas cards, it remains byte-identical until the member
                // replaces it with text that fits today's input boundary.
                if (e.target.value.length > MAX_STUDIO_CONTEXT_TEXT_CHARS) return;
                setSop(e.target.value);
              }}
              onBlur={saveSop}
            />
            {/* Canvas-wired Instructions cards merge into the same rulebook —
                shown here read-only so the two sources visibly speak. */}
            {(context?.sopTexts?.length ?? 0) > 0 &&
              context!.sopTexts!.map((text, i) => (
                <div key={i} className="mt-2 rounded border border-amber-300/50 bg-amber-500/5 p-2 dark:border-amber-900">
                  <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-500">
                    Instructions card wired on the canvas
                    <span className="ml-auto normal-case tracking-normal text-minimal-muted">edit it on the board</span>
                  </div>
                  <div className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-minimal-muted line-clamp-6">{text}</div>
                </div>
              ))}
            {(context?.sopTexts?.length ?? 0) === 0 && (
              <div className="mt-1.5 text-[11px] text-minimal-muted">
                Tip: an Instructions card wired into this desk on the canvas also lands here — use a card to share one
                rulebook across several desks.
              </div>
            )}
          </>
        )}
      </div>

      {/* Conversation */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && !busy && (
          <div className="pt-6 text-center">
            <div className="text-[12px] text-minimal-muted">
              This desk works when you ask. Everything wired in on the canvas is loaded automatically —
              click <span className="text-minimal-accent">Context</span> above to see exactly what it knows.
            </div>
            {desk?.sop && (
              <button
                className="mt-3 rounded bg-minimal-accent text-minimal-bg text-[12px] px-4 py-1.5 font-medium"
                onClick={() => send('Run your SOP against everything wired into this desk.')}
              >
                ▶ Do your job
              </button>
            )}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={m.id ?? i} className={m.role === 'user' ? 'text-right' : ''}>
            {m.role === 'user' ? (
              <div className="inline-block max-w-[92%] text-left rounded-lg px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap bg-white/10">
                {m.content.split(/(@"[^"]+")/g).map((seg, si) =>
                  /^@"[^"]+"$/.test(seg) ? (
                    <span key={si} className="rounded-[4px] bg-indigo-500/20 px-0.5 text-indigo-700 dark:bg-indigo-400/25 dark:text-indigo-300">
                      {seg.slice(2, -1)}
                    </span>
                  ) : (
                    <span key={si}>{seg}</span>
                  )
                )}
              </div>
            ) : (
              <div className="max-w-[95%] rounded-lg px-3.5 py-2.5 bg-minimal-row border border-minimal-border">
                <div
                  className={`${styles.markdown} agent-md text-[13px] leading-relaxed`}
                  dangerouslySetInnerHTML={{ __html: renderStudioMarkdown(m.content, { breaks: true }) }}
                />
              </div>
            )}
            {m.role === 'assistant' && (
              <div className="relative flex flex-wrap gap-2 mt-2">
                <button
                  className="rounded border border-minimal-border px-2.5 py-1 text-[11px] text-minimal-muted hover:text-minimal-accent hover:bg-white/5"
                  onClick={() => navigator.clipboard.writeText(m.content)}
                >
                  Copy
                </button>
                <button
                  className="rounded border border-minimal-border px-2.5 py-1 text-[11px] text-minimal-muted hover:text-minimal-accent hover:bg-white/5"
                  title="Open fullscreen to read and edit"
                  onClick={() => setExpanded({ draft: m.content, editing: false })}
                >
                  ⛶ Expand
                </button>
                <button
                  className="rounded border border-fuchsia-400 px-2.5 py-1 text-[11px] text-fuchsia-700 hover:bg-fuchsia-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-fuchsia-900 dark:text-fuchsia-300 dark:hover:bg-fuchsia-950/40"
                  disabled={Boolean(imageGenerationIssue)}
                  title={imageGenerationIssue ?? 'Generate an image from this reply'}
                  onClick={() => openGeneration(m.content)}
                >
                  🎨 Generate image
                </button>
                <button
                  className="rounded border border-indigo-400 px-2.5 py-1 text-[11px] text-indigo-700 hover:bg-indigo-100 dark:border-indigo-900 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
                  onClick={(e) => {
                    // Open upward when the row sits near the bottom of the
                    // viewport (the usual case) so nothing hides below the fold.
                    setSendMenuUp(window.innerHeight - e.currentTarget.getBoundingClientRect().bottom < 280);
                    setSendMenuFor(sendMenuFor === i ? null : i);
                  }}
                >
                  Send to {sendMenuFor === i ? '▴' : '▾'}
                </button>
                {sendMenuFor === i && (
                  <div className="fixed inset-0 z-10" onClick={() => setSendMenuFor(null)} />
                )}
                {sendMenuFor === i && (
                  <div
                    className={`absolute z-20 left-0 w-60 rounded-lg border border-minimal-border bg-minimal-row shadow-xl p-1 ${
                      sendMenuUp ? 'bottom-8' : 'top-8'
                    }`}
                  >
                    {[
                      ...(handoffTargets ?? []).map((t) => ({
                        label: `↳ ${t.name}`,
                        run: () => onHandoff?.(m.content, t),
                      })),
                      { label: '⤷ Board note', run: () => onSaveNote?.(m.content) },
                      {
                        label: '⤷ Calendar topic…',
                        run: () => {
                          setDraft({ type: 'calendar_topic', message: m.content });
                          setDraftTitle('');
                          setDraftKeyword('');
                        },
                      },
                      { label: '⤷ Carousel…', run: () => setDraft({ type: 'carousel_job', message: m.content }) },
                      {
                        label: '⤷ Email to list…',
                        run: () => {
                          setDraft({ type: 'email_batch', message: m.content });
                          setDraftTitle('');
                          setScheduleAt('');
                          setEmailAudience('all');
                          setEmailTags([]);
                          setEmailOperationId(crypto.randomUUID());
                          setTestedEmailCandidate(null);
                          setTestState('idle');
                          setTestError(null);
                          setFilingError(null);
                          setTagLoadState('loading');
                          setTagLoadError(null);
                          studioFetchJson<{ tags?: { name: string; count: number }[] }>('/api/crm/tags')
                            .then((j) => {
                              setTagList(j.tags ?? []);
                              setTagLoadState('ready');
                            })
                            .catch((e) => {
                              setTagList([]);
                              setTagLoadState('error');
                              setTagLoadError(studioErrorMessage(e, 'Could not load audience tags.'));
                            });
                        },
                      },
                    ].map((item) => (
                      <button
                        key={item.label}
                        className="w-full text-left rounded px-2.5 py-1.5 text-[12px] hover:bg-white/5"
                        onClick={() => {
                          setSendMenuFor(null);
                          item.run();
                        }}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="text-[12px] text-minimal-muted animate-pulse">The desk is writing…</div>}
        {unsavedReplies.length > 0 && (
          <div className="flex items-center gap-2 rounded border border-amber-500/40 bg-amber-500/5 px-2.5 py-2 text-[12px] text-amber-600 dark:text-amber-400">
            <span className="flex-1">
              {unsavedReplies.length === 1 ? 'This reply' : `${unsavedReplies.length} replies`} stayed visible, but the chat history still needs saving.
            </span>
            <button
              type="button"
              className="shrink-0 rounded border border-amber-500/50 px-2 py-1 font-medium hover:bg-amber-500/10"
              onClick={() => void retryUnsavedReply(unsavedReplies[0])}
            >
              Retry saving
            </button>
          </div>
        )}
        {!contextReady && (
          <div className="text-[12px] text-minimal-muted">Saving this desk to the board…</div>
        )}
        {contextError && <div className="text-[12px] text-red-500">{contextError}</div>}
        {error && <div className="text-[12px] text-red-500">{error}</div>}
      </div>

      {/* Output filing dialog — a centered modal, same language as review */}
      {draft && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/60" onClick={() => setDraft(null)}>
          <div
            className="w-[520px] max-w-[92vw] rounded-xl border border-minimal-border bg-minimal-bg shadow-2xl p-5"
            onClick={(e) => e.stopPropagation()}
          >
          {draft.type === 'email_batch' ? (
            <div className="space-y-4">
              <div>
                <div className="text-[14px] font-medium">Send this email to your list</div>
                <div className="text-[12px] text-minimal-muted mt-1">
                  Claude extracts the final subject and body from this reply. Nothing sends until you approve the
                  broadcast on the board — delivery then runs through the CRM engine&apos;s send windows, daily budget,
                  and suppression rules.
                </div>
              </div>

              <div className="flex items-center gap-3 rounded-lg border border-minimal-border bg-minimal-row p-3">
                <div className="flex-1 text-[12px]">
                  <div className="font-medium">Test it first</div>
                  <div className="text-minimal-muted">Exact rendering, live links — to your inbox only.</div>
                </div>
                <button
                  disabled={testState === 'sending'}
                  onClick={async () => {
                    setTestState('sending');
                    setTestedEmailCandidate(null);
                    setTestWarnings([]);
                    setTestError(null);
                    try {
                      const j = await studioFetchJson<{ warnings?: string[]; candidate?: SignedEmailCandidate }>('/api/studio/outputs', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          type: 'email_test',
                          payload: { message: draft.message, subject: draftTitle.trim() || undefined },
                        }),
                      });
                      if (!j.candidate) throw new Error('The tested email did not return an exact queue receipt.');
                      // Every successful test starts a fresh queue operation so
                      // a lost response from an older candidate cannot win.
                      setEmailOperationId(crypto.randomUUID());
                      setTestedEmailCandidate(j.candidate);
                      setTestState('sent');
                      if (Array.isArray(j.warnings)) setTestWarnings(j.warnings);
                    } catch (e) {
                      setTestState('failed');
                      setTestError(studioErrorMessage(e, 'The test email could not be prepared.'));
                    }
                  }}
                  className="rounded border border-minimal-border px-3 py-1.5 text-[12px] hover:bg-white/5 disabled:opacity-40"
                >
                  {testState === 'sending' ? 'Sending…' : testState === 'sent' ? '✓ Sent — check your inbox' : testState === 'failed' ? 'Failed — retry' : 'Send me a test'}
                </button>
              </div>
              {testError && (
                <div role="alert" className="rounded-lg border border-red-400 bg-red-50 p-3 text-[12px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">
                  {testError}
                </div>
              )}
              {testWarnings.length > 0 && (
                <div className="rounded-lg border border-amber-400 bg-amber-100 p-3 text-[12px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-400 space-y-1">
                  {testWarnings.map((w) => (
                    <div key={w}>⚠ {w}</div>
                  ))}
                  <div className="text-amber-700 dark:text-amber-500/80">
                    Fix it in the conversation (tell the desk which link to use), then re-open Send to → Email.
                  </div>
                </div>
              )}

              <div>
                <div className="text-[11px] uppercase tracking-wide text-minimal-muted mb-1.5">Audience</div>
                <select
                  className="w-full rounded border border-minimal-border bg-minimal-bg p-2 text-[12px] focus:outline-none"
                  value={emailAudience}
                  onChange={(e) => {
                    setEmailAudience(e.target.value as 'all' | 'tag');
                    setEmailOperationId(crypto.randomUUID());
                    setFilingError(null);
                  }}
                  aria-label="Audience"
                >
                  <option value="all">All subscribed leads</option>
                  <option value="tag">Leads with tags…</option>
                </select>
                {emailAudience === 'tag' && (
                  <div className="mt-2 max-h-36 overflow-y-auto rounded border border-minimal-border bg-minimal-row p-2 space-y-1">
                    {tagLoadState === 'loading' && <div className="text-[12px] text-minimal-muted">Loading tags…</div>}
                    {tagLoadState === 'error' && <div role="alert" className="text-[12px] text-red-500">{tagLoadError}</div>}
                    {tagLoadState === 'ready' && tagList.length === 0 && (
                      <div className="text-[12px] text-minimal-muted">No audience tags exist yet.</div>
                    )}
                    {tagList.map((t) => (
                      <label key={t.name} className="flex items-center gap-2 text-[12px] cursor-pointer">
                        <input
                          type="checkbox"
                          checked={emailTags.includes(t.name)}
                          onChange={(e) => {
                            setEmailTags((prev) => (e.target.checked ? [...prev, t.name] : prev.filter((x) => x !== t.name)));
                            setEmailOperationId(crypto.randomUUID());
                            setFilingError(null);
                          }}
                        />
                        <span>{t.name}</span>
                        <span className="ml-auto text-minimal-muted">{t.count}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <div className="text-[11px] uppercase tracking-wide text-minimal-muted mb-1.5">Schedule (optional)</div>
                <input
                  type="datetime-local"
                  className="w-full rounded border border-minimal-border bg-minimal-bg p-2 text-[12px] focus:outline-none focus:border-white/40"
                  value={scheduleAt}
                  onChange={(e) => {
                    setScheduleAt(e.target.value);
                    setEmailOperationId(crypto.randomUUID());
                    setFilingError(null);
                  }}
                  aria-label="Schedule send time"
                />
                <div className="text-[11px] text-minimal-muted mt-1">Blank = sends after approval, inside the engine&apos;s send window.</div>
              </div>

              <input
                className="w-full rounded border border-minimal-border bg-minimal-bg p-2 text-[12px] focus:outline-none focus:border-white/40"
                placeholder="Subject override (optional — desk's best subject used if blank)"
                value={draftTitle}
                onChange={(e) => {
                  setDraftTitle(e.target.value);
                  setEmailOperationId(crypto.randomUUID());
                  setTestedEmailCandidate(null);
                  setTestState('idle');
                  setTestWarnings([]);
                  setTestError(null);
                  setFilingError(null);
                }}
              />
            </div>
          ) : draft.type === 'gen' ? (
            <>
              {imageGenerationIssue && (
                <div className="mb-3 rounded border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-600 dark:text-amber-400">
                  {imageGenerationIssue}
                </div>
              )}
              <div className="text-[12px] mb-2">
                <span className="font-medium">Generate {CREATIVE_FORMATS[genFormat].label.toLowerCase()} with fal?</span>
                <span className="text-minimal-muted"> This reply becomes the image prompt. Spends fal credits per image.</span>
              </div>
              <div className="mb-2">
                <div className="text-[10px] uppercase tracking-wide text-minimal-muted mb-1">Asset type</div>
                <select
                  className="w-full rounded border border-minimal-border bg-minimal-bg p-2 text-[12px] focus:outline-none"
                  value={genFormat}
                  onChange={(e) => setGenFormat(e.target.value as CreativeFormatKey)}
                  aria-label="Asset type"
                >
                  {(Object.entries(CREATIVE_FORMATS) as [CreativeFormatKey, (typeof CREATIVE_FORMATS)[CreativeFormatKey]][]).map(
                    ([value, format]) => (
                      <option key={value} value={value}>{format.label} — {format.detail}</option>
                    ),
                  )}
                </select>
              </div>
              {genFormat === 'custom' && (
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <label className="text-[10px] uppercase tracking-wide text-minimal-muted">
                    Width
                    <input
                      type="number"
                      step={16}
                      min={512}
                      max={3840}
                      className="mt-1 w-full rounded border border-minimal-border bg-minimal-bg p-2 text-[12px] text-minimal-accent focus:outline-none"
                      value={genWidth}
                      onChange={(e) => setGenWidth(Number(e.target.value))}
                    />
                  </label>
                  <label className="text-[10px] uppercase tracking-wide text-minimal-muted">
                    Height
                    <input
                      type="number"
                      step={16}
                      min={512}
                      max={3840}
                      className="mt-1 w-full rounded border border-minimal-border bg-minimal-bg p-2 text-[12px] text-minimal-accent focus:outline-none"
                      value={genHeight}
                      onChange={(e) => setGenHeight(Number(e.target.value))}
                    />
                  </label>
                  <div className="col-span-2 text-[10px] text-minimal-muted">Dimensions must be multiples of 16.</div>
                </div>
              )}
              <div className="flex gap-2 mb-2">
                <select
                  className="flex-1 rounded border border-minimal-border bg-minimal-bg p-2 text-[12px] focus:outline-none"
                  value={genMode}
                  onChange={(e) => setGenMode(e.target.value as 'reference' | 'fresh')}
                  aria-label="Generation mode"
                >
                  <option value="reference">Match wired references (recommended)</option>
                  <option value="fresh">Fresh — no reference</option>
                </select>
                <select
                  className="w-24 rounded border border-minimal-border bg-minimal-bg p-2 text-[12px] focus:outline-none"
                  value={genCount}
                  onChange={(e) => setGenCount(Number(e.target.value))}
                  aria-label="Image count"
                >
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>{n} img</option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2 mb-2 text-[12px] text-minimal-muted cursor-pointer">
                <input type="checkbox" checked={genSplit} onChange={(e) => setGenSplit(e.target.checked)} />
                Split multi-concept replies — one card per concept (each spends a credit)
              </label>
            </>
          ) : draft.type === 'calendar_topic' ? (
            <>
              <div className="text-[12px] font-medium mb-2">File as a calendar topic</div>
              <input
                className="w-full mb-2 rounded border border-minimal-border bg-minimal-bg p-2 text-[12px] focus:outline-none focus:border-white/40"
                placeholder="Article title"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
              />
              <input
                className="w-full mb-2 rounded border border-minimal-border bg-minimal-bg p-2 text-[12px] focus:outline-none focus:border-white/40"
                placeholder="Target keyword"
                value={draftKeyword}
                onChange={(e) => setDraftKeyword(e.target.value)}
              />
              <input
                className="w-full mb-2 rounded border border-minimal-border bg-minimal-bg p-2 text-[12px] focus:outline-none"
                value={draftPillar}
                onChange={(e) => setDraftPillar(e.target.value)}
                placeholder="Content pillar (optional)"
                aria-label="Content pillar"
              />
            </>
          ) : !carouselConfig ? (
            <div className="mb-4 py-1 text-[12px] text-minimal-muted">Checking the signed carousel setup…</div>
          ) : carouselConfig.issue ? (
            <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
              <div className="text-[14px] font-medium">Carousel setup needs attention</div>
              <div className="mt-1 max-w-md text-[12px] leading-relaxed text-minimal-muted">
                {CAROUSEL_CONFIG_ISSUE_MESSAGES[carouselConfig.issue]}
              </div>
            </div>
          ) : carouselConfig.renderer === 'content_manager' && carouselGenerationIssue ? (
            <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
              <div className="text-[14px] font-medium">HOUSE renderer needs attention</div>
              <div className="mt-1 max-w-md text-[12px] leading-relaxed text-minimal-muted">
                {carouselGenerationIssue}
              </div>
            </div>
          ) : carouselConfig?.renderer === 'factory' ? (
            <div className="mb-3 rounded-xl border border-minimal-border bg-minimal-row p-4 text-[12px]">
              <div className="font-medium">Send this to the bespoke carousel factory?</div>
              <div className="mt-1 text-minimal-muted">
                This optional renderer is explicitly configured on this Digital Home. It creates a social draft and returns the review here. Nothing publishes without your approval.
              </div>
            </div>
          ) : carouselConfig?.ready && carouselConfig.house_look ? (
            <div className="mb-3 space-y-3">
              <HouseLookPreview look={carouselConfig.house_look} />
              <div className="text-[12px] text-minimal-muted">
                Ten slides render from {carouselConfig.template_id}@{carouselConfig.template_version} and come back to this board for review. Nothing publishes without your approval.
              </div>
            </div>
          ) : (
            <div className="mb-4 py-1">
              <div className="text-[14px] font-medium">Choose your house look with Bob in Buzz</div>
              <div className="mt-1 max-w-md text-[12px] leading-relaxed text-minimal-muted">
                Bob has the real templates and saves your choice to this Digital Home. Once it is chosen, reopen this carousel to continue.
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <button
              disabled={
                filing
                || (draft.type === 'gen' && Boolean(imageGenerationIssue))
                || (draft.type === 'calendar_topic' && (!draftTitle.trim() || !draftKeyword.trim()))
                || (draft.type === 'carousel_job' && (!carouselConfig || !carouselConfig.ready || Boolean(carouselConfig.issue)))
                || (draft.type === 'carousel_job' && carouselConfig?.renderer === 'content_manager' && Boolean(carouselGenerationIssue))
                || (draft.type === 'email_batch' && (!emailOperationId || (emailAudience === 'tag' && (tagLoadState !== 'ready' || emailTags.length === 0))))
              }
              className="flex-1 rounded bg-minimal-accent text-minimal-bg text-[12px] py-1.5 font-medium disabled:opacity-40"
              onClick={async () => {
                setFiling(true);
                setError(null);
                setFilingError(null);
                try {
                  if (draft.type === 'gen') {
                    const j = await studioFetchJson<{
                      jobs?: { id: string; count?: number; prompt?: string; asset_type?: string; image_size?: unknown }[];
                      job?: { id: string; count?: number; prompt?: string; asset_type?: string; image_size?: unknown };
                    }>('/api/studio/gen', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        board_id: boardId,
                        desk_node_id: nodeId,
                        prompt: draft.message,
                        mode: genMode,
                        count: genCount,
                        split: genSplit,
                        asset_type: genFormat,
                        ...(genFormat === 'custom' ? { width: genWidth, height: genHeight } : {}),
                      }),
                    });
                    for (const job of j.jobs ?? (j.job ? [j.job] : [])) onGenQueued?.(job);
                    setDraft(null);
                    return;
                  }
                  const payload =
                    draft.type === 'email_batch'
                      ? {
                          operation_id: emailOperationId,
                          message: draft.message,
                          subject: draftTitle.trim() || undefined,
                          audience_mode: emailAudience === 'tag' ? 'tags' : 'all',
                          tags: emailAudience === 'tag' ? emailTags : [],
                          scheduled_at: scheduleAt ? new Date(scheduleAt).toISOString() : undefined,
                          campaign_intent: `Email desk send — ${desk?.name ?? 'studio'}`,
                          candidate: testedEmailCandidate ?? undefined,
                        }
                      : draft.type === 'calendar_topic'
                        ? { title: draftTitle.trim(), target_keyword: draftKeyword.trim(), pillar_topic: draftPillar.trim() || undefined, notes: draft.message.slice(0, 4000) }
                        : { request: draft.message, source_title: draftTitle.trim() || undefined };
                  const j = await studioFetchJson<{ output: { output_type: string; ref_id: string; title?: string } }>('/api/studio/outputs', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: draft.type === 'email_batch' ? 'broadcast' : draft.type, payload }),
                  });
                  onOutputCreated?.(j.output);
                  setDraft(null);
                } catch (e) {
                  setFilingError(studioErrorMessage(e, 'Could not file that output.'));
                } finally {
                  setFiling(false);
                }
              }}
            >
              {filing
                ? 'Working…'
                : draft.type === 'gen'
                  ? `Generate ${genCount}`
                  : draft.type === 'calendar_topic'
                    ? 'File topic'
                    : draft.type === 'email_batch'
                      ? 'Queue for approval'
                      : draft.type === 'carousel_job' && !carouselConfig
                        ? 'Checking carousel setup…'
                        : draft.type === 'carousel_job' && carouselConfig?.issue
                          ? 'Carousel setup needs attention'
                          : draft.type === 'carousel_job' && carouselConfig?.renderer === 'content_manager' && carouselGenerationIssue
                            ? 'HOUSE renderer needs attention'
                          : carouselConfig?.renderer === 'factory'
                            ? 'Queue for the factory'
                            : 'Queue the render'}
            </button>
            <button
              className="rounded border border-minimal-border px-3 text-[12px]"
              onClick={() => setDraft(null)}
            >
              Cancel
            </button>
          </div>
          {filingError && (
            <div role="alert" className="mt-3 rounded-lg border border-red-400 bg-red-50 p-3 text-[12px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">
              {filingError}
            </div>
          )}
          </div>
        </div>
      )}

      {/* Composer */}
      <div className="p-3 border-t border-minimal-border relative">
        {mentionOpen && (context?.sources?.length ?? 0) > 0 && (
          <div className="absolute bottom-full left-3 right-3 mb-1 z-20 max-h-56 overflow-y-auto rounded-lg border border-minimal-border bg-minimal-bg shadow-xl p-1">
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-minimal-muted">Wired into this desk</div>
            {context!.sources.map((s) => (
              <button
                key={s.id}
                type="button"
                className="w-full text-left rounded px-2 py-1.5 text-[12px] hover:bg-white/5"
                onClick={() => {
                  setInput((v) => v.replace(/@$/, `@"${s.title}" `));
                  setMentionOpen(false);
                  composerRef.current?.focus();
                }}
              >
                <span className="mr-1.5 text-[10px] uppercase text-minimal-muted">{s.platform}</span>
                {s.title}
              </button>
            ))}
          </div>
        )}
        {!input.trim() && !busy && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {STARTER_CHIPS.map((s) => (
              <button
                key={s.label}
                type="button"
                className="rounded-full border border-minimal-border px-2.5 py-0.5 text-[11px] text-minimal-muted hover:text-minimal-accent hover:bg-white/5"
                title={s.prompt}
                onClick={() => {
                  setInput(s.prompt);
                  composerRef.current?.focus();
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
        {/* Inline mention highlighting: a metrically-identical backdrop paints
            a pill behind every @"…" token while the (transparent-background)
            textarea renders the actual text on top — mentions live IN the
            sentence, where they belong. */}
        <div className="relative rounded bg-minimal-row">
          <div
            ref={highlightRef}
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words rounded border border-transparent p-2 text-[13px] leading-[1.45] text-transparent"
          >
            {input.split(/(@"[^"]+")/g).map((seg, i) =>
              /^@"[^"]+"$/.test(seg) ? (
                <span key={i} className="rounded-[4px] bg-indigo-500/25 dark:bg-indigo-400/30">
                  {seg}
                </span>
              ) : (
                <span key={i}>{seg}</span>
              )
            )}
            {'​'}
          </div>
          <textarea
            ref={composerRef}
            className="relative block w-full h-20 rounded border border-minimal-border bg-transparent p-2 text-[13px] leading-[1.45] focus:outline-none focus:border-white/40 resize-none"
            placeholder="Ask this desk… (@ points at a wired source · Enter to send · Shift+Enter for a new line)"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setMentionOpen(e.target.value.endsWith('@'));
            }}
            onScroll={(e) => {
              if (highlightRef.current) highlightRef.current.scrollTop = e.currentTarget.scrollTop;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
        </div>
        <button
          onClick={() => send()}
          disabled={busy || !input.trim()}
          className="mt-2 w-full rounded bg-minimal-accent text-minimal-bg text-[13px] py-1.5 font-medium disabled:opacity-40"
        >
          {busy ? 'Working…' : 'Send'}
        </button>
      </div>

      {expanded && (
        <div className="fixed inset-0 z-50 flex flex-col bg-minimal-bg">
          <div className="flex items-center gap-2 px-5 py-3 border-b border-minimal-border shrink-0">
            <span className="text-sm font-medium truncate">{desk?.name ?? 'Desk'} — output</span>
            <span className="text-[11px] text-minimal-muted hidden sm:inline">Esc to close</span>
            <div className="ml-auto flex items-center gap-2">
              <button
                className="rounded border border-minimal-border px-3 py-1 text-[12px] hover:bg-white/5"
                onClick={() => setExpanded({ ...expanded, editing: !expanded.editing })}
              >
                {expanded.editing ? 'Preview' : 'Edit'}
              </button>
              <button
                className="rounded border border-minimal-border px-3 py-1 text-[12px] hover:bg-white/5"
                onClick={() => navigator.clipboard.writeText(expanded.draft)}
              >
                Copy
              </button>
              {onSaveNote && (
                <button
                  className="rounded border border-minimal-border px-3 py-1 text-[12px] hover:bg-white/5"
                  title="File the (edited) text onto the board as a note"
                  onClick={() => {
                    onSaveNote(expanded.draft);
                    setExpanded(null);
                  }}
                >
                  ⤷ Board note
                </button>
              )}
              <button
                className="rounded bg-minimal-accent text-minimal-bg px-3 py-1 text-[12px] font-medium"
                onClick={() => setExpanded(null)}
              >
                Close
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[720px] px-6 py-10 sm:px-8">
              <StudioMarkdownEditor
                markdown={expanded.draft}
                editable={expanded.editing}
                onChange={(draft) => setExpanded((current) => (current ? { ...current, draft } : current))}
              />
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
