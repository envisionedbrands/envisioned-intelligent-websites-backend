'use client';

/**
 * Carousel review — the backend gate of the anti-slop review.
 * Lists drafts; opening one shows every slide (each slide's self-contained
 * HTML from spec.slides[].rendered_html, scaled down in a sandboxed iframe),
 * the caption, and the two actions that matter: Approve / Request changes.
 * Approving hands off to the human publishing flow; nothing posts from here.
 *
 * Inline editing: each slide's text fields (heading, body, standfirst,
 * kicker, section, etc.) are editable directly. Saving patches the spec
 * and updates rendered_html via string replacement.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/* ── types ─────────────────────────────────────────────────────────────── */

type DraftSummary = {
  id: string;
  article_slug: string;
  mode: string;
  status: string;
  revision: number;
  caption: string | null;
  created_at: string;
};

type SlideText = Record<string, string>;

type Slide = {
  number: number;
  role: string;
  variant_id: string;
  text?: SlideText;
  rendered_html?: string;
  accessibility_text?: string;
  [key: string]: unknown;
};

type Draft = DraftSummary & {
  spec: { slides: Slide[]; monologue?: string; [key: string]: unknown };
  revision_history: unknown[];
};

const STATUS_COLORS: Record<string, string> = {
  draft: 'text-amber-400 border-amber-400/40',
  approved: 'text-emerald-400 border-emerald-400/40',
  archived: 'text-zinc-500 border-zinc-600',
};

/* Label formatting: turn snake_case / camelCase keys into readable labels */
function labelFor(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

/* ── pencil icon (inline SVG, 14px) ──────────────────────────────────── */
function PencilIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="inline-block ml-1.5 text-[#E8C4A8] opacity-50 group-hover/field:opacity-100 transition-opacity shrink-0"
    >
      <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}

/* ── main component ──────────────────────────────────────────────────── */

export default function CarouselPage() {
  const [drafts, setDrafts] = useState<DraftSummary[] | null>(null);
  const [open, setOpen] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [note, setNote] = useState<string | null>(null);

  /* Inline-edit state: tracks edits per slide, keyed by slide number */
  const [edits, setEdits] = useState<Record<number, SlideText>>({});
  const [savingEdits, setSavingEdits] = useState(false);

  /* Track which field is currently being edited */
  const [editingField, setEditingField] = useState<string | null>(null);

  /* Delete confirmation dialog */
  const [confirmDelete, setConfirmDelete] = useState(false);

  const hasEdits = Object.keys(edits).length > 0;

  /* ── data loading ───────────────────────────────────────────────────── */

  const load = useCallback(async () => {
    const res = await fetch('/api/carousel/drafts');
    if (res.ok) setDrafts((await res.json()).drafts);
  }, []);
  useEffect(() => { load(); }, [load]);

  const openDraft = async (id: string) => {
    const res = await fetch(`/api/carousel/drafts/${id}`);
    if (res.ok) {
      setOpen((await res.json()).draft);
      setEdits({});
      setEditingField(null);
    }
  };

  /* ── generic action (approve / archive / feedback) ──────────────────── */

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
      setEdits({});
      load();
      setTimeout(() => setNote(null), 4000);
    } else {
      setNote((await res.json()).error || 'Failed');
    }
  };

  /* ── delete action ──────────────────────────────────────────────────── */

  const deleteDraft = async () => {
    if (!open) return;
    setBusy(true);
    const res = await fetch(`/api/carousel/drafts/${open.id}`, {
      method: 'DELETE',
    });
    setBusy(false);
    setConfirmDelete(false);
    if (res.ok) {
      setNote('Deleted');
      setOpen(null);
      setEdits({});
      setEditingField(null);
      load();
      setTimeout(() => setNote(null), 4000);
    } else {
      const err = await res.json().catch(() => null);
      setNote(err?.error || 'Delete failed');
      setTimeout(() => setNote(null), 4000);
    }
  };

  /* ── inline edit handlers ───────────────────────────────────────────── */

  /** Record a text-field change for one slide */
  const onFieldChange = (slideNumber: number, fieldKey: string, value: string) => {
    setEdits((prev) => ({
      ...prev,
      [slideNumber]: { ...(prev[slideNumber] ?? {}), [fieldKey]: value },
    }));
  };

  /** Get the current value for a field (edited or original) */
  const fieldValue = (slide: Slide, fieldKey: string): string => {
    return edits[slide.number]?.[fieldKey] ?? slide.text?.[fieldKey] ?? '';
  };

  /** Save all inline edits: rebuild spec, patch rendered_html, send PATCH */
  const saveEdits = async () => {
    if (!open || !hasEdits) return;
    setSavingEdits(true);

    // Deep-clone the spec
    const updatedSpec = JSON.parse(JSON.stringify(open.spec));
    const changedSlides: number[] = [];
    const changedFields: string[] = [];

    for (const slide of updatedSpec.slides as Slide[]) {
      const slideEdits = edits[slide.number];
      if (!slideEdits) continue;

      changedSlides.push(slide.number);

      // Ensure slide has a text object
      if (!slide.text) slide.text = {};

      for (const [key, newValue] of Object.entries(slideEdits)) {
        const oldValue = slide.text[key] ?? '';
        if (oldValue === newValue) continue;

        changedFields.push(`slide ${slide.number} ${labelFor(key)}`);

        // Update rendered_html: replace old text with new text
        if (slide.rendered_html && oldValue) {
          // Escape HTML entities in old value for matching inside HTML
          const escapeHtml = (s: string) =>
            s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          // Try both raw and HTML-escaped replacement
          slide.rendered_html = slide.rendered_html
            .split(oldValue).join(newValue);
          const escapedOld = escapeHtml(oldValue);
          const escapedNew = escapeHtml(newValue);
          if (escapedOld !== oldValue) {
            slide.rendered_html = slide.rendered_html
              .split(escapedOld).join(escapedNew);
          }
        }

        // Update the text field
        slide.text[key] = newValue;
      }
    }

    if (changedFields.length === 0) {
      setSavingEdits(false);
      setEdits({});
      return;
    }

    const feedbackLine = `Inline edit: ${changedFields.join(', ')}`;

    const res = await fetch(`/api/carousel/drafts/${open.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        spec: updatedSpec,
        feedback: feedbackLine,
        changed_slides: changedSlides,
      }),
    });

    setSavingEdits(false);
    if (res.ok) {
      const updated = (await res.json()).draft;
      setOpen(updated);
      setEdits({});
      setNote('Changes saved');
      load();
      setTimeout(() => setNote(null), 4000);
    } else {
      setNote('Failed to save edits');
      setTimeout(() => setNote(null), 4000);
    }
  };

  /** Discard all inline edits */
  const discardEdits = () => {
    setEdits({});
    setEditingField(null);
  };

  /* ── render: editable text field ────────────────────────────────────── */

  const EditableField = ({
    slide,
    fieldKey,
    multiline = false,
  }: {
    slide: Slide;
    fieldKey: string;
    multiline?: boolean;
  }) => {
    const fieldId = `${slide.number}-${fieldKey}`;
    const isEditing = editingField === fieldId;
    const value = fieldValue(slide, fieldKey);
    const isModified = edits[slide.number]?.[fieldKey] !== undefined &&
      edits[slide.number]?.[fieldKey] !== (slide.text?.[fieldKey] ?? '');
    const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement>(null);

    useEffect(() => {
      if (isEditing && inputRef.current) {
        inputRef.current.focus();
        // Place cursor at end
        const el = inputRef.current;
        if (el instanceof HTMLTextAreaElement) {
          el.selectionStart = el.selectionEnd = el.value.length;
        }
      }
    }, [isEditing]);

    if (!value && !isEditing) return null;

    const baseClasses = `w-full bg-transparent text-sm rounded px-2 py-1.5 transition-all outline-none`;
    const editBorder = isModified
      ? 'border border-[#E8C4A8]'
      : 'border border-minimal-border focus:border-[#E8C4A8]';
    const displayClasses = `cursor-pointer hover:bg-zinc-900/50 rounded px-2 py-1.5 transition-colors`;

    if (isEditing) {
      const sharedProps = {
        value,
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) =>
          onFieldChange(slide.number, fieldKey, e.target.value),
        onBlur: () => setEditingField(null),
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'Escape') setEditingField(null);
          if (e.key === 'Enter' && !e.shiftKey && !multiline) {
            e.preventDefault();
            setEditingField(null);
          }
        },
        className: `${baseClasses} ${editBorder}`,
      };

      return (
        <div className="mb-1">
          <label className="text-[10px] uppercase tracking-wider text-minimal-muted mb-0.5 block">
            {labelFor(fieldKey)}
            {isModified && <span className="text-[#E8C4A8] ml-1">*</span>}
          </label>
          {multiline ? (
            <textarea
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              rows={Math.min(6, Math.max(2, value.split('\n').length + 1))}
              {...sharedProps}
            />
          ) : (
            <input
              ref={inputRef as React.RefObject<HTMLInputElement>}
              type="text"
              {...sharedProps}
            />
          )}
        </div>
      );
    }

    return (
      <div
        className={`group/field mb-1 ${displayClasses}`}
        onClick={() => setEditingField(fieldId)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') setEditingField(fieldId); }}
      >
        <span className="text-[10px] uppercase tracking-wider text-minimal-muted block mb-0.5">
          {labelFor(fieldKey)}
          {isModified && <span className="text-[#E8C4A8] ml-1">*</span>}
          <PencilIcon />
        </span>
        <span className={`text-sm ${isModified ? 'text-[#E8C4A8]' : ''}`}>
          {value}
        </span>
      </div>
    );
  };

  /* ── render: slide text editor panel ────────────────────────────────── */

  const SlideTextEditor = ({ slide }: { slide: Slide }) => {
    const textFields = slide.text ? Object.keys(slide.text) : [];
    if (textFields.length === 0) return null;

    // Determine which fields are likely multiline
    const multilineKeys = new Set(['body', 'description', 'content', 'paragraph', 'quote', 'pull_quote']);

    return (
      <div className="mt-2 space-y-0.5">
        {textFields.map((key) => (
          <EditableField
            key={key}
            slide={slide}
            fieldKey={key}
            multiline={multilineKeys.has(key)}
          />
        ))}
      </div>
    );
  };

  /* ── render ─────────────────────────────────────────────────────────── */

  return (
    <div className="flex-1 overflow-y-auto px-12 py-10">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-xl font-light">Carousels</h1>
          <p className="text-xs text-minimal-muted mt-1">
            Review-only. Approval hands a carousel to your publishing flow — nothing posts from here.
          </p>
        </div>
        {note && (
          <span className={`text-xs ${note.includes('Failed') || note.includes('failed') ? 'text-red-400' : 'text-emerald-400'}`}>
            {note}
          </span>
        )}
      </div>

      {!open ? (
        /* ── draft list ─────────────────────────────────────────────────── */
        <div className="border border-minimal-border rounded-lg divide-y divide-minimal-border">
          {drafts === null ? (
            <p className="p-6 text-sm text-minimal-muted">Loading...</p>
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
        /* ── single draft view with inline editing ──────────────────────── */
        <div>
          <button onClick={() => { setOpen(null); setEdits({}); setEditingField(null); setConfirmDelete(false); }} className="text-xs text-minimal-muted hover:text-white mb-6">
            &larr; All carousels
          </button>
          <div className="flex items-center gap-4 mb-6">
            <span className={`text-[11px] uppercase border rounded px-2 py-0.5 ${STATUS_COLORS[open.status] || ''}`}>
              {open.status}
            </span>
            <h2 className="text-lg font-light">{open.article_slug}</h2>
            <span className="text-xs text-minimal-muted capitalize">{open.mode} &middot; rev {open.revision}</span>
          </div>

          {/* ── slide strip: preview + editable text ─────────────────────── */}
          <div className="flex gap-6 overflow-x-auto pb-4 mb-8">
            {open.spec.slides.map((s) => (
              <div key={s.number} className="shrink-0 w-[270px]">
                {/* Visual preview */}
                <div className="w-[270px] h-[360px] overflow-hidden rounded border border-minimal-border bg-white">
                  {s.rendered_html ? (
                    <iframe
                      sandbox=""
                      srcDoc={
                        /* If we have edits for this slide, rebuild the HTML with replacements */
                        edits[s.number]
                          ? (() => {
                              let html = s.rendered_html!;
                              const slideText = s.text ?? {};
                              for (const [key, newVal] of Object.entries(edits[s.number])) {
                                const oldVal = slideText[key];
                                if (oldVal && oldVal !== newVal) {
                                  html = html.split(oldVal).join(newVal);
                                  // Also try HTML-escaped version
                                  const esc = (str: string) =>
                                    str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                                  const eOld = esc(oldVal);
                                  if (eOld !== oldVal) {
                                    html = html.split(eOld).join(esc(newVal));
                                  }
                                }
                              }
                              return html;
                            })()
                          : s.rendered_html
                      }
                      title={`Slide ${s.number}`}
                      className="origin-top-left"
                      style={{ width: 1080, height: 1440, transform: 'scale(0.25)', border: 0 }}
                    />
                  ) : (
                    <div className="p-4 text-xs text-zinc-500">No render for slide {s.number}</div>
                  )}
                </div>

                {/* Slide label */}
                <p className="text-[11px] text-minimal-muted mt-2 text-center">
                  {s.number} &middot; {s.role}
                  {edits[s.number] && (
                    <span className="text-[#E8C4A8] ml-1">*</span>
                  )}
                </p>

                {/* Editable text fields */}
                <SlideTextEditor slide={s} />
              </div>
            ))}
          </div>

          {/* ── save edits bar ───────────────────────────────────────────── */}
          {hasEdits && (
            <div className="flex items-center gap-3 mb-6 px-4 py-3 rounded-lg border border-[#E8C4A8]/40 bg-[#E8C4A8]/5">
              <span className="text-sm text-[#E8C4A8] flex-1">
                {Object.keys(edits).length} slide{Object.keys(edits).length > 1 ? 's' : ''} edited
              </span>
              <button
                onClick={discardEdits}
                disabled={savingEdits}
                className="px-4 py-1.5 text-xs border border-minimal-border text-minimal-muted hover:text-white rounded transition-colors"
              >
                Discard
              </button>
              <button
                onClick={saveEdits}
                disabled={savingEdits}
                className="px-5 py-1.5 text-sm bg-[#E8C4A8] text-black rounded hover:bg-[#d4a882] transition-colors font-medium"
              >
                {savingEdits ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          )}

          {/* ── caption ──────────────────────────────────────────────────── */}
          {open.caption && (
            <div className="mb-8 max-w-2xl">
              <p className="text-xs uppercase tracking-wider text-minimal-muted mb-2">Caption</p>
              <p className="text-sm whitespace-pre-wrap border border-minimal-border rounded-lg p-4">{open.caption}</p>
            </div>
          )}

          {/* ── delete confirmation dialog ───────────────────────────────── */}
          {confirmDelete && (
            <div className="mb-6 max-w-2xl px-4 py-3 rounded-lg border border-red-500/40 bg-red-500/5">
              <p className="text-sm text-red-400 mb-3">Delete this carousel draft? This cannot be undone.</p>
              <div className="flex items-center gap-3">
                <button
                  disabled={busy}
                  onClick={deleteDraft}
                  className="px-5 py-1.5 text-sm bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
                >
                  {busy ? 'Deleting...' : 'Yes, delete'}
                </button>
                <button
                  disabled={busy}
                  onClick={() => setConfirmDelete(false)}
                  className="px-4 py-1.5 text-xs border border-minimal-border text-minimal-muted hover:text-white rounded transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* ── action bar ───────────────────────────────────────────────── */}
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
            <button
              disabled={busy || confirmDelete}
              onClick={() => setConfirmDelete(true)}
              className="px-5 py-2.5 text-sm border border-red-500/40 text-red-400 hover:border-red-500 hover:text-red-300 rounded-lg transition-colors"
            >
              Delete
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
