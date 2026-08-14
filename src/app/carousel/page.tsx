'use client';

/**
 * Carousel review — the backend gate of the anti-slop review.
 * Lists drafts; opening one shows every slide (each slide's self-contained
 * HTML from spec.slides[].rendered_html, scaled down in a sandboxed iframe),
 * the caption, and the two actions that matter: Approve / Request changes.
 * Approving hands off to the human publishing flow; nothing posts from here.
 */
import { useCallback, useEffect, useState } from 'react';

type DraftSummary = {
  id: string;
  article_slug: string;
  mode: string;
  status: string;
  revision: number;
  caption: string | null;
  created_at: string;
};

type Slide = {
  number: number;
  role: string;
  variant_id: string;
  rendered_html?: string;
  accessibility_text?: string;
};

type Draft = DraftSummary & {
  spec: { slides: Slide[]; monologue?: string };
  revision_history: unknown[];
};

const STATUS_COLORS: Record<string, string> = {
  draft: 'text-amber-400 border-amber-400/40',
  approved: 'text-emerald-400 border-emerald-400/40',
  archived: 'text-zinc-500 border-zinc-600',
};

export default function CarouselPage() {
  const [drafts, setDrafts] = useState<DraftSummary[] | null>(null);
  const [open, setOpen] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/carousel/drafts');
    if (res.ok) setDrafts((await res.json()).drafts);
  }, []);
  useEffect(() => { load(); }, [load]);

  const openDraft = async (id: string) => {
    const res = await fetch(`/api/carousel/drafts/${id}`);
    if (res.ok) setOpen((await res.json()).draft);
  };

  const act = async (payload: Record<string, unknown>, msg: string) => {
    if (!open) return;
    setBusy(true);
    const res = await fetch(`/api/carousel/drafts/${open.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    if (res.ok) {
      setNote(msg);
      setFeedback('');
      const updated = (await res.json()).draft;
      setOpen(updated);
      load();
      setTimeout(() => setNote(null), 4000);
    } else {
      setNote((await res.json()).error || 'Failed');
    }
  };

  return (
    <div className="flex-1 overflow-y-auto px-12 py-10">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-xl font-light">Carousels</h1>
          <p className="text-xs text-minimal-muted mt-1">
            Review-only. Approval hands a carousel to your publishing flow — nothing posts from here.
          </p>
        </div>
        {note && <span className="text-xs text-emerald-400">{note}</span>}
      </div>

      {!open ? (
        <div className="border border-minimal-border rounded-lg divide-y divide-minimal-border">
          {drafts === null ? (
            <p className="p-6 text-sm text-minimal-muted">Loading…</p>
          ) : drafts.length === 0 ? (
            <p className="p-6 text-sm text-minimal-muted">
              No carousel drafts yet. Ask the agent to create one from an article.
            </p>
          ) : (
            drafts.map((d) => (
              <button
                key={d.id}
                onClick={() => openDraft(d.id)}
                className="w-full flex items-center gap-5 px-6 py-4 text-left hover:bg-minimal-row transition-colors"
              >
                <span className={`shrink-0 text-[11px] uppercase border rounded px-2 py-0.5 ${STATUS_COLORS[d.status] || ''}`}>
                  {d.status}
                </span>
                <span className="flex-1 text-[14px] truncate">{d.article_slug}</span>
                <span className="text-xs text-minimal-muted capitalize">{d.mode}</span>
                <span className="text-xs text-minimal-muted">rev {d.revision}</span>
              </button>
            ))
          )}
        </div>
      ) : (
        <div>
          <button onClick={() => setOpen(null)} className="text-xs text-minimal-muted hover:text-white mb-6">
            ← All carousels
          </button>
          <div className="flex items-center gap-4 mb-6">
            <span className={`text-[11px] uppercase border rounded px-2 py-0.5 ${STATUS_COLORS[open.status] || ''}`}>
              {open.status}
            </span>
            <h2 className="text-lg font-light">{open.article_slug}</h2>
            <span className="text-xs text-minimal-muted capitalize">{open.mode} · rev {open.revision}</span>
          </div>

          <div className="flex gap-4 overflow-x-auto pb-4 mb-8">
            {open.spec.slides.map((s) => (
              <div key={s.number} className="shrink-0">
                <div className="w-[270px] h-[360px] overflow-hidden rounded border border-minimal-border bg-white">
                  {s.rendered_html ? (
                    <iframe
                      sandbox=""
                      srcDoc={s.rendered_html}
                      title={`Slide ${s.number}`}
                      className="origin-top-left"
                      style={{ width: 1080, height: 1440, transform: 'scale(0.25)', border: 0 }}
                    />
                  ) : (
                    <div className="p-4 text-xs text-zinc-500">No render for slide {s.number}</div>
                  )}
                </div>
                <p className="text-[11px] text-minimal-muted mt-2 text-center">
                  {s.number} · {s.role}
                </p>
              </div>
            ))}
          </div>

          {open.caption && (
            <div className="mb-8 max-w-2xl">
              <p className="text-xs uppercase tracking-wider text-minimal-muted mb-2">Caption</p>
              <p className="text-sm whitespace-pre-wrap border border-minimal-border rounded-lg p-4">{open.caption}</p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-4 max-w-2xl">
            {open.status === 'draft' && (
              <button
                disabled={busy}
                onClick={() => act({ status: 'approved' }, 'Approved — ready for your publishing flow')}
                className="px-5 py-2.5 text-sm bg-emerald-600/80 hover:bg-emerald-600 rounded-lg transition-colors"
              >
                Approve
              </button>
            )}
            {open.status === 'approved' && (
              <button
                disabled={busy}
                onClick={() => act({ status: 'draft' }, 'Re-opened as draft')}
                className="px-5 py-2.5 text-sm border border-minimal-border hover:border-zinc-400 rounded-lg transition-colors"
              >
                Re-open
              </button>
            )}
            <button
              disabled={busy}
              onClick={() => act({ status: 'archived' }, 'Archived')}
              className="px-5 py-2.5 text-sm border border-minimal-border text-minimal-muted hover:text-white rounded-lg transition-colors"
            >
              Archive
            </button>
            <div className="flex-1 min-w-[280px] flex gap-2">
              <input
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder='Request changes, e.g. "slide 3 — use the standards line"'
                className="flex-1 bg-transparent border border-minimal-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-zinc-400"
              />
              <button
                disabled={busy || !feedback.trim()}
                onClick={() => act({ feedback: feedback.trim() }, 'Feedback saved — the agent will revise this draft')}
                className="px-4 py-2 text-sm border border-minimal-border hover:border-zinc-400 rounded-lg transition-colors"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
