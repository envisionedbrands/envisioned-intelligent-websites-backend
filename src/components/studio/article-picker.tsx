'use client';

/**
 * Article picker — the home's own articles onto any board. Articles are
 * first-class citizens of the Digital Home, so pulling them into a canvas
 * can't be locked inside one template: this panel opens from the tool rail,
 * lists the blog, and lands picked articles as ready own-source cards.
 */
import { useEffect, useMemo, useState } from 'react';
import { studioErrorMessage, studioFetchJson } from '@/lib/studio/fetch-json';

type Article = {
  id: string;
  slug: string;
  title: string;
  status: 'draft' | 'published' | 'archived';
  published_at: string | null;
  created_at: string;
  view_count: number;
  featured_image_url: string | null;
};

const age = (iso: string | null) => {
  if (!iso) return '';
  const days = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 86400000));
  if (days < 1) return 'today';
  if (days < 31) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30.4)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
};

const MAX_ADD = 10;

export function ArticlePicker({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (ids: string[]) => void;
}) {
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    studioFetchJson<{ articles?: Article[] }>('/api/studio/articles')
      .then((j) => {
        setArticles(j.articles ?? []);
      })
      .catch((e) => setError(studioErrorMessage(e, 'Could not load your articles.')));
  }, []);

  const filtered = useMemo(() => {
    if (!articles) return [];
    const needle = q.trim().toLowerCase();
    return needle ? articles.filter((a) => a.title.toLowerCase().includes(needle)) : articles;
  }, [articles, q]);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else if (s.size < MAX_ADD) s.add(id);
      return s;
    });

  return (
    <aside className="shrink-0 w-[380px] border-l border-minimal-border bg-minimal-bg flex flex-col h-full">
      <header className="px-4 py-3 border-b border-minimal-border flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Your articles</div>
          <div className="text-[11px] text-minimal-muted">
            {articles ? `${articles.length} on the home — picked ones land as ready sources` : 'Loading the blog…'}
          </div>
        </div>
        <button onClick={onClose} className="text-minimal-muted hover:text-minimal-accent text-lg leading-none" aria-label="Close">
          ×
        </button>
      </header>

      <div className="px-4 py-2 border-b border-minimal-border">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search titles…"
          className="w-full rounded border border-minimal-border bg-minimal-row px-2.5 py-1.5 text-[12px] focus:outline-none focus:border-white/40"
        />
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {error && <div className="p-2 text-[12px] text-red-500">{error}</div>}
        {articles && filtered.length === 0 && (
          <div className="p-4 text-center text-[12px] text-minimal-muted">
            {q ? 'No titles match.' : 'No articles on the home yet — write one from Articles.'}
          </div>
        )}
        {filtered.map((a) => {
          const on = picked.has(a.id);
          return (
            <button
              key={a.id}
              onClick={() => toggle(a.id)}
              className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                on ? 'border-minimal-accent' : 'border-transparent hover:border-minimal-border'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px]">{a.title}</span>
                {on && (
                  <span className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full bg-minimal-accent text-[10px] text-minimal-bg">
                    ✓
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-minimal-muted">
                <span className={`h-1.5 w-1.5 rounded-full ${a.status === 'published' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                {a.status}
                <span>·</span>
                {age(a.published_at ?? a.created_at)}
                {a.view_count > 0 && (
                  <>
                    <span>·</span>
                    {a.view_count.toLocaleString()} views
                  </>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="p-3 border-t border-minimal-border flex items-center gap-2">
        <button
          disabled={!picked.size || adding}
          onClick={() => {
            setAdding(true);
            onAdd([...picked]);
          }}
          className="flex-1 rounded bg-minimal-accent text-minimal-bg text-[13px] py-1.5 font-medium disabled:opacity-40"
        >
          {adding ? 'Adding…' : `Add ${picked.size || ''} to board`}
        </button>
        {picked.size > 0 && (
          <button onClick={() => setPicked(new Set())} className="rounded border border-minimal-border px-3 py-1.5 text-[12px]">
            Clear
          </button>
        )}
      </div>
    </aside>
  );
}
