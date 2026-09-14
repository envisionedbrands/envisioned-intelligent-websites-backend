/**
 * One cleanup attempt. Persistence belongs to the still-active leased job:
 * callers must not write terminal failed unless this returns complete=true.
 * Database cleanup precedes storage deletion and is ownership-checked by the
 * row-locked RPC; both operations are idempotent for restart recovery.
 */
export class StudioCarouselTransportOutcomeUnknownError extends Error {
  constructor(stage, cause) {
    super(`${stage} outcome could not be confirmed after bounded idempotent replay`);
    this.name = "StudioCarouselTransportOutcomeUnknownError";
    this.stage = stage;
    this.cause = cause;
  }
}

export function isStudioCarouselResolvedTransportFailure(envelope) {
  if (!envelope || typeof envelope !== "object" || !envelope.error) return false;
  const error = envelope.error;
  const status = Number(envelope.status ?? error.status ?? Number.NaN);
  if (status === 0) return true;
  const code = String(error.code ?? "").trim();
  const message = String(error.message ?? error).trim();
  return !code && /fetch failed|failed to fetch|network|socket|econn|timed?\s*out|connection/i.test(message);
}

export async function runStudioCarouselIdempotentOperation({
  stage,
  operation,
  attempts = 3,
  wait = async () => {},
  signal = null,
} = {}) {
  if (!stage || typeof operation !== "function") {
    throw new TypeError("Studio carousel idempotent operation requires a stage and operation");
  }
  let lastFailure = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    signal?.throwIfAborted?.();
    try {
      const envelope = await operation();
      if (!isStudioCarouselResolvedTransportFailure(envelope)) return envelope;
      lastFailure = envelope.error;
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      lastFailure = error;
    }
    if (attempt < attempts) {
      signal?.throwIfAborted?.();
      await wait(attempt);
    }
  }
  throw new StudioCarouselTransportOutcomeUnknownError(stage, lastFailure);
}

export async function attemptStudioCarouselCleanup({
  cleanDatabase,
  removeStorage,
  completeDatabase,
  databaseAttempts = 3,
  wait = async () => {},
} = {}) {
  if (
    typeof cleanDatabase !== "function"
    || typeof removeStorage !== "function"
    || typeof completeDatabase !== "function"
  ) {
    throw new TypeError("Studio carousel cleanup requires begin, storage, and completion operations");
  }
  let receipt = null;
  let databaseError = null;
  for (let attempt = 1; attempt <= databaseAttempts; attempt++) {
    try {
      receipt = await cleanDatabase();
      databaseError = null;
      break;
    } catch (error) {
      databaseError = error;
      if (attempt < databaseAttempts) await wait(attempt);
    }
  }
  if (receipt?.state === "preserved_conflict") {
    return Object.freeze({ complete: true, stage: "preserved_conflict", error: null });
  }
  if (!receipt || receipt.state !== "cleanup_pending") {
    return Object.freeze({
      complete: false,
      stage: receipt?.state === "refused" ? "refused" : "database",
      error: databaseError ?? null,
    });
  }
  try {
    const storage = await removeStorage();
    if (storage?.error) {
      return Object.freeze({ complete: false, stage: "storage", error: storage.error });
    }
  } catch (error) {
    return Object.freeze({ complete: false, stage: "storage", error });
  }
  try {
    const completion = await completeDatabase();
    if (!completion || completion.state !== "failed") {
      return Object.freeze({ complete: false, stage: "completion", error: null });
    }
  } catch (error) {
    return Object.freeze({ complete: false, stage: "completion", error });
  }
  return Object.freeze({ complete: true, stage: "complete", error: null });
}
