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
import { useCallback, useEffect, useMemo, useState } from 'react';
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
                    <textarea
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
                <span className="normal-case tracking-normal text-zinc-700">links open in a new tab</span>
              </p>
              <iframe
                title="Email preview"
                srcDoc={preview}
                // Links must be clickable — a dead button reads as a broken
                // email (MI clicked one and thought the Zoom link was down).
                // Popups only; scripts and same-origin access stay blocked.
                sandbox="allow-popups allow-popups-to-escape-sandbox"
                className="h-[calc(100%-24px)] w-full border border-white/10 bg-white"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
