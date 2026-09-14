'use client';

/**
 * Compatibility door for Studio links created before 1.6.0.
 *
 * New links open the static /studio/workspace shell directly. Keeping this
 * tiny redirect means old bookmarks survive without pulling the canvas into
 * the server-rendered route again.
 */
import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import { replaceWithStudioWorkspace } from '@/lib/studio/workspace-navigation';

export default function LegacyStudioBoardPage() {
  const params = useParams<{ id: string }>();

  useEffect(() => {
    if (params.id) replaceWithStudioWorkspace(params.id);
  }, [params.id]);

  return (
    <div className="flex flex-1 items-center justify-center text-sm text-minimal-muted">
      Opening Studio…
    </div>
  );
}
