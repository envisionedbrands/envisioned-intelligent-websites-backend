'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useState } from 'react';

const StudioBoard = dynamic(() => import('@/components/studio/studio-board'), {
  ssr: false,
  loading: () => (
    <div className="flex flex-1 items-center justify-center text-sm text-minimal-muted">
      Opening canvas…
    </div>
  ),
});

const readBoardId = () => {
  if (typeof window === 'undefined') return '';
  try {
    return decodeURIComponent(window.location.hash.replace(/^#/, ''));
  } catch {
    return '';
  }
};

export function StudioWorkspace() {
  const [boardId, setBoardId] = useState('');

  useEffect(() => {
    const sync = () => setBoardId(readBoardId());
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  if (!boardId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-minimal-muted">
        <span>No Studio board was selected.</span>
        <Link href="/studio" className="rounded border border-minimal-border px-3 py-1.5 text-minimal-accent">
          Back to boards
        </Link>
      </div>
    );
  }

  // A hash change selects a different persisted board inside the same static
  // workspace shell. Remount the canvas so no save timer, recovery base,
  // React Flow state, or open desk from the previous board can cross that
  // boundary while the next board is loading.
  return <StudioBoard key={boardId} boardId={boardId} />;
}
