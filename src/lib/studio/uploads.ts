/**
 * Studio upload contract.
 *
 * File bytes move directly from the browser to Supabase Storage through a
 * short-lived signed upload URL. The Cloudflare Worker only validates small
 * JSON messages and creates the source/job records, keeping uploads outside
 * the Worker's 128 MB memory boundary.
 */

export type UploadMedia = 'image' | 'pdf';

export const STUDIO_UPLOAD_BUCKET = 'studio-uploads';
/** Supabase signed upload URLs have a fixed two-hour validity. */
export const STUDIO_UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
/**
 * Keep the receipt alive briefly after the token dies. That ordering prevents
 * an upload started at the token boundary from arriving after cleanup has
 * already marked its path terminal and leaving an untracked object behind.
 */
export const STUDIO_UPLOAD_RECEIPT_TTL_MS = STUDIO_UPLOAD_TTL_MS + 5 * 60 * 1000;
/**
 * A PUT accepted just before signed-token expiry can still be transferring
 * after the receipt becomes terminal. Keep terminal paths sweepable for this
 * additional window before beginning the final, two-pass purge.
 */
export const STUDIO_UPLOAD_TRANSFER_GRACE_MS = 30 * 60 * 1000;
/** A successful purge must remain absent for a separate quiet window. */
export const STUDIO_UPLOAD_PURGE_VERIFY_DELAY_MS = 30 * 60 * 1000;
export const STUDIO_UPLOAD_REMOVE_ATTEMPTS = 2;
export const STUDIO_UPLOAD_METADATA_VERIFY_ATTEMPTS = 3;

type UploadClassification = { media: UploadMedia; ext: string; contentType: string };

const MIME_UPLOADS: Record<string, UploadClassification> = {
  'image/jpeg': { media: 'image', ext: 'jpg', contentType: 'image/jpeg' },
  'image/jpg': { media: 'image', ext: 'jpg', contentType: 'image/jpeg' },
  'image/png': { media: 'image', ext: 'png', contentType: 'image/png' },
  'image/webp': { media: 'image', ext: 'webp', contentType: 'image/webp' },
  'image/gif': { media: 'image', ext: 'gif', contentType: 'image/gif' },
  'application/pdf': { media: 'pdf', ext: 'pdf', contentType: 'application/pdf' },
};

export const STUDIO_UPLOAD_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
] as const;

export const UPLOAD_LIMITS: Record<UploadMedia, number> = {
  image: 15 * 1024 * 1024,
  pdf: 20 * 1024 * 1024,
};

const EXT_FALLBACK: Record<string, UploadClassification> = {
  jpg: MIME_UPLOADS['image/jpeg'],
  jpeg: MIME_UPLOADS['image/jpeg'],
  png: MIME_UPLOADS['image/png'],
  webp: MIME_UPLOADS['image/webp'],
  gif: MIME_UPLOADS['image/gif'],
  pdf: MIME_UPLOADS['application/pdf'],
};

const normalizedMime = (contentType: string) => contentType.split(';')[0].trim().toLowerCase();

/**
 * MIME first, filename extension only when the browser supplied no useful
 * MIME. An explicit disallowed or extension-conflicting MIME is rejected; a
 * malicious client cannot call an HTML payload "photo.png" and get a token.
 */
export function classifyUpload(
  contentType: string,
  filename: string,
): UploadClassification | null {
  const type = normalizedMime(contentType);
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const fromMime = MIME_UPLOADS[type];
  const fromExt = EXT_FALLBACK[ext];

  if (fromMime) {
    if (fromExt && (fromExt.media !== fromMime.media || fromExt.ext !== fromMime.ext)) return null;
    return fromMime;
  }
  if (type && type !== 'application/octet-stream') return null;
  return fromExt ?? null;
}

type StoredMetadata = {
  size?: unknown;
  mimetype?: unknown;
  contentType?: unknown;
  content_type?: unknown;
};

export type StoredUploadValidation =
  | { ok: true; size: number; contentType: string }
  | { ok: false; code: 'missing_size' | 'size_mismatch' | 'missing_mime' | 'mime_mismatch' };

type StoredUploadFailure = Exclude<StoredUploadValidation, { ok: true }>;

export const isMissingStoredUploadMetadata = (
  validation: StoredUploadValidation,
): boolean => {
  if (validation.ok === true) return false;
  return validation.code === 'missing_size' || validation.code === 'missing_mime';
};

/** Fail closed when Storage does not return both authoritative fields. */
export function validateStoredUploadMetadata(
  metadata: unknown,
  expectedSize: number,
  expectedContentType: string,
): StoredUploadValidation {
  const value = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as StoredMetadata)
    : null;
  const size = Number(value?.size);
  if (!Number.isSafeInteger(size) || size <= 0) return { ok: false, code: 'missing_size' };
  if (size !== expectedSize) return { ok: false, code: 'size_mismatch' };

  const rawMime = [value?.mimetype, value?.contentType, value?.content_type]
    .find((candidate) => typeof candidate === 'string');
  if (typeof rawMime !== 'string' || !rawMime.trim()) return { ok: false, code: 'missing_mime' };
  const stored = MIME_UPLOADS[normalizedMime(rawMime)]?.contentType ?? normalizedMime(rawMime);
  if (stored !== expectedContentType) return { ok: false, code: 'mime_mismatch' };
  return { ok: true, size, contentType: stored };
}

/**
 * Keep authoritative mismatch cleanup coupled to validation. Missing metadata
 * can be a transient Storage-listing condition, so it must never destroy the
 * object or terminally reject its receipt.
 */
export async function validateStoredUploadOrCleanup(
  metadata: unknown,
  expectedSize: number,
  expectedContentType: string,
  cleanup: (code: StoredUploadFailure['code']) => Promise<void>,
): Promise<StoredUploadValidation> {
  const validation = validateStoredUploadMetadata(metadata, expectedSize, expectedContentType);
  if (validation.ok === false && !isMissingStoredUploadMetadata(validation)) await cleanup(validation.code);
  return validation;
}

/**
 * Storage metadata can lag the object listing briefly. Re-read it a small,
 * bounded number of times. Only a positive size/MIME mismatch invokes the
 * receipt-bound cleanup callback; exhausted missing metadata remains retryable.
 */
export async function verifyStoredUploadOrCleanup(
  readMetadata: () => Promise<unknown>,
  expectedSize: number,
  expectedContentType: string,
  cleanup: (code: StoredUploadFailure['code']) => Promise<void>,
  options: {
    attempts?: number;
    pause?: (attempt: number) => Promise<void>;
  } = {},
): Promise<StoredUploadValidation> {
  const attempts = Math.max(
    1,
    Math.min(
      STUDIO_UPLOAD_METADATA_VERIFY_ATTEMPTS,
      Math.trunc(options.attempts ?? STUDIO_UPLOAD_METADATA_VERIFY_ATTEMPTS),
    ),
  );
  const pause = options.pause ?? ((attempt: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, attempt * 75);
  }));
  let validation: StoredUploadValidation = { ok: false, code: 'missing_size' };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    validation = await validateStoredUploadOrCleanup(
      await readMetadata(),
      expectedSize,
      expectedContentType,
      cleanup,
    );
    if (validation.ok || !isMissingStoredUploadMetadata(validation) || attempt === attempts) {
      return validation;
    }
    await pause(attempt);
  }

  return validation;
}

/** Two immediate idempotent attempts keep cleanup bounded on the Worker. */
export async function removeUploadObjectWithRetries(
  remove: () => Promise<{ error: unknown }>,
  attempts = STUDIO_UPLOAD_REMOVE_ATTEMPTS,
): Promise<boolean> {
  const boundedAttempts = Math.max(1, Math.min(Math.trunc(attempts), STUDIO_UPLOAD_REMOVE_ATTEMPTS));
  for (let attempt = 0; attempt < boundedAttempts; attempt += 1) {
    try {
      const { error } = await remove();
      if (!error) return true;
    } catch {
      // The next bounded attempt may recover a transient Storage transport fault.
    }
  }
  return false;
}

export function safeUploadName(filename: string) {
  return (
    filename
      .replace(/\.[^.]*$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'upload'
  );
}

export const studioUploadPath = (filename: string, ext: string) =>
  `studio/${Date.now()}-${crypto.randomUUID().replaceAll('-', '')}-${safeUploadName(filename)}.${ext}`;

export const isLegacyStudioUploadPath = (path: string) =>
  /^studio\/\d{13}-[a-f0-9]{8}-[a-z0-9-]+\.(?:jpe?g|png|webp|gif|pdf)$/i.test(path);

export const isStudioUploadPath = (path: string) =>
  // Eight hex characters preserve receipt validation for any in-flight 1.6.2
  // paths; new dedicated-bucket paths carry the full UUID entropy.
  isLegacyStudioUploadPath(path)
  || /^studio\/\d{13}-[a-f0-9]{32}-[a-z0-9-]+\.(?:jpe?g|png|webp|gif|pdf)$/i.test(path);

/** Is this source URL one of our uploaded image files? (Gen lane full-res check.) */
export const isUploadedImageUrl = (url: string) => /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url);
