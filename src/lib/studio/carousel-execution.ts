export const STUDIO_CAROUSEL_LEASE_SECONDS = 120;
export const STUDIO_CAROUSEL_HEARTBEAT_MS = 30_000;
export const STUDIO_CAROUSEL_RUNNER_PROTOCOL = 'studio_carousel_execution_167_v1' as const;
export const STUDIO_CAROUSEL_RENDER_CONTRACT = 'studio_carousel_render_v1' as const;
export const STUDIO_CAROUSEL_CONTACT_SHEET_CONTRACT = 'studio_carousel_contact_sheet_v1' as const;
export const STUDIO_CAROUSEL_SLIDE_COUNT = 10;
export const STUDIO_CAROUSEL_MAX_SLIDE_WORDS = 28;
export const STUDIO_CAROUSEL_MAX_COVER_WORDS = 12;
export const STUDIO_CAROUSEL_MAX_CLOSER_WORDS = 20;
export const STUDIO_CAROUSEL_MAX_UNBROKEN_CHARS = 24;
export const STUDIO_CAROUSEL_CHECKPOINT_MAX_BYTES = 64 * 1024;
export const STUDIO_CAROUSEL_SOURCE_TITLE_MAX_CODE_POINTS = 289;

export type CarouselModelSpendState = 'not_started' | 'in_flight' | 'checkpointed';

export type CarouselContactSheetReceipt = {
  contract_revision: typeof STUDIO_CAROUSEL_CONTACT_SHEET_CONTRACT;
  columns: 2;
  rows: 5;
  numbered: true;
  slide_total: typeof STUDIO_CAROUSEL_SLIDE_COUNT;
};

export const STUDIO_CAROUSEL_CONTACT_SHEET_RECEIPT: CarouselContactSheetReceipt = Object.freeze({
  contract_revision: STUDIO_CAROUSEL_CONTACT_SHEET_CONTRACT,
  columns: 2,
  rows: 5,
  numbered: true,
  slide_total: STUDIO_CAROUSEL_SLIDE_COUNT,
});

type ExpectedCarouselTemplate = {
  house_look: string;
  template_id: string;
  template_version: string;
};

type CarouselCheckpoint = {
  contract_version: typeof STUDIO_CAROUSEL_RENDER_CONTRACT;
  house_look: string;
  template_id: string;
  template_version: string;
  slides: Array<{ layout: string; text: string }>;
  caption: string;
};

type CarouselReadyResult = {
  contact_sheet_url?: unknown;
  contact_sheet_receipt?: unknown;
  slide_urls?: unknown;
  slide_total?: unknown;
};

type CarouselPostProof = { id?: unknown; status?: unknown; post_type?: unknown } | null;
type CarouselMediaProof = { position?: unknown; kind?: unknown; url?: unknown };

type LegacyFactoryCarouselJob = {
  post_id?: string | null;
  result?: unknown;
};

type LegacyFactoryCarouselReport = {
  status?: string;
  stage?: string;
  progress?: number;
  post_id?: string;
  result?: {
    contact_sheet_url?: string;
    slide_urls?: string[];
    slide_total?: number;
  };
  scheduled_at?: string;
  error?: string;
};

const plainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** JSON-value equality with ordered arrays and insertion-order-independent
 * objects. PostgreSQL jsonb is free to reorder object keys, so durable receipt
 * replays must compare structure rather than serialized object bytes. */
export function sameStudioCarouselJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameStudioCarouselJsonValue(value, right[index]));
  }
  if (!plainObject(left) || !plainObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) {
    return false;
  }
  return leftKeys.every((key) => sameStudioCarouselJsonValue(left[key], right[key]));
}

export function normalizeStudioCarouselSourceTitle(value: unknown):
  | { ok: true; title: string | null }
  | { ok: false; issue: 'source_title_too_long'; maxCodePoints: number } {
  // Preserve the queue route's historical treatment of absent/falsy optional
  // titles while applying the paid-work bound before any database/config I/O.
  if (!value) return { ok: true, title: null };
  const title = String(value).trim();
  if (!title) return { ok: true, title: null };
  if ([...title].length > STUDIO_CAROUSEL_SOURCE_TITLE_MAX_CODE_POINTS) {
    return {
      ok: false,
      issue: 'source_title_too_long',
      maxCodePoints: STUDIO_CAROUSEL_SOURCE_TITLE_MAX_CODE_POINTS,
    };
  }
  return { ok: true, title };
}

const exactKeys = (value: Record<string, unknown>, expected: string[]) => {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length && actual.every((key, index) => key === canonical[index]);
};

const safeMediaUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
};

export function countStudioCarouselCheckpointWords(value: string) {
  const text = value.normalize('NFKC');
  let count = 0;
  let inWord = false;
  for (const character of text) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(character)) {
      count += 1;
      inWord = false;
    } else if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(character)) {
      count += 1;
      inWord = false;
    } else if (/[\p{L}\p{N}]/u.test(character)) {
      if (!inWord) count += 1;
      inWord = true;
    } else if (!(/[\p{M}’']/u.test(character) && inWord)) {
      inWord = false;
    }
  }
  return count;
}

export function validateStudioCarouselCheckpoint(
  value: unknown,
  expected: ExpectedCarouselTemplate,
): { ok: true; checkpoint: CarouselCheckpoint } | { ok: false; issue: string } {
  if (!plainObject(value)) return { ok: false, issue: 'checkpoint_not_object' };
  let bytes = Number.POSITIVE_INFINITY;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return { ok: false, issue: 'checkpoint_not_json' };
  }
  if (bytes > STUDIO_CAROUSEL_CHECKPOINT_MAX_BYTES) {
    return { ok: false, issue: 'checkpoint_too_large' };
  }
  if (!exactKeys(value, ['contract_version', 'house_look', 'template_id', 'template_version', 'slides', 'caption'])) {
    return { ok: false, issue: 'checkpoint_shape_invalid' };
  }
  if (
    value.contract_version !== STUDIO_CAROUSEL_RENDER_CONTRACT
    || value.house_look !== expected.house_look
    || value.template_id !== expected.template_id
    || value.template_version !== expected.template_version
    || typeof value.caption !== 'string'
    || value.caption.length > 2_000
    || !Array.isArray(value.slides)
    || value.slides.length !== STUDIO_CAROUSEL_SLIDE_COUNT
  ) {
    return { ok: false, issue: 'checkpoint_contract_mismatch' };
  }
  for (const [index, candidate] of value.slides.entries()) {
    const text = plainObject(candidate) && typeof candidate.text === 'string' ? candidate.text.trim() : '';
    const wordLimit = index === 0
      ? STUDIO_CAROUSEL_MAX_COVER_WORDS
      : index === STUDIO_CAROUSEL_SLIDE_COUNT - 1
        ? STUDIO_CAROUSEL_MAX_CLOSER_WORDS
        : STUDIO_CAROUSEL_MAX_SLIDE_WORDS;
    const characterLimit = index === 0 ? 140 : index === STUDIO_CAROUSEL_SLIDE_COUNT - 1 ? 240 : 360;
    const tokens = text.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (
      !plainObject(candidate)
      || !exactKeys(candidate, ['layout', 'text'])
      || typeof candidate.layout !== 'string'
      || !candidate.layout.trim()
      || candidate.layout.length > 64
      || typeof candidate.text !== 'string'
      || !text
      || candidate.text.length > 1_600
      || text.length > characterLimit
      || countStudioCarouselCheckpointWords(text) > wordLimit
      || tokens.some((token) => [...token].length > STUDIO_CAROUSEL_MAX_UNBROKEN_CHARS)
    ) {
      return { ok: false, issue: `checkpoint_slide_${index + 1}_invalid` };
    }
  }
  return { ok: true, checkpoint: value as CarouselCheckpoint };
}

export function validateStudioCarouselContactSheetReceipt(
  value: unknown,
): value is CarouselContactSheetReceipt {
  return plainObject(value)
    && exactKeys(value, ['contract_revision', 'columns', 'rows', 'numbered', 'slide_total'])
    && value.contract_revision === STUDIO_CAROUSEL_CONTACT_SHEET_CONTRACT
    && value.columns === 2
    && value.rows === 5
    && value.numbered === true
    && value.slide_total === STUDIO_CAROUSEL_SLIDE_COUNT;
}

export function validateStudioCarouselReadyEvidence({
  result,
  post,
  media,
}: {
  result: CarouselReadyResult;
  post: CarouselPostProof;
  media: CarouselMediaProof[];
}): { ok: true } | { ok: false; issue: string } {
  if (!post || post.status !== 'draft' || post.post_type !== 'carousel') {
    return { ok: false, issue: 'draft_carousel_post_required' };
  }
  if (
    result.slide_total !== STUDIO_CAROUSEL_SLIDE_COUNT
    || !Array.isArray(result.slide_urls)
    || result.slide_urls.length !== STUDIO_CAROUSEL_SLIDE_COUNT
    || !result.slide_urls.every(safeMediaUrl)
    || new Set(result.slide_urls).size !== STUDIO_CAROUSEL_SLIDE_COUNT
  ) {
    return { ok: false, issue: 'exact_ten_slide_urls_required' };
  }
  if (!safeMediaUrl(result.contact_sheet_url)) {
    return { ok: false, issue: 'contact_sheet_url_required' };
  }
  if (!validateStudioCarouselContactSheetReceipt(result.contact_sheet_receipt)) {
    return { ok: false, issue: 'numbered_2x5_contact_sheet_required' };
  }
  if (media.length !== STUDIO_CAROUSEL_SLIDE_COUNT) {
    return { ok: false, issue: 'exact_ten_media_rows_required' };
  }
  const ordered = [...media].sort((left, right) => Number(left.position) - Number(right.position));
  for (let index = 0; index < STUDIO_CAROUSEL_SLIDE_COUNT; index++) {
    const row = ordered[index];
    if (
      row.position !== index
      || row.kind !== 'image'
      || row.url !== result.slide_urls[index]
    ) {
      return { ok: false, issue: `media_row_${index + 1}_mismatch` };
    }
  }
  return { ok: true };
}

export function classifyStudioCarouselRecovery({
  leaseExpired,
  modelSpendState,
  structuredPayload,
}: {
  leaseExpired: boolean;
  modelSpendState: CarouselModelSpendState;
  structuredPayload: unknown;
}): 'not_stale' | 'safe_pre_spend' | 'safe_checkpoint' | 'ambiguous_spend' {
  if (!leaseExpired) return 'not_stale';
  if (modelSpendState === 'not_started' && structuredPayload == null) return 'safe_pre_spend';
  if (modelSpendState === 'checkpointed' && structuredPayload != null) return 'safe_checkpoint';
  return 'ambiguous_spend';
}

/**
 * Preserve the pre-1.6.7 external FACTORY report envelope. FACTORY owns its
 * own renderer, storage, and spend ledger, so it cannot be required to carry
 * a HOUSE template receipt, claim token, contact-sheet proof, or media-row
 * receipt. The route still applies this plan with an observed-status CAS so a
 * late machine response can never overwrite the member's terminal decision.
 */
export function buildLegacyFactoryCarouselReport(
  job: LegacyFactoryCarouselJob,
  body: LegacyFactoryCarouselReport,
  completedAt = new Date().toISOString(),
):
  | { ok: true; update: Record<string, unknown>; readyPostId: string | null }
  | { ok: false; issue: 'ready_post_required' | 'nothing_to_update' } {
  const update: Record<string, unknown> = {};
  if (body.status) update.status = body.status;
  if (body.stage) update.stage = String(body.stage).slice(0, 300);
  if (typeof body.progress === 'number') {
    update.progress = Math.max(0, Math.min(100, Math.round(body.progress)));
  }
  if (body.post_id) update.post_id = body.post_id;

  if (body.result) {
    const prev = plainObject(job.result) ? job.result : {};
    update.result = {
      ...prev,
      contact_sheet_url: body.result.contact_sheet_url ?? prev.contact_sheet_url ?? null,
      slide_urls: Array.isArray(body.result.slide_urls)
        ? body.result.slide_urls.slice(0, STUDIO_CAROUSEL_SLIDE_COUNT)
        : (prev.slide_urls ?? null),
      slide_total: typeof body.result.slide_total === 'number'
        ? Math.max(1, Math.min(STUDIO_CAROUSEL_SLIDE_COUNT, Math.round(body.result.slide_total)))
        : (prev.slide_total ?? null),
      ...(body.scheduled_at
        ? { scheduled_at: body.scheduled_at }
        : typeof prev.scheduled_at === 'string'
          ? { scheduled_at: prev.scheduled_at }
          : {}),
    };
  }

  if (body.status === 'failed') {
    update.error = body.error?.trim() || 'The Content Manager could not finish this carousel';
    update.completed_at = completedAt;
  }

  let readyPostId: string | null = null;
  if (body.status === 'ready') {
    readyPostId = body.post_id ?? job.post_id ?? null;
    if (!readyPostId) return { ok: false, issue: 'ready_post_required' };
    update.post_id = readyPostId;
    if (!body.stage) update.stage = 'Ready for review on the board';
    if (body.progress === undefined) update.progress = 100;
  }

  if (!Object.keys(update).length) return { ok: false, issue: 'nothing_to_update' };
  return { ok: true, update, readyPostId };
}
