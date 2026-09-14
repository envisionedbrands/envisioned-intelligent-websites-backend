'use client';

/**
 * Canvas tool rail — vertical icon stack on the canvas's top-RIGHT edge
 * (the left column belongs to the app shell's navigation; the right side is
 * the canvas's work side, where panels open). Every tool carries a hover
 * card: what it's called, what it does, and its shortcut key — the
 * point-of-decision explanation the old header chips never had room for.
 */
import type { ReactNode } from 'react';

export type RailTool = {
  key: string;
  label: string;
  description: string;
  shortcut?: string;
  icon: ReactNode;
  primary?: boolean;
  active?: boolean;
  activeLabel?: string;
  onClick: () => void;
};

export function ToolRail({ tools }: { tools: RailTool[] }) {
  return (
    <div className="absolute top-14 right-3 z-20 flex flex-col gap-1.5">
      {tools.map((t) => (
        <div key={t.key} className="relative group">
          <button
            type="button"
            aria-label={t.label}
            onClick={t.onClick}
            className={`flex h-9 w-9 items-center justify-center rounded-lg border shadow-sm transition-colors ${
              t.active
                ? 'border-red-500/70 text-red-500 animate-pulse bg-minimal-row'
                : t.primary
                  ? 'border-transparent bg-minimal-accent text-minimal-bg hover:opacity-90'
                  : 'border-minimal-border bg-minimal-row text-minimal-accent hover:bg-white/10'
            }`}
          >
            {t.icon}
          </button>
          <div className="pointer-events-none absolute right-full top-1/2 z-30 mr-2 w-60 -translate-y-1/2 rounded-lg border border-minimal-border bg-minimal-row p-2.5 opacity-0 shadow-xl transition-opacity duration-100 group-hover:opacity-100">
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-medium">{t.active ? (t.activeLabel ?? t.label) : t.label}</span>
              {t.shortcut && (
                <kbd className="ml-auto rounded border border-minimal-border bg-minimal-bg px-1.5 py-0.5 text-[10px] text-minimal-muted">
                  {t.shortcut}
                </kbd>
              )}
            </div>
            <div className="mt-1 text-[11px] leading-relaxed text-minimal-muted">{t.description}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// Compact stroke icons (Phosphor-style geometry, stroke = currentColor).
const cls = 'h-[18px] w-[18px]';
const strokeProps = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export const RAIL_ICONS = {
  desk: (
    <svg viewBox="0 0 24 24" className={cls} {...strokeProps}>
      <path d="M4 17V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10" />
      <path d="M2 17h20" />
      <path d="M8 9h8M8 12h5" />
    </svg>
  ),
  link: (
    <svg viewBox="0 0 24 24" className={cls} {...strokeProps}>
      <path d="M9 15l6-6" />
      <path d="M11 6l1.5-1.5a4 4 0 0 1 5.66 5.66L16.5 11.5" />
      <path d="M13 18l-1.5 1.5a4 4 0 0 1-5.66-5.66L7.5 12.5" />
    </svg>
  ),
  upload: (
    <svg viewBox="0 0 24 24" className={cls} {...strokeProps}>
      <path d="M12 15V4m0 0 4 4m-4-4L8 8" />
      <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
    </svg>
  ),
  article: (
    <svg viewBox="0 0 24 24" className={cls} {...strokeProps}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 8.5h8M8 12h8M8 15.5h5" />
    </svg>
  ),
  note: (
    <svg viewBox="0 0 24 24" className={cls} {...strokeProps}>
      <path d="M5 4h14a1 1 0 0 1 1 1v10l-5 5H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
      <path d="M15 20v-5h5" />
    </svg>
  ),
  instructions: (
    <svg viewBox="0 0 24 24" className={cls} {...strokeProps}>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 2.5h6v3H9z" />
      <path d="M9 11l1.8 1.8L14.5 9" />
      <path d="M9 16h6" />
    </svg>
  ),
  collection: (
    <svg viewBox="0 0 24 24" className={cls} {...strokeProps}>
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M7 8V6a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v2" />
      <path d="M10 3.5h4" />
    </svg>
  ),
};
