'use client';

/**
 * /crm/repurpose — one article becomes the pieces that carry it elsewhere.
 *
 * Audited 2026-08-16: nothing in the system connected an essay to a LinkedIn
 * post or a caption, which is why "one piece of content, repurposed" was true
 * in conversation and invisible in the product. This is that link, made usable.
 *
 * Everything generated is a DRAFT. Approving is a status change, not a send.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, EmptyState, GhostBtn, Loading, PageHeader, PrimaryBtn, useToast } from '@/components/crm/kit';

type Article = { id: string; title: string; status: string; slug: string | null };
type Derivative = {
  id: string;
  kind: string;
  hook: string | null;
  body: string;
  cta: string | null;
  status: string;
  created_at: string;
};

const KIND_LABEL: Record<string, string> = {
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  facebook: 'Facebook',
  x: 'X',
  newsletter: 'Newsletter',
  substack_note: 'Substack note',
};

const ALL_KINDS = Object.keys(KIND_LABEL);

export default function RepurposePage() {
  const { show, node: toastNode } = useToast();
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [derivatives, setDerivatives] = useState<Derivative[] | null>(null);
  const [kinds, setKinds] = useState<string[]>(['linkedin', 'instagram', 'newsletter']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadArticles = useCallback(async () => {
    try {
      const res = await api<{ articles?: Article[]; content?: Article[] }>('/api/articles');
      const list = res.articles || res.content || [];
      setArticles(list);
      setSelected((cur) => cur ?? list[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load articles');
      setArticles([]);
    }
  }, []);

  const loadDerivatives = useCallback(async (id: string) => {
    setDerivatives(null);
    try {
      const res = await api<{ derivatives: Derivative[] }>(`/api/content/${id}/repurpose`);
      setDerivatives(res.derivatives);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load derivatives');
      setDerivatives([]);
    }
  }, []);

  useEffect(() => {
    void loadArticles();
  }, [loadArticles]);

  useEffect(() => {
    if (selected) void loadDerivatives(selected);
  }, [selected, loadDerivatives]);

  async function generate() {
    if (!selected || !kinds.length) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ created: unknown[]; errors: string[] }>(
        `/api/content/${selected}/repurpose`,
        { method: 'POST', body: JSON.stringify({ kinds }) }
      );
      show(`${res.created.length} drafted${res.errors.length ? ` · ${res.errors.length} failed` : ''}`);
      if (res.errors.length) setError(res.errors.join(' · '));
      await loadDerivatives(selected);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generation failed');
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id: string, status: string) {
    try {
      await api(`/api/crm/derivatives/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      if (selected) await loadDerivatives(selected);
    } catch (e) {
      show(e instanceof Error ? e.message : 'Could not update');
    }
  }

  const article = useMemo(
    () => (articles || []).find((a) => a.id === selected) || null,
    [articles, selected]
  );

  return (
    <div className="flex flex-col h-full">
      {toastNode}
      <PageHeader title="Repurpose">
        <div className="flex items-center gap-2">
          <GhostBtn onClick={() => selected && void loadDerivatives(selected)}>Refresh</GhostBtn>
          <PrimaryBtn onClick={() => void generate()} disabled={!selected || busy || !kinds.length}>
            {busy ? 'Writing…' : `Draft ${kinds.length} piece${kinds.length === 1 ? '' : 's'}`}
          </PrimaryBtn>
        </div>
      </PageHeader>

      <div className="flex-1 overflow-hidden px-12 pb-8">
        {error && (
          <div className="mb-4 border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-[13px] text-amber-300/90">
            {error}
          </div>
        )}

        {articles === null && <Loading />}

        {articles !== null && (
          <div className="grid h-full grid-cols-[250px_1fr] gap-8 overflow-hidden">
            {/* source */}
            <div className="overflow-y-auto pr-1">
              <p className="mb-2 text-[10px] uppercase tracking-wider text-zinc-600">Article</p>
              {articles.length === 0 && <p className="text-[13px] text-zinc-600">No articles yet.</p>}
              {articles.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setSelected(a.id)}
                  className={`block w-full py-1.5 text-left text-[13px] leading-snug transition-colors ${
                    selected === a.id ? 'text-white' : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {a.title}
                  <span className="ml-1.5 text-[10px] uppercase tracking-wider text-zinc-700">
                    {a.status}
                  </span>
                </button>
              ))}

              <p className="mt-6 mb-2 text-[10px] uppercase tracking-wider text-zinc-600">Formats</p>
              {ALL_KINDS.map((k) => (
                <label key={k} className="flex items-center gap-2 py-1 text-[13px] text-zinc-400">
                  <input
                    type="checkbox"
                    checked={kinds.includes(k)}
                    onChange={(e) =>
                      setKinds((cur) => (e.target.checked ? [...cur, k] : cur.filter((x) => x !== k)))
                    }
                  />
                  {KIND_LABEL[k]}
                </label>
              ))}
            </div>

            {/* derivatives */}
            <div className="overflow-y-auto pr-1">
              {article && (
                <p className="mb-4 text-[13px] text-zinc-500">
                  Made from <span className="text-white">{article.title}</span>
                </p>
              )}

              {derivatives === null && <Loading />}
              {derivatives !== null && derivatives.length === 0 && (
                <EmptyState
                  title="Nothing made from this one yet"
                  hint="Pick the formats on the left and draft them. Everything arrives as a draft — nothing posts itself."
                />
              )}

              <div className="space-y-4">
                {(derivatives || []).map((d) => (
                  <article key={d.id} className="border border-white/10 p-5">
                    <div className="mb-3 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="text-[13px] font-medium text-white">
                          {KIND_LABEL[d.kind] || d.kind}
                        </span>
                        <span className="text-[10px] uppercase tracking-wider text-zinc-600">
                          {d.status}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {d.status !== 'approved' && (
                          <GhostBtn onClick={() => void setStatus(d.id, 'approved')}>Approve</GhostBtn>
                        )}
                        {d.status !== 'archived' && (
                          <GhostBtn onClick={() => void setStatus(d.id, 'archived')}>Archive</GhostBtn>
                        )}
                        <GhostBtn
                          onClick={() => {
                            void navigator.clipboard.writeText(d.body);
                            show('Copied');
                          }}
                        >
                          Copy
                        </GhostBtn>
                      </div>
                    </div>
                    <p className="whitespace-pre-wrap text-[13px] leading-[1.7] text-zinc-300">
                      {d.body}
                    </p>
                    {d.cta && (
                      <p className="mt-3 border-t border-white/[0.06] pt-3 text-[12px] text-zinc-500">
                        {d.cta}
                      </p>
                    )}
                  </article>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
