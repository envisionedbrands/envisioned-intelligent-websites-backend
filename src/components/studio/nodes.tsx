'use client';

/**
 * Content Studio custom nodes — Poppy grammar, house palette.
 * Colored header = node type; handles: right = feeds out, left = receives.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';
import { WritingGlow } from '@/components/ui/writing-glow';
import { CREATIVE_FORMATS, isCreativeFormatKey } from '@/lib/studio/creative-formats';
import { MAX_STUDIO_CONTEXT_TEXT_CHARS } from '@/lib/studio/text-limits';
import { renderStudioMarkdown } from '@/lib/studio/markdown';

export type SourceInfo = {
  id: string;
  url: string;
  platform: string;
  kind: string;
  status: string;
  title: string | null;
  author: string | null;
  analysis: { hook?: string; format?: string } | null;
  engagement: { views?: number | null; likes?: number | null } | null;
  job?: {
    stage: string;
    progress: number;
    status: string;
    needs_runner?: boolean;
    failure?: { code: string; message: string; retryable: boolean };
  } | null;
  thumbnail?: string | null;
};

const isVertical = (s?: SourceInfo) =>
  s?.platform === 'instagram' || s?.platform === 'tiktok' || (s?.platform === 'youtube' && s?.url?.includes('/shorts/'));

/** Uploaded files carry their medium in the stored file's extension. */
const uploadMedia = (s?: SourceInfo): 'image' | 'pdf' | 'voice' | null => {
  if (s?.platform !== 'upload' || !s.url) return null;
  if (/\.pdf(\?|$)/i.test(s.url)) return 'pdf';
  if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(s.url)) return 'image';
  return 'voice';
};

const UPLOAD_CHIP: Record<'image' | 'pdf' | 'voice', { label: string; chip: string }> = {
  image: { label: 'Image', chip: 'bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-950 dark:text-emerald-400 dark:border-emerald-900' },
  pdf: { label: 'PDF', chip: 'bg-orange-100 text-orange-700 border-orange-300 dark:bg-orange-950 dark:text-orange-400 dark:border-orange-900' },
  voice: { label: 'Voice note', chip: 'bg-indigo-100 text-indigo-700 border-indigo-300 dark:bg-indigo-950 dark:text-indigo-400 dark:border-indigo-900' },
};

const PLATFORM_STYLE: Record<string, { label: string; chip: string }> = {
  youtube: { label: 'YouTube', chip: 'bg-red-100 text-red-700 border-red-300 dark:bg-red-950 dark:text-red-400 dark:border-red-900' },
  instagram: { label: 'Instagram', chip: 'bg-pink-100 text-pink-700 border-pink-300 dark:bg-pink-950 dark:text-pink-400 dark:border-pink-900' },
  tiktok: { label: 'TikTok', chip: 'bg-teal-100 text-teal-700 border-teal-300 dark:bg-teal-950 dark:text-teal-300 dark:border-teal-900' },
  facebook_ads: { label: 'FB Ad', chip: 'bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-950 dark:text-blue-400 dark:border-blue-900' },
  website: { label: 'Website', chip: 'bg-sky-100 text-sky-700 border-sky-300 dark:bg-sky-950 dark:text-sky-400 dark:border-sky-900' },
  article: { label: 'Article', chip: 'bg-violet-100 text-violet-700 border-violet-300 dark:bg-violet-950 dark:text-violet-400 dark:border-violet-900' },
  upload: { label: 'Upload', chip: 'bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-900 dark:text-zinc-400 dark:border-zinc-800' },
};

const STATUS_DOT: Record<string, string> = {
  ready: 'bg-emerald-500',
  pending: 'bg-amber-500 animate-pulse',
  ingesting: 'bg-amber-500 animate-pulse',
  failed: 'bg-red-500',
};

const shell = (selected: boolean) =>
  `rounded-lg border bg-minimal-row text-minimal-accent shadow-lg transition-colors ${
    selected ? 'border-black/40 dark:border-white/60' : 'border-minimal-border'
  }`;

const safeFilename = (text: string, fallback: string) => {
  const firstLine = text.split('\n').find((line) => line.trim()) ?? fallback;
  const cleaned = firstLine
    .replace(/^#{1,6}\s+/, '')
    .replace(/[*_`>\[\]()]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 72);
  return cleaned || fallback;
};

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const stripInlineMarkdown = (text: string) =>
  text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`|~~)/g, '')
    .trim();

async function copyNote(text: string, plain = false) {
  if (!plain && navigator.clipboard.write && typeof ClipboardItem !== 'undefined') {
    const html = renderStudioMarkdown(text);
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      }),
    ]);
    return;
  }
  await navigator.clipboard.writeText(text);
}

async function downloadNoteAsWord(text: string, filename: string) {
  const { Document, HeadingLevel, Packer, Paragraph } = await import('docx');
  const headingLevels = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
    HeadingLevel.HEADING_5,
    HeadingLevel.HEADING_6,
  ];
  const paragraphs = text.split('\n').map((line) => {
    const heading = line.match(/^(#{1,6})\s+(.+)/);
    if (heading) {
      return new Paragraph({ text: stripInlineMarkdown(heading[2]), heading: headingLevels[heading[1].length - 1] });
    }
    const bullet = line.match(/^\s*[-*+]\s+(.+)/);
    if (bullet) return new Paragraph({ text: stripInlineMarkdown(bullet[1]), bullet: { level: 0 } });
    return new Paragraph({ text: stripInlineMarkdown(line) });
  });
  const doc = new Document({ sections: [{ properties: {}, children: paragraphs }] });
  downloadBlob(await Packer.toBlob(doc), `${filename}.docx`);
}

export function SourceNode({ data, selected }: NodeProps) {
  const sourceData = data as { source?: SourceInfo; onRetry?: (source: SourceInfo) => void };
  const source = sourceData.source;
  const media = uploadMedia(source);
  const p = media ? UPLOAD_CHIP[media] : (PLATFORM_STYLE[source?.platform ?? 'upload'] ?? PLATFORM_STYLE.upload);
  return (
    <div className={`${shell(!!selected)} w-64`}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-minimal-border">
        <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${p.chip}`}>{p.label}</span>
        <span className="text-[10px] uppercase tracking-wide text-minimal-muted">{source?.kind}</span>
        <span className={`ml-auto w-2 h-2 rounded-full ${STATUS_DOT[source?.status ?? 'pending'] ?? 'bg-zinc-600'}`} />
      </div>
      {source?.thumbnail && (
        <div className={`w-full overflow-hidden bg-black ${media === 'image' ? 'h-44' : isVertical(source) ? 'h-56' : 'h-32'}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={source.thumbnail}
            alt=""
            className={`w-full h-full ${media === 'image' ? 'object-contain' : 'object-cover'}`}
            loading="lazy"
            draggable={false}
            onError={(e) => {
              (e.target as HTMLImageElement).parentElement!.style.display = 'none';
            }}
          />
        </div>
      )}
      {!source?.thumbnail && (media === 'pdf' || media === 'voice') && (
        <div className="flex items-center justify-center h-14 border-b border-minimal-border text-2xl select-none">
          {media === 'pdf' ? '📄' : '🎙️'}
        </div>
      )}
      <div className="px-3 py-2.5">
        <div className="text-[13px] leading-snug line-clamp-2">{source?.title ?? source?.url ?? 'Loading…'}</div>
        {source?.status === 'ingesting' || source?.status === 'pending' ? (
          <div className="mt-1.5">
            <div className={`text-[11px] ${source?.job?.needs_runner ? 'text-red-500' : 'text-amber-500'}`}>
              {source?.job?.stage ?? 'Added — fetching shortly'}
            </div>
            <div className="mt-1 h-0.5 rounded bg-minimal-border overflow-hidden">
              <div className="h-full bg-amber-500 transition-all" style={{ width: `${source?.job?.progress ?? 2}%` }} />
            </div>
          </div>
        ) : source?.status === 'failed' ? (
          <div className="mt-1.5 text-[11px] text-red-500">
            <div>{source.job?.failure?.message ?? 'This source could not be ingested.'}</div>
            {source.job?.failure?.retryable !== false && sourceData.onRetry && (
              <button
                type="button"
                className="nodrag mt-2 rounded border border-red-400/60 px-2 py-1 font-medium hover:bg-red-500 hover:text-white"
                onClick={(event) => {
                  event.stopPropagation();
                  sourceData.onRetry?.(source);
                }}
              >
                Retry
              </button>
            )}
          </div>
        ) : (
          <div className="mt-1.5 text-[11px] text-minimal-muted line-clamp-2">
            {source?.analysis?.hook ? `“${source.analysis.hook}”` : source?.author ?? ''}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-white/70 !w-2.5 !h-2.5" />
    </div>
  );
}

function TextishNode({ data, selected, kind }: NodeProps & { kind: 'note' | 'sop' }) {
  const d = data as { text?: string; onChange?: (v: string) => void };
  const isSop = kind === 'sop';
  const [editing, setEditing] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [actionState, setActionState] = useState<string | null>(null);
  const noteText = d.text ?? '';
  const legacyOversized = noteText.length > MAX_STUDIO_CONTEXT_TEXT_CHARS;
  const noteFilename = safeFilename(noteText, isSop ? 'studio-instructions' : 'studio-note');
  const finishAction = (label: string) => {
    setActionState(label);
    setTimeout(() => setActionState(null), 1800);
  };
  return (
    <div className={`${shell(!!selected)} w-full h-full min-w-[264px] min-h-[120px] flex flex-col`}>
      <NodeResizer isVisible={!!selected} minWidth={264} minHeight={120} lineClassName="!border-white/30" handleClassName="!bg-white/70 !w-2 !h-2 !border-none" />
      <div className="relative flex items-center gap-2 px-3 py-2 border-b border-minimal-border shrink-0">
        <span
          className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${
            isSop ? 'bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-900' : 'bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-900 dark:text-zinc-300 dark:border-zinc-700'
          }`}
        >
          {isSop ? 'Instructions' : 'Note'}
        </span>
        <span className="ml-auto text-[10px] text-minimal-muted">
          {actionState
            ?? (legacyOversized
              ? `${noteText.length.toLocaleString()} / ${MAX_STUDIO_CONTEXT_TEXT_CHARS.toLocaleString()} · legacy preserved`
              : editing
                ? `${noteText.length.toLocaleString()} / ${MAX_STUDIO_CONTEXT_TEXT_CHARS.toLocaleString()} · click away to finish`
                : 'double-click to edit')}
        </span>
        {noteText && !editing && (
          <>
            <button
              type="button"
              className="nodrag rounded p-1 text-minimal-muted hover:bg-white/5 hover:text-minimal-accent"
              aria-label={`Copy ${isSop ? 'instructions' : 'note'} with formatting`}
              title="Copy with formatting"
              onClick={async () => {
                await copyNote(noteText).catch(() => copyNote(noteText, true));
                finishAction('Copied');
              }}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="8" y="8" width="11" height="11" rx="2" />
                <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
              </svg>
            </button>
            <button
              type="button"
              className="nodrag rounded p-1 text-minimal-muted hover:bg-white/5 hover:text-minimal-accent"
              aria-label={`Export ${isSop ? 'instructions' : 'note'}`}
              title={`Export ${isSop ? 'instructions' : 'note'}`}
              onClick={() => setShowExport((value) => !value)}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M12 15V3m0 0 4 4m-4-4L8 7" />
                <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
              </svg>
            </button>
            {showExport && (
              <div className="nodrag absolute right-2 top-[calc(100%+6px)] z-30 w-52 rounded-lg border border-minimal-border bg-minimal-bg p-1 text-[11px] shadow-xl">
                {[
                  {
                    label: 'Copy with formatting',
                    run: async () => copyNote(noteText).catch(() => copyNote(noteText, true)),
                  },
                  { label: 'Copy as plain text', run: async () => copyNote(noteText, true) },
                  {
                    label: 'Download Markdown (.md)',
                    run: async () => downloadBlob(new Blob([noteText], { type: 'text/markdown;charset=utf-8' }), `${noteFilename}.md`),
                  },
                  {
                    label: 'Download Word (.docx)',
                    run: async () => downloadNoteAsWord(noteText, noteFilename),
                  },
                  {
                    label: 'Download plain text (.txt)',
                    run: async () => downloadBlob(new Blob([noteText], { type: 'text/plain;charset=utf-8' }), `${noteFilename}.txt`),
                  },
                ].map((action) => (
                  <button
                    type="button"
                    key={action.label}
                    className="block w-full rounded px-2.5 py-1.5 text-left hover:bg-white/5"
                    onClick={async () => {
                      setShowExport(false);
                      await action.run();
                      finishAction(action.label.startsWith('Copy') ? 'Copied' : 'Downloaded');
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {legacyOversized && (
        <div className="border-b border-amber-400/40 bg-amber-500/10 px-3 py-2 text-[10px] leading-relaxed text-amber-700 dark:text-amber-400">
          This older card is above today&apos;s limit and remains intact. Copy or export it first, then replace it with
          {` ${MAX_STUDIO_CONTEXT_TEXT_CHARS.toLocaleString()} characters or fewer`} to edit.
        </div>
      )}
      {editing ? (
        <textarea
          autoFocus
          className="nodrag nowheel flex-1 w-full bg-transparent px-3 py-2 text-[12px] leading-relaxed text-minimal-accent placeholder:text-minimal-muted resize-none focus:outline-none"
          placeholder={
            isSop
              ? 'Rules the wired desk always follows — tone, structure, do’s and don’ts…'
              : 'Write anything — a wired desk reads this as context…'
          }
          value={d.text ?? ''}
          maxLength={legacyOversized ? undefined : MAX_STUDIO_CONTEXT_TEXT_CHARS}
          onChange={(e) => {
            if (e.target.value.length > MAX_STUDIO_CONTEXT_TEXT_CHARS) {
              finishAction(`Limit: ${MAX_STUDIO_CONTEXT_TEXT_CHARS.toLocaleString()} characters`);
              return;
            }
            d.onChange?.(e.target.value);
          }}
          onBlur={() => setEditing(false)}
        />
      ) : (
        <div
          className="nodrag nowheel flex-1 overflow-y-auto px-3 py-2 cursor-text"
          onDoubleClick={() => setEditing(true)}
        >
          {d.text ? (
            <div
              className="agent-md text-[12px] leading-relaxed"
              dangerouslySetInnerHTML={{ __html: renderStudioMarkdown(d.text) }}
            />
          ) : (
            <span className="text-[12px] text-minimal-muted">
              {isSop
                ? 'Rules the wired desk always follows — tone, structure, do’s and don’ts. Double-click to write them.'
                : 'Double-click to write. Wire it into a desk and the desk reads it as context.'}
            </span>
          )}
        </div>
      )}
      <Handle type="target" position={Position.Left} className="!bg-white/70 !w-2.5 !h-2.5" />
      <Handle type="source" position={Position.Right} className="!bg-white/70 !w-2.5 !h-2.5" />
    </div>
  );
}

export function NoteNode(props: NodeProps) {
  return <TextishNode {...props} kind="note" />;
}
export function SopNode(props: NodeProps) {
  return <TextishNode {...props} kind="sop" />;
}

export function GroupNode({ data, selected }: NodeProps) {
  const d = data as { label?: string; onChange?: (v: string) => void; memberCount?: number; auto?: string };
  const live = d.auto === 'best_performers';
  return (
    <div
      className={`rounded-xl border-2 border-dashed ${
        selected ? 'border-white/50' : live ? 'border-emerald-900' : 'border-minimal-border'
      } bg-minimal-row/60 w-64 p-4`}
    >
      <div className="flex items-center gap-2">
        <input
          className="nodrag w-full bg-transparent text-[12px] uppercase tracking-wide text-minimal-accent placeholder:text-minimal-muted focus:outline-none"
          value={d.label ?? ''}
          placeholder="Collection name"
          onChange={(e) => d.onChange?.(e.target.value)}
        />
        {live && (
          <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded border bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-950 dark:text-emerald-400 dark:border-emerald-900">
            Live
          </span>
        )}
      </div>
      <div className="mt-1.5 text-[11px] text-minimal-muted">
        {live
          ? 'Always your current top 5 own sources by engagement — self-curating.'
          : d.memberCount
            ? `${d.memberCount} wired in — feeds a desk as one bundle`
            : 'Drag wires from sources into this collection, then one wire from here into a desk.'}
      </div>
      <Handle type="target" position={Position.Left} className="!bg-white/70 !w-2.5 !h-2.5" />
      <Handle type="source" position={Position.Right} className="!bg-white/70 !w-2.5 !h-2.5" />
    </div>
  );
}

export type DeskInfo = { id: string; name: string; persona: string; model: string; preview?: string | null };

export function DeskNode({ data, selected }: NodeProps) {
  const d = data as { desk?: DeskInfo; onOpen?: () => void; busy?: boolean };
  return (
    <div className={`${shell(!!selected)} relative w-64`}>
      {d.busy && <WritingGlow />}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-minimal-border">
        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border bg-indigo-100 text-indigo-700 border-indigo-300 dark:bg-indigo-950 dark:text-indigo-300 dark:border-indigo-900">
          Desk
        </span>
        {d.busy && <span className="text-[10px] text-emerald-600 dark:text-emerald-400 animate-pulse">working…</span>}
        {d.desk?.persona && d.desk.persona !== 'none' && (
          <span className="text-[10px] text-minimal-muted">{d.desk.persona}</span>
        )}
      </div>
      <div className="px-3 py-2.5">
        <div className="text-[13px] font-medium">{d.desk?.name ?? 'Desk'}</div>
        <div className="mt-0.5 text-[11px] text-minimal-muted">{d.desk?.model}</div>
        {d.desk?.preview && (
          <div className="mt-1.5 text-[11px] text-minimal-muted italic line-clamp-3 border-l-2 border-minimal-border pl-2">
            {d.desk.preview}
          </div>
        )}
        <button
          className="nodrag mt-2 w-full rounded border border-minimal-border px-2 py-1 text-[11px] text-minimal-accent hover:bg-white/5"
          onClick={d.onOpen}
        >
          Open desk
        </button>
      </div>
      <Handle type="target" position={Position.Left} className="!bg-white/70 !w-2.5 !h-2.5" />
      <Handle type="source" position={Position.Right} className="!bg-white/70 !w-2.5 !h-2.5" />
    </div>
  );
}

export type OutputStatus = {
  status: string;
  detail?: string | null;
  progress?: number | null;
  title?: string;
  action_id?: string | null;
  executor?: string;
  contact_sheet_url?: string | null;
  slide_urls?: string[] | null;
  slide_total?: number | null;
};

const OUTPUT_STYLE: Record<string, { label: string; chip: string }> = {
  calendar_topic: { label: 'Calendar', chip: 'bg-violet-100 text-violet-700 border-violet-300 dark:bg-violet-950 dark:text-violet-300 dark:border-violet-900' },
  carousel_job: { label: 'Carousel', chip: 'bg-pink-100 text-pink-700 border-pink-300 dark:bg-pink-950 dark:text-pink-300 dark:border-pink-900' },
  social_post: { label: 'Social draft', chip: 'bg-sky-100 text-sky-700 border-sky-300 dark:bg-sky-950 dark:text-sky-300 dark:border-sky-900' },
  email_batch: { label: 'Email batch', chip: 'bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-900' },
  broadcast: { label: 'Broadcast', chip: 'bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-900' },
};

const OUTPUT_DONE = ['published', 'ready', 'approved', 'planned', 'processed'];

/**
 * Slide viewer — the social calendar's review pager (4:5 frame, ‹ › arrows,
 * n/N counter) as an in-app overlay, so reviewing a carousel never means ten
 * browser tabs. Esc closes, arrow keys flick.
 */
function SlideViewer({ urls, start, onClose }: { urls: string[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(start);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setI((x) => (x + 1) % urls.length);
      if (e.key === 'ArrowLeft') setI((x) => (x - 1 + urls.length) % urls.length);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [urls.length, onClose]);
  return createPortal(
    <div
      className="nodrag nopan fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="relative" onClick={(e) => e.stopPropagation()}>
        {/* Slides are 4:5 — shown uncropped, the way IG renders them */}
        <div className="h-[80vh] max-w-[90vw] aspect-[4/5] overflow-hidden rounded-xl border border-white/10 bg-black">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={urls[i]} alt={`Slide ${i + 1}`} className="h-full w-full object-contain" draggable={false} />
        </div>
        {urls.length > 1 && (
          <>
            <button
              type="button"
              aria-label="Previous slide"
              onClick={() => setI((i - 1 + urls.length) % urls.length)}
              className="absolute -left-12 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-lg text-white hover:bg-white/25"
            >
              ‹
            </button>
            <button
              type="button"
              aria-label="Next slide"
              onClick={() => setI((i + 1) % urls.length)}
              className="absolute -right-12 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-lg text-white hover:bg-white/25"
            >
              ›
            </button>
            <div className="absolute -bottom-8 left-1/2 flex -translate-x-1/2 items-center gap-1.5">
              {urls.map((_, d) => (
                <button
                  key={d}
                  aria-label={`Slide ${d + 1}`}
                  onClick={() => setI(d)}
                  className={`h-1.5 rounded-full transition-all ${d === i ? 'w-4 bg-white' : 'w-1.5 bg-white/40 hover:bg-white/70'}`}
                />
              ))}
            </div>
          </>
        )}
        <span className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-white">
          {i + 1}/{urls.length}
        </span>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute -top-10 right-0 flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/25"
        >
          ×
        </button>
      </div>
    </div>,
    document.body
  );
}

export function OutputNode({ data, selected }: NodeProps) {
  const d = data as {
    output_type?: string;
    ref_id?: string;
    title?: string;
    live?: OutputStatus;
    onReview?: () => void;
    onDecide?: (decision: 'approve' | 'reject', scheduledAt?: string) => void;
  };
  const style = OUTPUT_STYLE[d.output_type ?? ''] ?? { label: 'Output', chip: 'bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-900 dark:text-zinc-300 dark:border-zinc-700' };
  const live = d.live;
  const [viewer, setViewer] = useState<number | null>(null);
  // Approve is a two-beat decision: yes, and WHEN — publish now or schedule.
  const [scheduling, setScheduling] = useState(false);
  const [when, setWhen] = useState('');
  const [scheduleMin, setScheduleMin] = useState('');
  const failed = live?.status === 'failed' || live?.status === 'rejected';
  const done = live && OUTPUT_DONE.includes(live.status);
  return (
    <div className={`${shell(!!selected)} w-60`}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-minimal-border">
        <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${style.chip}`}>{style.label}</span>
        <span
          className={`ml-auto w-2 h-2 rounded-full ${
            failed ? 'bg-red-500' : done ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'
          }`}
        />
      </div>
      <div className="px-3 py-2.5">
        <div className="text-[13px] leading-snug line-clamp-2">{live?.title ?? d.title ?? '…'}</div>
        <div className={`mt-1.5 text-[11px] ${failed ? 'text-red-500' : 'text-minimal-muted'}`}>
          {live ? `${live.status}${live.detail ? ` — ${live.detail}` : ''}` : 'Linking…'}
        </div>
        {typeof live?.progress === 'number' && live.progress > 0 && live.progress < 100 && (
          <div className="mt-1.5 h-0.5 rounded bg-minimal-border overflow-hidden">
            <div className="h-full bg-amber-500 transition-all" style={{ width: `${live.progress}%` }} />
          </div>
        )}
        {(d.output_type === 'email_batch' || d.output_type === 'broadcast') && live?.status === 'awaiting approval' && d.onReview && (
          <button
            className="nodrag mt-2 w-full rounded bg-minimal-accent text-minimal-bg text-[11px] py-1 font-medium"
            onClick={d.onReview}
          >
            Review &amp; approve
          </button>
        )}
        {/* Live filmstrip: slides land on the node AS the hire renders them —
            placeholders shimmer, thumbnails fill in, "n of N ready". */}
        {d.output_type === 'carousel_job' &&
          !live?.contact_sheet_url &&
          ((live?.slide_urls?.length ?? 0) > 0 || (live?.slide_total ?? 0) > 0) && (
            <div className="mt-2">
              <div className="mb-1 text-[10px] text-minimal-muted">
                {live!.slide_urls?.length ?? 0} of {live!.slide_total ?? live!.slide_urls?.length ?? '?'} slides ready
              </div>
              <div className="nodrag flex gap-1 overflow-x-auto pb-1">
                {Array.from({
                  length: Math.max(live!.slide_total ?? 0, live!.slide_urls?.length ?? 0),
                }).map((_, i) => {
                  const url = live!.slide_urls?.[i];
                  return url ? (
                    <button key={i} type="button" onClick={() => setViewer(i)} className="shrink-0" aria-label={`Review slide ${i + 1}`}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={url}
                        alt={`Slide ${i + 1}`}
                        className="h-16 w-[52px] rounded border border-minimal-border object-cover bg-black hover:border-white/50"
                        loading="lazy"
                        draggable={false}
                      />
                    </button>
                  ) : (
                    <div
                      key={i}
                      className="h-16 w-[52px] shrink-0 rounded border border-minimal-border bg-gradient-to-br from-white/[0.09] to-white/[0.02] animate-pulse"
                    />
                  );
                })}
              </div>
            </div>
          )}
        {/* §13: a board-born carousel comes home — the hire's contact sheet
            renders on the node and the yes happens right here. */}
        {d.output_type === 'carousel_job' && live?.contact_sheet_url && (
          <button
            type="button"
            className="nodrag block mt-2 w-full"
            aria-label="Review the carousel"
            onClick={() => {
              if (live.slide_urls?.length) setViewer(0);
              else window.open(live.contact_sheet_url!, '_blank', 'noopener,noreferrer');
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={live.contact_sheet_url}
              alt="Carousel contact sheet"
              className="w-full max-h-44 object-contain rounded border border-minimal-border bg-black"
              loading="lazy"
              draggable={false}
            />
          </button>
        )}
        {viewer !== null && live?.slide_urls?.length ? (
          <SlideViewer urls={live.slide_urls} start={viewer} onClose={() => setViewer(null)} />
        ) : null}
        {d.output_type === 'carousel_job' && live?.status === 'ready for review' && d.onDecide && (
          scheduling ? (
            <div className="nodrag mt-2 space-y-1.5">
              <button
                className="w-full rounded bg-minimal-accent text-minimal-bg text-[11px] py-1 font-medium"
                onClick={() => {
                  setScheduling(false);
                  d.onDecide?.('approve');
                }}
              >
                Publish now
              </button>
              <div className="flex gap-1.5">
                <input
                  type="datetime-local"
                  value={when}
                  min={scheduleMin}
                  onChange={(e) => setWhen(e.target.value)}
                  className="min-w-0 flex-1 rounded border border-minimal-border bg-minimal-bg px-1.5 py-0.5 text-[11px] focus:outline-none focus:border-white/40"
                  aria-label="Schedule the publish"
                />
                <button
                  disabled={!when}
                  className="rounded border border-minimal-border px-2 text-[11px] disabled:opacity-40 hover:bg-white/5"
                  onClick={() => {
                    setScheduling(false);
                    d.onDecide?.('approve', new Date(when).toISOString());
                  }}
                >
                  Schedule
                </button>
              </div>
              <button className="w-full text-[10px] text-minimal-muted hover:text-minimal-accent" onClick={() => setScheduling(false)}>
                Back
              </button>
            </div>
          ) : (
            <div className="mt-2 flex gap-1.5">
              <button
                className="nodrag flex-1 rounded bg-minimal-accent text-minimal-bg text-[11px] py-1 font-medium"
                onClick={() => {
                  setScheduleMin(new Date(Date.now() + 5 * 60000).toISOString().slice(0, 16));
                  setScheduling(true);
                }}
              >
                Approve…
              </button>
              <button
                className="nodrag rounded border border-minimal-border px-2.5 text-[11px] text-minimal-muted hover:text-red-500"
                onClick={() => d.onDecide?.('reject')}
              >
                Reject
              </button>
            </div>
          )
        )}
      </div>
      <Handle type="target" position={Position.Left} className="!bg-white/70 !w-2.5 !h-2.5" />
    </div>
  );
}

const creativePromptParts = (prompt?: string) => {
  const match = prompt?.match(/^\[([^\]]+)]\s*([\s\S]*)$/);
  return { label: match?.[1] ?? null, description: match?.[2] ?? prompt ?? '' };
};

async function downloadCreative(url: string, filename: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('download failed');
    const blob = await response.blob();
    const extension = blob.type.includes('jpeg') ? 'jpg' : blob.type.includes('webp') ? 'webp' : 'png';
    downloadBlob(blob, `${filename}.${extension}`);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export function CreativeNode({ data, selected }: NodeProps) {
  const d = data as {
    image_url?: string;
    prompt?: string;
    failed?: string;
    width?: number;
    height?: number;
    asset_type?: string;
  };
  const [inspecting, setInspecting] = useState(false);
  const pending = !d.image_url && !d.failed;
  const prompt = creativePromptParts(d.prompt);
  const format = isCreativeFormatKey(d.asset_type) ? CREATIVE_FORMATS[d.asset_type] : null;
  // Pending skeletons take the requested format's shape (a thumbnail skeleton
  // is wide, a story skeleton tall) so the canvas doesn't jump on arrival.
  const formatSize =
    format && typeof format.imageSize === 'object' && format.imageSize ? format.imageSize : null;
  const ratio = d.width && d.height ? d.width / d.height : formatSize ? formatSize.width / formatSize.height : 4 / 3;
  const cardWidth = ratio >= 1.5 ? 'w-80' : ratio <= 0.85 ? 'w-56' : 'w-64';
  const filename = safeFilename(prompt.label ?? prompt.description, 'studio-creative');
  return (
    <div className={`${shell(!!selected)} ${cardWidth}`}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-minimal-border">
        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border bg-fuchsia-100 text-fuchsia-700 border-fuchsia-300 dark:bg-fuchsia-950 dark:text-fuchsia-300 dark:border-fuchsia-900">
          {format?.shortLabel ?? 'Creative'}
        </span>
        {pending && <span className="w-2 h-2 rounded-full bg-fuchsia-400 animate-pulse ml-auto" />}
        {d.failed && <span className="w-2 h-2 rounded-full bg-red-500 ml-auto" />}
        {d.image_url && (
          <button
            type="button"
            className="nodrag ml-auto text-[10px] text-minimal-muted hover:text-minimal-accent"
            onClick={() => setInspecting(true)}
          >
            inspect ↗
          </button>
        )}
      </div>
      {d.image_url ? (
        <button
          type="button"
          className="nodrag block w-full overflow-hidden bg-black"
          style={{ aspectRatio: String(ratio) }}
          onClick={() => setInspecting(true)}
          aria-label="Inspect generated creative"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={d.image_url} alt={d.prompt ?? 'Generated creative'} className="h-full w-full object-contain" loading="lazy" draggable={false} />
        </button>
      ) : d.failed ? (
        <div className="min-h-24 grid place-items-center px-3 py-3 text-center text-[11px] text-red-500">
          Generation failed — {d.failed}
        </div>
      ) : (
        <div className="p-2">
          <div
            className="rounded bg-gradient-to-br from-white/[0.09] via-white/[0.02] to-white/[0.07] animate-pulse grid place-items-center"
            style={{ aspectRatio: String(ratio) }}
          >
            <span className="text-[11px] text-minimal-muted">
              {format ? `${format.shortLabel} · ` : ''}fal is rendering…
            </span>
          </div>
        </div>
      )}
      {d.prompt && (
        <div className="px-3 py-2">
          {prompt.label && <div className="truncate text-[11px] font-medium">{prompt.label}</div>}
          <div className="line-clamp-2 text-[10px] text-minimal-muted" title={prompt.description}>{prompt.description}</div>
          {(d.width || format) && (
            <div className="mt-1 text-[9px] uppercase tracking-wide text-minimal-muted">
              {d.width && d.height ? `${d.width}×${d.height}` : format?.detail}
            </div>
          )}
        </div>
      )}
      <Handle type="target" position={Position.Left} className="!bg-white/70 !w-2.5 !h-2.5" />
      <Handle type="source" position={Position.Right} className="!bg-white/70 !w-2.5 !h-2.5" />
      {inspecting && d.image_url && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[100] grid place-items-center bg-black/75 p-6" onClick={() => setInspecting(false)}>
          <div
            className="nodrag flex max-h-[92vh] w-[1040px] max-w-[96vw] flex-col overflow-hidden rounded-xl border border-minimal-border bg-minimal-bg shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-minimal-border px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-[14px] font-medium">{prompt.label ?? format?.label ?? 'Generated creative'}</div>
                <div className="text-[11px] text-minimal-muted">
                  {[format?.label, d.width && d.height ? `${d.width}×${d.height}` : null].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  className="rounded border border-minimal-border px-3 py-1.5 text-[11px] hover:bg-white/5"
                  onClick={() => downloadCreative(d.image_url!, filename)}
                >
                  Download original
                </button>
                <button
                  type="button"
                  className="rounded border border-minimal-border px-3 py-1.5 text-[11px] hover:bg-white/5"
                  onClick={() => navigator.clipboard.writeText(prompt.description)}
                >
                  Copy prompt
                </button>
                <a
                  href={d.image_url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded border border-minimal-border px-3 py-1.5 text-[11px] hover:bg-white/5"
                >
                  Open original ↗
                </a>
                <button type="button" className="px-2 text-minimal-muted hover:text-minimal-accent" onClick={() => setInspecting(false)} aria-label="Close inspector">✕</button>
              </div>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
              <div className="grid min-h-0 place-items-center overflow-auto bg-black p-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={d.image_url} alt={d.prompt ?? 'Generated creative'} className="max-h-[72vh] max-w-full object-contain" />
              </div>
              <div className="min-h-0 overflow-y-auto border-l border-minimal-border p-4">
                <div className="text-[10px] uppercase tracking-wide text-minimal-muted">Generation prompt</div>
                <div className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-minimal-accent">{prompt.description}</div>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// NB: canvas type names dodge React Flow's built-ins ('group' AND 'output'
// are reserved — their default wrapper styling double-boxes custom
// components registered under those names). DB kinds stay 'group'/'output';
// the canvas renders them as 'cluster'/'mirror'.
export const NODE_TYPES = {
  source: SourceNode,
  note: NoteNode,
  sop: SopNode,
  cluster: GroupNode,
  desk: DeskNode,
  mirror: OutputNode,
  creative: CreativeNode,
};
