export const STUDIO_CAROUSEL_CLEANUP_MAX_ATTEMPTS = 4;
export const STUDIO_CAROUSEL_CLEANUP_BACKOFF_MS = 30_000;
export const STUDIO_CAROUSEL_CLEANUP_MAX_BACKOFF_MS = 15 * 60_000;

export function studioCarouselCleanupFailurePatch({
  attempts = 0,
  error,
  now = Date.now(),
}) {
  const nextAttempts = Math.max(0, Number(attempts) || 0) + 1;
  const detail = String(error instanceof Error ? error.message : error || "Carousel cleanup could not be confirmed")
    .trim()
    .slice(0, 400);
  if (nextAttempts >= STUDIO_CAROUSEL_CLEANUP_MAX_ATTEMPTS) {
    return Object.freeze({
      status: "cleanup_quarantined",
      stage: "Carousel cleanup needs manual attention",
      cleanup_attempts: nextAttempts,
      cleanup_last_error: detail,
      cleanup_retry_at: null,
      lease_expires_at: null,
      completed_at: null,
    });
  }
  const delay = Math.min(
    STUDIO_CAROUSEL_CLEANUP_MAX_BACKOFF_MS,
    STUDIO_CAROUSEL_CLEANUP_BACKOFF_MS * (2 ** (nextAttempts - 1)),
  );
  return Object.freeze({
    status: "cleanup_pending",
    stage: "Carousel cleanup will retry safely",
    cleanup_attempts: nextAttempts,
    cleanup_last_error: detail,
    cleanup_retry_at: new Date(now + delay).toISOString(),
    lease_expires_at: null,
    completed_at: null,
  });
}
