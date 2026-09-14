'use client';

/**
 * A single-flight polling loop for live Studio output cards.
 *
 * The next timer is armed only after the current request settles. That makes
 * the interval a hard lower bound between requests and prevents a slow
 * response, a React rerender, or a manual refresh from creating overlap.
 */

export const STUDIO_OUTPUT_POLL_INTERVAL_MS = 6_000;
export const STUDIO_OUTPUT_POLL_TIMEOUT_MS = 20_000;

type TimerHandle = ReturnType<typeof setTimeout>;

export type StudioOutputPollScheduler = {
  setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
};

export type StudioOutputPoller = {
  start: () => void;
  refresh: () => void;
  visibilityChanged: () => void;
  stop: () => void;
};

type StudioOutputPollerOptions<T> = {
  poll: (signal: AbortSignal) => Promise<T>;
  apply: (value: T) => void;
  isVisible: () => boolean;
  intervalMs?: number;
  requestTimeoutMs?: number;
  scheduler?: StudioOutputPollScheduler;
  onError?: (error: unknown) => void;
};

const browserScheduler: StudioOutputPollScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

export function createStudioOutputPoller<T>({
  poll,
  apply,
  isVisible,
  intervalMs = STUDIO_OUTPUT_POLL_INTERVAL_MS,
  requestTimeoutMs = STUDIO_OUTPUT_POLL_TIMEOUT_MS,
  scheduler = browserScheduler,
  onError,
}: StudioOutputPollerOptions<T>): StudioOutputPoller {
  let started = false;
  let stopped = false;
  let timer: TimerHandle | null = null;
  let active: AbortController | null = null;
  let refreshQueued = false;

  const clearScheduled = () => {
    if (timer === null) return;
    scheduler.clearTimeout(timer);
    timer = null;
  };

  const schedule = (delayMs: number) => {
    if (stopped || !started || !isVisible() || timer !== null || active !== null) return;
    timer = scheduler.setTimeout(() => {
      timer = null;
      void run();
    }, Math.max(0, delayMs));
  };

  const run = async () => {
    if (stopped || !started || !isVisible() || active !== null) return;
    const request = new AbortController();
    active = request;
    let removeAbortListener = () => {};
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => reject(
        request.signal.reason instanceof Error
          ? request.signal.reason
          : new DOMException('Output polling was cancelled.', 'AbortError'),
      );
      request.signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => request.signal.removeEventListener('abort', onAbort);
    });
    const timeout = scheduler.setTimeout(
      () => request.abort(new DOMException('Output polling timed out.', 'TimeoutError')),
      requestTimeoutMs,
    );
    try {
      // Release controller ownership even if an intermediate session promise
      // ignores the fetch signal. Its eventual result remains fenced.
      const value = await Promise.race([poll(request.signal), aborted]);
      if (!stopped && active === request && !request.signal.aborted && isVisible()) apply(value);
    } catch (error) {
      if (!request.signal.aborted) onError?.(error);
    } finally {
      scheduler.clearTimeout(timeout);
      removeAbortListener();
      if (active === request) active = null;
      if (stopped || !started || !isVisible()) return;
      const delay = refreshQueued ? 0 : intervalMs;
      refreshQueued = false;
      schedule(delay);
    }
  };

  return {
    start() {
      if (started || stopped) return;
      started = true;
      // A zero-delay timer survives ordinary production semantics but lets a
      // React Strict Mode setup/cleanup cycle cancel its speculative request.
      schedule(0);
    },

    refresh() {
      if (stopped || !started || !isVisible()) return;
      if (active !== null) {
        refreshQueued = true;
        return;
      }
      clearScheduled();
      schedule(0);
    },

    visibilityChanged() {
      if (stopped || !started) return;
      if (!isVisible()) {
        refreshQueued = false;
        clearScheduled();
        active?.abort(new DOMException('Output polling paused while this tab is hidden.', 'AbortError'));
        return;
      }
      if (active !== null) {
        // The hidden request may ignore abort. Its completion is fenced, and
        // this queues exactly one fresh visible request behind it.
        refreshQueued = true;
        return;
      }
      clearScheduled();
      schedule(0);
    },

    stop() {
      if (stopped) return;
      stopped = true;
      started = false;
      refreshQueued = false;
      clearScheduled();
      active?.abort(new DOMException('Output polling stopped.', 'AbortError'));
    },
  };
}

/** Stable primitive used as the React effect dependency and request payload. */
export const studioOutputReferenceKey = (refs: Iterable<string>) =>
  [...new Set([...refs].filter(Boolean))].sort().join(',');

/** The output route deliberately accepts no more than 50 references. */
export const studioOutputReferenceBatches = (key: string, batchSize = 50) => {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error('batchSize must be a positive integer');
  const refs = key.split(',').filter(Boolean);
  const batches: string[] = [];
  for (let index = 0; index < refs.length; index += batchSize) {
    batches.push(refs.slice(index, index + batchSize).join(','));
  }
  return batches;
};

/** JSON-value equality without relying on object insertion order. */
export function sameStudioOutputStatus(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameStudioOutputStatus(value, right[index]));
  }
  if (typeof left !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  return leftKeys.every((key) => sameStudioOutputStatus(leftRecord[key], rightRecord[key]));
}

/** Preserve the exact data object when a poll carries no visible change. */
export function mergeStudioOutputLiveData<T extends Record<string, unknown>>(
  current: T,
  live: unknown,
  extra: Record<string, unknown>,
): T {
  if (sameStudioOutputStatus(current.live, live)) return current;
  return { ...current, live, ...extra };
}

/** Preserve the exact collection when every item reconciles to itself. */
export function reconcileStudioOutputItems<T>(items: T[], reconcile: (item: T) => T): T[] {
  let changed = false;
  const next = items.map((item) => {
    const reconciled = reconcile(item);
    if (reconciled !== item) changed = true;
    return reconciled;
  });
  return changed ? next : items;
}
