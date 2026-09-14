'use client';

/**
 * /studio — board list. Every canvas opens through the static workspace shell.
 */
import { useCallback, useEffect, useState } from 'react';
import { studioErrorMessage, studioFetchJson, studioFetchOk } from '@/lib/studio/fetch-json';
import { openStudioWorkspace } from '@/lib/studio/workspace-navigation';

type Board = { id: string; name: string; template_key: string | null; updated_at: string };

// Type marker: a colored dot + a short label — quieter than pills, never
// wraps, one hue per template.
const BOARD_TYPES: Record<string, { label: string; dot: string }> = {
  'youtube-video': { label: 'YouTube', dot: 'bg-red-500' },
  'article-multiplication': { label: 'Multiplication', dot: 'bg-violet-500' },
  'model-a-reel': { label: 'Reel', dot: 'bg-pink-500' },
};

const relativeTime = (iso: string) => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
};

const boardType = (key: string | null) =>
  BOARD_TYPES[key ?? ''] ?? { label: 'Custom', dot: 'bg-zinc-400 dark:bg-zinc-600' };

export default function StudioHomePage() {
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [boardsState, setBoardsState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [boardsError, setBoardsError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadBoards = useCallback(async () => {
    // Defer the state transition so the mount effect starts external work
    // without synchronously cascading another render.
    await Promise.resolve();
    setBoardsState('loading');
    setBoardsError(null);
    try {
      const result = await studioFetchJson<{ boards?: Board[] }>('/api/studio/boards');
      setBoards(result.boards ?? []);
      setBoardsState('ready');
    } catch (e) {
      // A failed read is never an empty collection. Keep the two states
      // separate so the UI cannot invite a member to create over uncertainty.
      setBoards(null);
      setBoardsError(studioErrorMessage(e, 'Could not load Studio boards.'));
      setBoardsState('error');
    }
  }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void loadBoards();
    });
    return () => {
      active = false;
    };
  }, [loadBoards]);

  const [showTemplates, setShowTemplates] = useState(false);
  const [pending, setPending] = useState<{ key: string | null; name: string } | null>(null);
  const [boardName, setBoardName] = useState('');

  const createBoard = async () => {
    if (!pending || !boardName.trim()) return;
    setCreating(true);
    try {
      const j = await studioFetchJson<{ board?: Board }>('/api/studio/boards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: boardName.trim(), template_key: pending.key ?? undefined }),
      });
      if (!j.board) throw new Error('The server did not confirm the new board. Nothing was opened.');
      setShowTemplates(false);
      setPending(null);
      openStudioWorkspace(j.board.id);
    } catch (e) {
      setError(studioErrorMessage(e, 'Could not create that board.'));
    } finally {
      setCreating(false);
    }
  };

  const TEMPLATES = [
    { key: null, name: 'Blank board', desc: 'Empty canvas — paste and wire from scratch.' },
    { key: 'youtube-video', name: 'YouTube Video', desc: 'Idea → research (web search) → titles & thumbnails → script, in your voice.' },
    { key: 'article-multiplication', name: 'Article Multiplication', desc: 'Site articles → carousel, reels and email desks.' },
    { key: 'model-a-reel', name: 'Model a Reel', desc: 'Paste a competitor reel → structure analysis → your version.' },
  ];

  return (
    <div className="flex-1 overflow-y-auto">
      <header className="px-12 pt-10 pb-6 flex items-center">
        <div>
          <h1 className="text-xl font-medium">Content Studio</h1>
          <p className="text-sm text-minimal-muted mt-1">
            Turn videos, articles and ideas into original scripts, posts and campaigns in your voice.
          </p>
        </div>
        <div className="ml-auto relative">
          <button
            onClick={() => setShowTemplates((v) => !v)}
            disabled={creating || boardsState !== 'ready'}
            className="rounded bg-minimal-accent text-minimal-bg text-sm px-4 py-2 font-medium disabled:opacity-40"
          >
            + New board
          </button>
          {showTemplates && (
            <div className="absolute right-0 mt-2 w-80 rounded-lg border border-minimal-border bg-minimal-row shadow-xl z-20 p-1">
              {pending ? (
                <div className="p-2">
                  <div className="text-[12px] text-minimal-muted mb-2">Name for your {pending.name} board</div>
                  <input
                    autoFocus
                    className="w-full rounded border border-minimal-border bg-minimal-bg p-2 text-[13px] focus:outline-none focus:border-white/40"
                    value={boardName}
                    onChange={(e) => setBoardName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') createBoard();
                      if (e.key === 'Escape') setPending(null);
                    }}
                  />
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={createBoard}
                      disabled={creating || !boardName.trim()}
                      className="flex-1 rounded bg-minimal-accent text-minimal-bg text-[12px] py-1.5 font-medium disabled:opacity-40"
                    >
                      {creating ? 'Creating…' : 'Create board'}
                    </button>
                    <button onClick={() => setPending(null)} className="rounded border border-minimal-border px-3 text-[12px]">
                      Back
                    </button>
                  </div>
                </div>
              ) : (
                TEMPLATES.map((t) => (
                  <button
                    key={t.key ?? 'blank'}
                    onClick={() => {
                      setPending({ key: t.key, name: t.name });
                      setBoardName(t.name === 'Blank board' ? 'New board' : t.name);
                    }}
                    className="w-full text-left rounded px-3 py-2.5 hover:bg-white/5"
                  >
                    <div className="text-[13px] font-medium">{t.name}</div>
                    <div className="text-[11px] text-minimal-muted mt-0.5">{t.desc}</div>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </header>

      <div className="px-12 pb-12">
        {boardsState === 'loading' && <div className="text-sm text-minimal-muted">Loading…</div>}
        {boardsState === 'error' && (
          <div className="rounded border border-red-500/30 bg-red-500/5 p-4 text-[12px] text-red-500">
            <div>{boardsError ?? 'Could not load Studio boards.'}</div>
            <button
              type="button"
              onClick={() => void loadBoards()}
              className="mt-3 rounded border border-red-500/40 px-3 py-1.5 font-medium hover:bg-red-500/10"
            >
              Retry
            </button>
          </div>
        )}
        {error && (
          <div className="mb-4 rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-500">
            {error}
          </div>
        )}
        {boardsState === 'ready' && boards?.length === 0 && (
          <div className="text-sm text-minimal-muted border border-dashed border-minimal-border rounded-lg p-8 text-center">
            No boards yet. Create one, then paste a YouTube/Instagram/TikTok link straight onto the canvas.
          </div>
        )}
        {boardsState === 'ready' && !!boards?.length && (
          <>
            <div className="flex items-center gap-3 border-b border-minimal-border px-3 pb-2 text-[11px] uppercase tracking-wide text-minimal-muted">
              <span className="flex-1">Name</span>
              <span className="w-36 shrink-0">Type</span>
              <span className="w-28 shrink-0 text-right">Last updated</span>
              <span className="w-6 shrink-0" />
            </div>
            {boards.map((b) => {
              const type = boardType(b.template_key);
              return (
                <div
                  key={b.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => openStudioWorkspace(b.id)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openStudioWorkspace(b.id);
                    }
                  }}
                  className="group flex items-center gap-3 border-b border-minimal-border px-3 py-3.5 cursor-pointer hover:bg-white/[0.03] transition-colors"
                >
                  <span className="flex-1 truncate text-[14px] font-medium">{b.name}</span>
                  <span className="w-36 shrink-0 inline-flex items-center gap-2 whitespace-nowrap text-[12px] text-minimal-muted">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${type.dot}`} />
                    {type.label}
                  </span>
                  <span className="w-28 shrink-0 text-right text-[12px] text-minimal-muted">{relativeTime(b.updated_at)}</span>
                  <span className="w-6 shrink-0 text-right">
                    <button
                      aria-label={`Delete board ${b.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDelete({ id: b.id, name: b.name });
                      }}
                      className="rounded p-1 text-minimal-muted opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-red-500 hover:bg-red-500/10 transition-opacity"
                    >
                      ✕
                    </button>
                  </span>
                </div>
              );
            })}
          </>
        )}
      </div>

      {confirmDelete && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/60" onClick={() => setConfirmDelete(null)}>
          <div
            className="w-[440px] max-w-[92vw] rounded-xl border border-minimal-border bg-minimal-bg shadow-2xl p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[14px] font-medium">Delete “{confirmDelete.name}”?</div>
            <div className="text-[12px] text-minimal-muted mt-1.5">
              The board, its wiring, notes, and output cards are removed. Sources stay in the swipe bank, desks keep
              their conversations, and anything already filed to the calendar or queued in a pipeline is untouched.
              This can&apos;t be undone.
            </div>
            <div className="flex gap-2 mt-4">
              <button
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true);
                  try {
                    await studioFetchOk(`/api/studio/boards/${confirmDelete.id}`, { method: 'DELETE' });
                    setBoards((bs) => (bs ? bs.filter((x) => x.id !== confirmDelete.id) : bs));
                    setConfirmDelete(null);
                  } catch (e) {
                    setError(studioErrorMessage(e, 'Could not delete that board.'));
                  } finally {
                    setDeleting(false);
                  }
                }}
                className="flex-1 rounded bg-red-600 text-white text-[13px] py-2 font-medium disabled:opacity-40"
              >
                {deleting ? 'Deleting…' : 'Delete board'}
              </button>
              <button onClick={() => setConfirmDelete(null)} className="rounded border border-minimal-border px-4 text-[13px]">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
