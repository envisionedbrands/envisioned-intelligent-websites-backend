/**
 * POST /api/studio/upload — the control plane for direct Studio uploads.
 *
 * `prepare` records the selected file before returning a short-lived signed
 * upload token. The browser sends the bytes straight to Supabase Storage.
 * `complete` accepts only that receipt id, verifies Storage's authoritative
 * size and MIME, then atomically creates the source and optional PDF job.
 * No file body or media processing passes through Cloudflare.
 */
import { NextRequest, NextResponse } from 'next/server';
import { studioAuth } from '@/lib/studio/auth';
import { createAdminClient } from '@/lib/supabase/server';
import { studioContextTextError } from '@/lib/studio/text-limits';
import {
  cleanupStudioUploads,
  removeStudioUploadReceiptObject,
  type StudioUploadCleanupReceipt,
} from '@/lib/studio/upload-cleanup';
import {
  classifyUpload,
  isLegacyStudioUploadPath,
  isStudioUploadPath,
  STUDIO_UPLOAD_BUCKET,
  STUDIO_UPLOAD_RECEIPT_TTL_MS,
  removeUploadObjectWithRetries,
  studioUploadPath,
  UPLOAD_LIMITS,
  verifyStoredUploadOrCleanup,
  type StoredUploadValidation,
  type UploadMedia,
} from '@/lib/studio/uploads';

type AdminClient = ReturnType<typeof createAdminClient>;

type PrepareBody = {
  action: 'prepare';
  filename?: string;
  content_type?: string;
  size?: number;
};

type CompleteBody = {
  action: 'complete';
  upload_id?: string;
  /** 1.6.2 compatibility only: used to remove an abandoned legacy object. */
  path?: string;
  kind?: string;
  notes?: string | null;
};

type UploadReceipt = {
  id: string;
  bucket: string;
  object_path: string;
  public_url: string;
  original_name: string;
  media: UploadMedia;
  content_type: string;
  expected_size: number;
  status: 'prepared' | 'completed' | 'rejected' | 'expired' | 'cleanup_pending' | 'purge_pending' | 'purged';
  source_id: string | null;
  job_id: string | null;
  failure_code: string | null;
  expires_at: string;
};

type CompletionResult = {
  state?: string;
  source?: Record<string, unknown> | null;
  job?: Record<string, unknown> | null;
};

type UntypedRpcClient = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGACY_UPLOAD_BUCKET = 'images';

const validateFile = (body: { filename?: string; content_type?: string; size?: number }) => {
  const filename = String(body.filename ?? '').trim();
  const contentType = String(body.content_type ?? '').trim();
  const size = Number(body.size ?? 0);
  const classified = classifyUpload(contentType, filename);

  if (!filename || filename.length > 255 || !classified) {
    return { error: 'Upload a PNG, JPG, WebP, GIF, or PDF file.' } as const;
  }
  if (!Number.isSafeInteger(size) || size <= 0) return { error: 'The selected file is empty.' } as const;
  if (size > UPLOAD_LIMITS[classified.media]) {
    return {
      error: `${filename} is too large — ${classified.media} uploads cap at ${Math.round(UPLOAD_LIMITS[classified.media] / 1024 / 1024)}MB.`,
    } as const;
  }
  return { filename, size, ...classified };
};

/** Small opportunistic sweep; the upload request remains a JSON-only control lane. */
async function cleanupExpiredUploads(supabase: AdminClient) {
  try {
    await cleanupStudioUploads(supabase, { batchSize: 4 });
  } catch {
    // The runner's autonomous sweep retries this queue even if nobody uploads
    // again. A cleanup transport fault must not block a fresh prepare.
  }
}

async function prepare(body: PrepareBody) {
  const validated = validateFile(body);
  if ('error' in validated) return NextResponse.json({ error: validated.error }, { status: 400 });

  const supabase = createAdminClient();
  await cleanupExpiredUploads(supabase);

  const receiptId = crypto.randomUUID();
  const path = studioUploadPath(validated.filename, validated.ext);
  const { data: publicFile } = supabase.storage.from(STUDIO_UPLOAD_BUCKET).getPublicUrl(path);
  const expiresAt = new Date(Date.now() + STUDIO_UPLOAD_RECEIPT_TTL_MS).toISOString();
  const { error: receiptError } = await supabase.from('studio_upload_receipts').insert({
    id: receiptId,
    bucket: STUDIO_UPLOAD_BUCKET,
    object_path: path,
    public_url: publicFile.publicUrl,
    original_name: validated.filename,
    media: validated.media,
    content_type: validated.contentType,
    expected_size: validated.size,
    expires_at: expiresAt,
  });
  if (receiptError) {
    return NextResponse.json(
      { error: `Storage is not ready: ${receiptError.message}. Apply the Studio upload-receipt migration first.` },
      { status: 500 },
    );
  }

  const { data, error } = await supabase.storage
    .from(STUDIO_UPLOAD_BUCKET)
    .createSignedUploadUrl(path, { upsert: false });
  if (error || !data || data.path !== path) {
    await supabase
      .from('studio_upload_receipts')
      .update({ status: 'rejected', failure_code: 'signing_failed' })
      .eq('id', receiptId);
    return NextResponse.json(
      { error: `Storage is not ready: ${error?.message ?? 'could not bind the upload URL'}.` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    upload_id: receiptId,
    upload: { bucket: STUDIO_UPLOAD_BUCKET, path, token: data.token },
    media: validated.media,
    content_type: validated.contentType,
    expires_at: expiresAt,
  });
}

async function claimForCleanup(
  supabase: AdminClient,
  receipt: UploadReceipt,
  failureCode: string,
) {
  const { data, error } = await supabase
    .from('studio_upload_receipts')
    .update({ status: 'cleanup_pending', failure_code: failureCode })
    .eq('id', receipt.id)
    .eq('status', 'prepared')
    .select('id,bucket,object_path,failure_code')
    .maybeSingle();
  if (error || !data) return false;
  return removeStudioUploadReceiptObject(supabase, data as StudioUploadCleanupReceipt);
}

const completedResponse = (result: CompletionResult, media: UploadMedia) => {
  if (!result.source) {
    return NextResponse.json({ error: 'The completed upload record is inconsistent. Please contact support.' }, { status: 500 });
  }
  const job = result.job && Object.keys(result.job).length ? result.job : null;
  const source = job
    ? {
        ...result.source,
        job: { stage: job.stage, progress: job.progress, status: job.status },
      }
    : result.source;
  return NextResponse.json({ source, job, media });
};

async function finalizeReceipt(
  supabase: AdminClient,
  receipt: UploadReceipt,
  kind: string,
  notes: string | null,
) {
  const { data, error } = await (supabase as unknown as UntypedRpcClient).rpc(
    'studio_complete_upload_receipt',
    { p_receipt_id: receipt.id, p_kind: kind, p_notes: notes },
  );
  if (error) {
    return NextResponse.json({ error: `Could not finish the Studio upload: ${error.message}` }, { status: 500 });
  }
  const result = (data ?? {}) as CompletionResult;
  if (result.state === 'completed') return completedResponse(result, receipt.media);
  if (result.state === 'expired') {
    const removed = await claimForCleanup(supabase, receipt, 'expired');
    if (!removed) {
      return NextResponse.json(
        { error: 'That upload expired and Storage cleanup is still pending. Refresh and try again shortly.' },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: 'That upload link expired. Select the file again.' }, { status: 410 });
  }
  if (result.state === 'invalid_kind') {
    return NextResponse.json({ error: 'kind must be own|competitor|inspiration' }, { status: 400 });
  }
  if (result.state === 'invalid_notes') {
    return NextResponse.json({ error: 'Upload notes are too long.' }, { status: 400 });
  }
  if (result.state === 'not_found') {
    return NextResponse.json({ error: 'The upload receipt was not found. Select the file again.' }, { status: 400 });
  }
  if (result.state === 'rejected' || result.state === 'cleanup_pending') {
    return NextResponse.json({ error: 'That upload can no longer be completed. Select the file again.' }, { status: 410 });
  }
  return NextResponse.json({ error: 'The Studio could not safely finish that upload. Please try again.' }, { status: 500 });
}

async function legacyCompletion(body: CompleteBody) {
  const path = String(body.path ?? '').trim();
  if (!isLegacyStudioUploadPath(path)) {
    return NextResponse.json(
      { error: 'The upload receipt is missing or invalid. Refresh Studio and select the file again.' },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();
  const { data: publicFile } = supabase.storage.from(LEGACY_UPLOAD_BUCKET).getPublicUrl(path);
  const { data: existing, error: existingError } = await supabase
    .from('studio_sources')
    .select('*')
    .eq('url', publicFile.publicUrl)
    .maybeSingle();
  if (existingError) {
    return NextResponse.json(
      { error: 'Studio could not safely check that older upload. Refresh and try again.' },
      { status: 503 },
    );
  }
  if (existing) {
    const media: UploadMedia = path.toLowerCase().endsWith('.pdf') ? 'pdf' : 'image';
    const { data: job } = await supabase
      .from('studio_ingest_jobs')
      .select('*')
      .eq('source_id', existing.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return completedResponse({ state: 'completed', source: existing, job }, media);
  }

  // A pre-1.6.3 tab has already sent bytes to the old shared bucket but cannot
  // safely bind them to a receipt. Remove that exact Studio path best-effort;
  // no source references it, and the user can retry after refreshing.
  const removed = await removeUploadObjectWithRetries(
    () => supabase.storage.from(LEGACY_UPLOAD_BUCKET).remove([path]),
  );
  if (!removed) {
    console.error('[studio-upload] legacy unreceipted cleanup could not be confirmed', {
      bucket: LEGACY_UPLOAD_BUCKET,
      path,
    });
    return NextResponse.json(
      {
        error:
          'Studio was upgraded while this file was uploading, and the old unreceipted object could not be removed. Refresh Studio and try again; contact support if this cleanup error returns.',
      },
      { status: 503 },
    );
  }
  return NextResponse.json(
    { error: 'Studio was upgraded while this file was uploading. Refresh and select it again.' },
    { status: 409 },
  );
}

async function complete(body: CompleteBody) {
  const uploadId = String(body.upload_id ?? '').trim();
  if (!UUID_RE.test(uploadId)) {
    return legacyCompletion(body);
  }
  const kind = String(body.kind ?? 'inspiration');
  if (!['own', 'competitor', 'inspiration'].includes(kind)) {
    return NextResponse.json({ error: 'kind must be own|competitor|inspiration' }, { status: 400 });
  }
  const notesError = studioContextTextError(body.notes, 'Upload notes');
  if (notesError) {
    return NextResponse.json(
      { error: notesError, code: 'studio_text_too_large' },
      { status: 413 },
    );
  }
  const notes = body.notes ?? null;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('studio_upload_receipts')
    .select('*')
    .eq('id', uploadId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: `Could not read the upload receipt: ${error.message}` }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'The upload receipt was not found. Select the file again.' }, { status: 400 });
  const receipt = data as UploadReceipt;

  if (receipt.status === 'completed') return finalizeReceipt(supabase, receipt, kind, notes);
  if (receipt.status !== 'prepared') {
    if (receipt.status === 'cleanup_pending') {
      const removed = await removeStudioUploadReceiptObject(supabase, receipt);
      if (!removed) {
        return NextResponse.json(
          { error: 'Storage cleanup is still pending. Refresh and try again shortly.' },
          { status: 503 },
        );
      }
    }
    return NextResponse.json({ error: 'That upload can no longer be completed. Select the file again.' }, { status: 410 });
  }
  if (new Date(receipt.expires_at).getTime() <= Date.now()) {
    const removed = await claimForCleanup(supabase, receipt, 'expired');
    if (!removed) {
      return NextResponse.json(
        { error: 'That upload expired and Storage cleanup is still pending. Refresh and try again shortly.' },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: 'That upload link expired. Select the file again.' }, { status: 410 });
  }
  if (receipt.bucket !== STUDIO_UPLOAD_BUCKET || !isStudioUploadPath(receipt.object_path)) {
    return NextResponse.json({ error: 'The stored upload receipt is invalid.' }, { status: 500 });
  }

  const slash = receipt.object_path.lastIndexOf('/');
  const folder = receipt.object_path.slice(0, slash);
  const objectName = receipt.object_path.slice(slash + 1);
  let sawStoredObject = false;
  let cleanupComplete = true;
  let stored: StoredUploadValidation;
  try {
    stored = await verifyStoredUploadOrCleanup(
      async () => {
        const { data: objects, error: listError } = await supabase.storage
          .from(receipt.bucket)
          .list(folder, { search: objectName, limit: 2 });
        if (listError) throw new Error(listError.message);
        const object = objects?.find((item) => item.name === objectName);
        if (object) sawStoredObject = true;
        return object?.metadata;
      },
      Number(receipt.expected_size),
      receipt.content_type,
      async (code) => {
        cleanupComplete = await claimForCleanup(supabase, receipt, code);
      },
    );
  } catch {
    return NextResponse.json(
      { error: 'Storage could not verify the uploaded file just now. Please try again.' },
      { status: 503 },
    );
  }
  if (!stored.ok) {
    if (stored.code === 'missing_size' || stored.code === 'missing_mime') {
      return NextResponse.json(
        {
          error: sawStoredObject
            ? 'Storage is still confirming the uploaded file. Please try again shortly.'
            : 'The file has not finished uploading yet. Please try again.',
        },
        { status: sawStoredObject ? 503 : 409 },
      );
    }
    if (!cleanupComplete) {
      return NextResponse.json(
        { error: 'Storage rejected that file, but cleanup is still pending. Refresh and select it again shortly.' },
        { status: 503 },
      );
    }
    const message = stored.code === 'size_mismatch'
      ? 'The uploaded file size did not match the selected file. Select it and try again.'
      : stored.code === 'mime_mismatch'
        ? 'The uploaded file type did not match the selected file. Select it and try again.'
        : 'Storage could not safely verify the uploaded file. Select it and try again.';
    return NextResponse.json({ error: message }, { status: 409 });
  }

  return finalizeReceipt(supabase, receipt, kind, notes);
}

export async function POST(request: NextRequest) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });

  const body = (await request.json().catch(() => null)) as PrepareBody | CompleteBody | null;
  if (!body || (body.action !== 'prepare' && body.action !== 'complete')) {
    return NextResponse.json({ error: 'action must be prepare|complete' }, { status: 400 });
  }
  return body.action === 'prepare' ? prepare(body) : complete(body);
}
