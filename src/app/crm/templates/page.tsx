'use client';

/**
 * /crm/templates — the email copy, visible and editable.
 *
 * These templates existed in the database with a full API long before there
 * was anywhere to see them (MI, 2026-08-16: "i don't see any templates").
 * Editing here beats editing code: the seed migrations only insert when a
 * template is ABSENT, so her wording can never be overwritten by a deploy.
 *
 * The preview is the real shell rendered server-side — what the recipient
 * gets, not an approximation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, EmptyState, GhostBtn, Loading, PageHeader, PrimaryBtn, useToast } from '@/components/crm/kit';

type Template = {
  id: string;
  name: string;
  subject: string;
  preheader: string | null;
  body_md: string;
  category: string | null;
  updated_at: string;
};

const CATEGORY_ORDER = ['booking', 'sequence', 'broadcast', 'transactional'];

export default function TemplatesPage() {
  const { show, node: toastNode } = useToast();
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Template | null>(null);
  const [preview, setPreview] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { templates: list } = await api<{ templates: Template[] }>('/api/crm/templates');
      setTemplates(list);
      setSelectedId((cur) => cur ?? list[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load templates');
      setTemplates([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Load the selected template into the editor.
  useEffect(() => {
    if (!selectedId || !templates) return;
    const t = templates.find((x) => x.id === selectedId);
    if (t) setDraft({ ...t });
  }, [selectedId, templates]);

  // Live preview of whatever is in the editor right now.
  useEffect(() => {
    if (!draft) return;
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/crm/templates/${draft.id}/preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body_md: draft.body_md, preheader: draft.preheader }),
        });
        const html = await res.text();
        if (live) setPreview(html);
      } catch {
        /* preview is best-effort */
      }
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [draft]);

  const bodyRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Formatting is applied to the markdown source rather than to rendered HTML.
   * A WYSIWYG that edits the preview has to convert HTML back to source, and
   * that roundtrip is exactly where merge tags get mangled — a stray span
   * inside {{first_name}} ships a visible tag to a client.
   */
  function apply(kind: string) {
    const el = bodyRef.current;
    if (!el || !draft) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const text = draft.body_md;
    const sel = text.slice(start, end);

    let insert = '';
    let caret = 0; // where to put the cursor, relative to insert start

    switch (kind) {
      case 'bold':
        insert = `**${sel || 'bold text'}**`;
        caret = sel ? insert.length : 2;
        break;
      case 'italic':
        insert = `*${sel || 'italic text'}*`;
        caret = sel ? insert.length : 1;
        break;
      case 'h2':
        insert = `\n## ${sel || 'Heading'}\n`;
        caret = insert.length;
        break;
      case 'quote':
        insert = `\n> ${sel || 'Something worth pulling out'}\n`;
        caret = insert.length;
        break;
      case 'label':
        insert = `\n::${sel || 'This week'}::\n`;
        caret = insert.length;
        break;
      case 'link':
        insert = `[${sel || 'link text'}](https://)`;
        caret = insert.length - 1;
        break;
      case 'button':
        insert = `\n\n[${sel || 'Book a time'}](https://home.envisioned.me/book/client-session)\n\n`;
        caret = insert.length;
        break;
      case 'divider':
        insert = `\n\n---\n\n`;
        caret = insert.length;
        break;
      case 'bullets':
        insert = sel
          ? sel.split('\n').map((l) => (l.trim() ? `- ${l.replace(/^[-*]\s*/, '')}` : l)).join('\n')
          : '\n- First\n- Second\n';
        caret = insert.length;
        break;
      default:
        // merge tag
        insert = kind;
        caret = insert.length;
    }

    const next = text.slice(0, start) + insert + text.slice(end);
    setDraft({ ...draft, body_md: next });
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + caret;
      el.setSelectionRange(pos, pos);
    });
  }

  const grouped = useMemo(() => {
    const m = new Map<string, Template[]>();
    (templates || []).forEach((t) => {
      const k = t.category || 'other';
      m.set(k, [...(m.get(k) || []), t]);
    });
    return Array.from(m.entries()).sort(
      (a, b) =>
        (CATEGORY_ORDER.indexOf(a[0]) + 1 || 99) - (CATEGORY_ORDER.indexOf(b[0]) + 1 || 99)
    );
  }, [templates]);

  const dirty =
    !!draft &&
    !!templates &&
    (() => {
      const orig = templates.find((t) => t.id === draft.id);
      return (
        !!orig &&
        (orig.subject !== draft.subject ||
          orig.preheader !== draft.preheader ||
          orig.body_md !== draft.body_md)
      );
    })();

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      await api(`/api/crm/templates/${draft.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          subject: draft.subject,
          preheader: draft.preheader,
          body_md: draft.body_md,
        }),
      });
      show('Saved');
      await load();
    } catch (e) {
      show(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {toastNode}
      <PageHeader title="Email · Templates">
        <div className="flex items-center gap-2">
          {dirty && <span className="text-[11px] text-amber-300/80">unsaved changes</span>}
          <GhostBtn onClick={() => void load()}>Refresh</GhostBtn>
          <PrimaryBtn onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save'}
          </PrimaryBtn>
        </div>
      </PageHeader>

      <div className="flex-1 overflow-hidden px-12 pb-8">
        {error && (
          <div className="mb-4 border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-[13px] text-amber-300/90">
            {error}
          </div>
        )}
        {templates === null && <Loading />}
        {templates !== null && templates.length === 0 && !error && (
          <EmptyState title="No templates yet" hint="Templates live in email_templates." />
        )}

        {templates !== null && templates.length > 0 && (
          <div className="grid h-full grid-cols-[210px_1fr_1fr] gap-6 overflow-hidden">
            {/* list */}
            <nav className="overflow-y-auto pr-1">
              {grouped.map(([cat, list]) => (
                <div key={cat} className="mb-5">
                  <p className="mb-1.5 text-[10px] uppercase tracking-wider text-zinc-600">{cat}</p>
                  {list.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setSelectedId(t.id)}
                      className={`block w-full truncate py-1.5 text-left text-[13px] transition-colors ${
                        selectedId === t.id ? 'text-white' : 'text-zinc-500 hover:text-zinc-300'
                      }`}
                      title={t.name}
                    >
                      {t.name}
                    </button>
                  ))}
                </div>
              ))}
            </nav>

            {/* editor */}
            <div className="overflow-y-auto pr-1">
              {draft && (
                <div className="space-y-4">
                  <div>
                    <label className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-600">
                      Subject
                    </label>
                    <input
                      value={draft.subject}
                      onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
                      className="w-full border border-white/10 bg-transparent px-3 py-2 text-[13px] text-white focus:border-white/30 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-600">
                      Preview text
                    </label>
                    <input
                      value={draft.preheader || ''}
                      onChange={(e) => setDraft({ ...draft, preheader: e.target.value })}
                      className="w-full border border-white/10 bg-transparent px-3 py-2 text-[13px] text-white focus:border-white/30 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-600">
                      Body
                    </label>
                    <div className="mb-1.5 flex flex-wrap items-center gap-1">
                      {([
                        ['bold', 'B', 'Bold'],
                        ['italic', 'I', 'Italic'],
                        ['h2', 'H', 'Heading'],
                        ['quote', '\u201C', 'Pull quote'],
                        ['bullets', '\u2022', 'Bullet list'],
                        ['link', 'Link', 'Link'],
                        ['button', 'Button', 'Button (link on its own line)'],
                        ['label', 'Label', 'Boxed label'],
                        ['divider', '\u2014', 'Divider'],
                      ] as const).map(([kind, glyph, title]) => (
                        <button
                          key={kind}
                          type="button"
                          title={title}
                          onClick={() => apply(kind)}
                          className="border border-white/10 px-2 py-1 text-[11px] text-zinc-400 transition-colors hover:border-white/30 hover:text-white"
                        >
                          {glyph}
                        </button>
                      ))}
                      <select
                        value=""
                        onChange={(e) => { if (e.target.value) apply(e.target.value); e.target.value = ''; }}
                        title="Insert a merge tag"
                        className="border border-white/10 bg-transparent px-2 py-1 text-[11px] text-zinc-400 focus:outline-none"
                      >
                        <option value="">Insert…</option>
                        <option value="{{first_name|there}}">First name</option>
                        <option value="{{booking_day}}">Booking day</option>
                        <option value="{{booking_weekday}}">Weekday</option>
                        <option value="{{booking_time}}">Booking time</option>
                        <option value="{{booking_title}}">Booking title</option>
                        <option value="{{meeting_url}}">Meeting link</option>
                        <option value="{{guest_notes}}">Their notes</option>
                      </select>
                    </div>
                    <textarea
                      ref={bodyRef}
                      value={draft.body_md}
                      onChange={(e) => setDraft({ ...draft, body_md: e.target.value })}
                      rows={22}
                      spellCheck
                      className="w-full resize-y border border-white/10 bg-transparent px-3 py-2 font-mono text-[12px] leading-[1.65] text-white focus:border-white/30 focus:outline-none"
                    />
                  </div>
                  <div className="text-[11px] leading-relaxed text-zinc-600">
                    <p className="mb-1 text-zinc-500">Formatting</p>
                    <p><code>::Label::</code> boxed label · <code># Heading</code> · <code>&gt; quote</code> · <code>---</code> divider</p>
                    <p>A paragraph containing only a link becomes a button.</p>
                    <p className="mt-1.5 text-zinc-500">Merge tags</p>
                    <p><code>{'{{first_name|there}}'}</code> · <code>{'{{booking_day}}'}</code> · <code>{'{{booking_time}}'}</code> · <code>{'{{booking_weekday}}'}</code> · <code>{'{{meeting_url}}'}</code> · <code>{'{{guest_notes}}'}</code></p>
                  </div>
                </div>
              )}
            </div>

            {/* preview */}
            <div className="overflow-hidden">
              <p className="mb-2 flex items-baseline justify-between text-[10px] uppercase tracking-wider text-zinc-600">
                <span>Preview — what they receive</span>
                {draft && (
                  <a
                    href={`/api/crm/templates/${draft.id}/preview`}
                    target="_blank"
                    rel="noreferrer"
                    className="normal-case tracking-normal text-zinc-500 underline hover:text-white"
                    title="Opens the saved version, with working links"
                  >
                    open in new tab ↗
                  </a>
                )}
              </p>
              <iframe
                title="Email preview"
                srcDoc={preview}
                // Fully sandboxed: this renders reliably, but swallows clicks.
                // "Open in new tab" beside the heading is the clickable copy —
                // MI clicked a dead button here and thought the Zoom link was
                // broken, so the escape hatch has to be visible.
                sandbox=""
                className="h-[calc(100%-24px)] w-full border border-white/10 bg-white"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
