import { NextRequest, NextResponse } from 'next/server';
import { studioMachineAuth } from '@/lib/studio/auth';
import { createAdminClient } from '@/lib/supabase/server';
import { cleanupStudioUploads } from '@/lib/studio/upload-cleanup';

/** Machine-only bounded sweep, called by the local runner's full pass. */
export async function POST(request: NextRequest) {
  const auth = studioMachineAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });

  try {
    const summary = await cleanupStudioUploads(createAdminClient(), { batchSize: 10 });
    return NextResponse.json({ ok: true, ...summary }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[studio-uploads] autonomous cleanup failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Studio upload cleanup could not run just now.', code: 'upload_cleanup_unavailable' },
      { status: 503 },
    );
  }
}
