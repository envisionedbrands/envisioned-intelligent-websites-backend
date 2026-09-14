'use client';

/**
 * Channel browser — paste a YouTube channel on the canvas and this panel
 * opens: the channel's latest videos with views and outlier multiples,
 * multi-select, "Add N to board" → they land as a labeled group of sources
 * (Poppy's contained collection, in our grammar: sources wired into a group).
 */
import { useEffect, useMemo, useState } from 'react';
import { studioErrorMessage, studioFetchJson } from '@/lib/studio/fetch-json';

export type ChannelVideo = {
  id: string;
  url: string;
  title: string;
  published: string | null;
  views: number;
  thumbnail: string;
  outlier: number;
};

type ChannelData = { channel: { id: string; title: string; url: string }; median: number; videos: ChannelVideo[] };

const fmtViews = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n);

const age = (iso: string | null) => {
  if (!iso) return '';
  const days = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 86400000));
  if (days < 1) return 'today';
  if (days < 31) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30.4)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
};

const MAX_ADD = 12;

export function ChannelBrowser({
  url,
  onClose,
  onAdd,
}: {
  url: string;
  onClose: () => void;
  onAdd: (channel: { title: string }, videos: ChannelVideo[], kind: string) => Promise<void>;
}) {
  const [data, setData] = useState<ChannelData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'latest' | 'outliers'>('latest');
  const [kind, setKind] = useState('competitor');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    studioFetchJson<ChannelData>(`/api/studio/channel?url=${encodeURIComponent(url)}`)
      .then(setData)
      .catch((e) => setError(studioErrorMessage(e, 'Could not load that channel.')));
  }, [url]);

  const videos = useMemo(() => {
    if (!data) return [];
    return tab === 'outliers' ? [...data.videos].sort((a, b) => b.outlier - a.outlier) : data.videos;
  }, [data, tab]);

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
          <div className="text-sm font-medium truncate">{data?.channel.title ?? 'Loading channel…'}</div>
          <div className="text-[11px] text-minimal-muted">
            {data ? `${data.videos.length} recent videos · median ${fmtViews(data.median)} views` : url}
          </div>
        </div>
        <button onClick={onClose} className="text-minimal-muted hover:text-minimal-accent text-lg leading-none" aria-label="Close">
          ×
        </button>
      </header>

      <div className="px-4 py-2 border-b border-minimal-border flex items-center gap-2">
        <div className="flex rounded border border-minimal-border overflow-hidden text-[12px]">
          {(['latest', 'outliers'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1 ${tab === t ? 'bg-minimal-accent text-minimal-bg font-medium' : 'hover:bg-white/5'}`}
            >
              {t === 'latest' ? 'Latest' : 'Outliers'}
            </button>
          ))}
        </div>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          aria-label="Source kind for added videos"
          className="ml-auto rounded border border-minimal-border bg-minimal-bg px-1.5 py-1 text-[11px] focus:outline-none"
        >
          <option value="competitor">Competitor</option>
          <option value="own">Own</option>
          <option value="inspiration">Inspiration</option>
        </select>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {error && <div className="text-[12px] text-red-500 p-2">{error}</div>}
        {!error && !data && <div className="text-[12px] text-minimal-muted p-2 animate-pulse">Fetching the channel feed…</div>}
        {videos.map((v) => {
          const on = picked.has(v.id);
          return (
            <button
              key={v.id}
              onClick={() => toggle(v.id)}
              className={`w-full text-left rounded-lg border overflow-hidden transition-colors ${
                on ? 'border-minimal-accent' : 'border-minimal-border hover:border-white/30'
              }`}
            >
              <div className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={v.thumbnail} alt="" className="w-full h-36 object-cover bg-black" loading="lazy" />
                <span
                  className={`absolute top-1.5 left-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    v.outlier >= 2
                      ? 'bg-emerald-500 text-white'
                      : v.outlier < 0.5
                        ? 'bg-red-500/90 text-white'
                        : 'bg-black/70 text-white'
                  }`}
                >
                  {v.outlier}×
                </span>
                <span className="absolute bottom-1.5 left-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">
                  {fmtViews(v.views)} views
                </span>
                <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">
                  {age(v.published)}
                </span>
                {on && (
                  <span className="absolute top-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-minimal-accent text-minimal-bg text-[11px]">
                    ✓
                  </span>
                )}
              </div>
              <div className="px-2.5 py-1.5 text-[12px] leading-snug line-clamp-2">{v.title}</div>
            </button>
          );
        })}
      </div>

      <div className="p-3 border-t border-minimal-border flex items-center gap-2">
        <button
          disabled={!picked.size || adding}
          onClick={async () => {
            if (!data) return;
            setAdding(true);
            try {
              await onAdd(
                { title: data.channel.title },
                data.videos.filter((v) => picked.has(v.id)),
                kind
              );
            } finally {
              setAdding(false);
            }
          }}
          className="flex-1 rounded bg-minimal-accent text-minimal-bg text-[13px] py-1.5 font-medium disabled:opacity-40"
        >
          {adding ? 'Adding…' : `Add ${picked.size || ''} selected to board`}
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
