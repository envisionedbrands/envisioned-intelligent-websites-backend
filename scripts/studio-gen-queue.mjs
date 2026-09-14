import { randomUUID } from "node:crypto";

export const GEN_RECLAIM_MS = 30 * 60_000;
export const GEN_PROVIDER_RECEIPT_RECLAIM_MS = 2 * 60_000;
export const GEN_PROVIDER_HEARTBEAT_MS = 30_000;
export const GEN_FAL_CAPABILITY_RETRY_MS = 20_000;
export const GEN_POLL_INTERVAL_MS = 2_000;

export const GEN_FAL_CAPABILITY_ACTION = Object.freeze({
  READY: "ready",
  TERMINAL: "terminal",
  DEFER: "defer",
});

export const GEN_RECOVERY_ACTION = Object.freeze({
  CLAIM_QUEUED: "claim_queued",
  RECLAIM_CLAIMED: "reclaim_claimed",
  RESUME_PROVIDER_REQUEST: "resume_provider_request",
  QUARANTINE_SUBMISSION_UNKNOWN: "quarantine_submission_unknown",
  IGNORE: "ignore",
});

/**
 * Decide what the drain may safely do with a row it selected. The database
 * query remains responsible for deciding whether a lease is stale; this pure
 * decision is the spend-safety boundary used after that query:
 *
 * - dismissed work that has not spent anything is never claimed/submitted;
 * - a stale pre-spend claim may receive a fresh lease and submit once;
 * - a paid request with a durable provider id may only be polled;
 * - a generating row without that id is ambiguous and must never resubmit.
 */
export function genRecoveryAction(job) {
  const status = String(job?.status || "");
  if (status === "queued") {
    return job?.dismissed === true
      ? GEN_RECOVERY_ACTION.IGNORE
      : GEN_RECOVERY_ACTION.CLAIM_QUEUED;
  }
  if (status === "claimed") {
    return job?.dismissed === true
      ? GEN_RECOVERY_ACTION.IGNORE
      : GEN_RECOVERY_ACTION.RECLAIM_CLAIMED;
  }
  if (status === "generating") {
    return typeof job?.provider_request_id === "string" && job.provider_request_id.trim()
      ? GEN_RECOVERY_ACTION.RESUME_PROVIDER_REQUEST
      : GEN_RECOVERY_ACTION.QUARANTINE_SUBMISSION_UNKNOWN;
  }
  return GEN_RECOVERY_ACTION.IGNORE;
}

export class FalQueueHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "FalQueueHttpError";
    this.status = status;
  }
}

export class FalSubmissionUnknownError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "FalSubmissionUnknownError";
  }
}

export function genLeaseId(runnerId, uuid = randomUUID()) {
  return `${runnerId}:${uuid}`;
}

export function genReclaimCutoff(now = Date.now()) {
  return new Date(now - GEN_RECLAIM_MS).toISOString();
}

/** A saved provider receipt can be resumed without another paid submission. */
export function genProviderReceiptReclaimCutoff(now = Date.now()) {
  return new Date(now - GEN_PROVIDER_RECEIPT_RECLAIM_MS).toISOString();
}

/**
 * Missing and provider-rejected credentials are durable setup faults. Every
 * other non-ready probe result is transient and must preserve queued work.
 */
export function generationFalCapabilityAction({ hasKey, capability }) {
  if (hasKey && capability === "ready") return GEN_FAL_CAPABILITY_ACTION.READY;
  if (!hasKey || capability === "missing" || capability === "invalid") {
    return GEN_FAL_CAPABILITY_ACTION.TERMINAL;
  }
  return GEN_FAL_CAPABILITY_ACTION.DEFER;
}

/** Exact no-spend patch used to release a claim after a transient fal probe. */
export function deferredGenerationClaimPatch() {
  return {
    status: "queued",
    stage: "Waiting for fal to respond",
    runner_id: null,
    claimed_at: null,
    error: null,
    completed_at: null,
  };
}

/** Keep a paid provider receipt owned while a long-running poll is healthy. */
export async function refreshGenerationHeartbeat(job, {
  lastHeartbeatAt,
  now = Date.now(),
  touch,
}) {
  if (now - lastHeartbeatAt < GEN_PROVIDER_HEARTBEAT_MS) {
    return { job, lastHeartbeatAt, touched: false };
  }
  if (typeof touch !== "function") throw new Error("Generation heartbeat requires a checked touch adapter");
  const refreshed = await touch(job);
  return { job: refreshed, lastHeartbeatAt: now, touched: true };
}

/**
 * Execute the recovery compare-and-set selected by genRecoveryAction. The
 * injected adapter is the only database seam: production binds it to the
 * studio_gen_jobs row's id/status/updated_at (and dismissed=false before
 * spend), while acceptance tests can run the exact state machine against a
 * deterministic CAS store.
 */
export async function recoverGenerationCandidate(job, {
  leaseId,
  nowIso = new Date().toISOString(),
  compareAndSet,
}) {
  if (typeof compareAndSet !== "function") throw new Error("Generation recovery requires a CAS adapter");
  const action = genRecoveryAction(job);
  if (action === GEN_RECOVERY_ACTION.IGNORE) return { action, job: null, rescan: false };

  if ([GEN_RECOVERY_ACTION.CLAIM_QUEUED, GEN_RECOVERY_ACTION.RECLAIM_CLAIMED].includes(action)) {
    if (!leaseId) throw new Error("Generation recovery requires a fresh lease id");
    const recovered = await compareAndSet(job, {
      expectedStatus: action === GEN_RECOVERY_ACTION.CLAIM_QUEUED ? "queued" : "claimed",
      expectedUpdatedAt: job.updated_at,
      requireActive: true,
      patch: {
        status: "claimed",
        stage: action === GEN_RECOVERY_ACTION.CLAIM_QUEUED
          ? "Claimed by the studio runner"
          : "Reclaimed after an interrupted runner",
        runner_id: leaseId,
        claimed_at: nowIso,
      },
    });
    return { action, job: recovered ?? null, rescan: false };
  }

  if (action === GEN_RECOVERY_ACTION.RESUME_PROVIDER_REQUEST) {
    if (!leaseId) throw new Error("Generation recovery requires a fresh lease id");
    const recovered = await compareAndSet(job, {
      expectedStatus: "generating",
      expectedUpdatedAt: job.updated_at,
      requireActive: false,
      patch: {
        runner_id: leaseId,
        claimed_at: nowIso,
        stage: "Resuming saved fal request",
      },
    });
    return { action, job: recovered ?? null, rescan: false };
  }

  const quarantined = await compareAndSet(job, {
    expectedStatus: "generating",
    expectedUpdatedAt: job.updated_at,
    requireActive: false,
    patch: {
      status: "submission_unknown",
      stage: "Generation needs review",
      error: "STUDIO:submission_unknown:The runner stopped during fal submission and no durable request id was saved; automatic retry is disabled to prevent double spend",
      completed_at: nowIso,
    },
  });
  return { action, job: quarantined ?? null, rescan: true };
}

/**
 * The real claimed/generating runner state machine. `submit` is called only
 * after transitionToGenerating returns its durable CAS receipt. A provider
 * receipt that cannot itself be saved is never retried automatically.
 */
export async function runGenerationJobStateMachine(job, adapters) {
  let current = job;
  if (current?.status === "claimed") {
    current = await adapters.transitionToGenerating(current);
    let requestId;
    try {
      requestId = await adapters.submit(current);
    } catch (error) {
      if (error instanceof FalSubmissionUnknownError) {
        await adapters.persistSubmissionUnknown(current, error);
      } else {
        await adapters.persistRejected(current, error);
      }
      return null;
    }

    try {
      current = await adapters.persistRequestId(current, requestId);
    } catch (error) {
      await adapters.onAcceptedReceiptLost?.(current, requestId, error);
      return null;
    }
  }

  if (current?.status === "generating" && current.provider_request_id) {
    await adapters.poll(current);
  }
  return current ?? null;
}

function modelPath(model) {
  const parts = String(model || "").split("/").filter(Boolean);
  if (parts.length < 2 || parts.some((part) => !/^[A-Za-z0-9._-]+$/.test(part))) {
    throw new Error("Invalid fal model identifier");
  }
  return parts.map(encodeURIComponent).join("/");
}

export function falQueueUrls(model, requestId) {
  const base = `https://queue.fal.run/${modelPath(model)}`;
  if (!requestId) return { submit: base };
  const request = `${base}/requests/${encodeURIComponent(requestId)}`;
  return { submit: base, status: `${request}/status`, result: `${request}/response` };
}

async function responseJson(response) {
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = json?.detail?.[0]?.msg ?? json?.detail ?? json?.error ?? `fal ${response.status}`;
    throw new FalQueueHttpError(response.status, String(detail));
  }
  if (!json || typeof json !== "object") {
    throw new Error("fal returned an invalid JSON response");
  }
  return json;
}

/**
 * Submit once to fal's durable queue. A thrown network/timeout error is
 * deliberately classified as ambiguous: the provider may have accepted the
 * paid request before the response was lost, so callers must never resubmit.
 */
export async function submitFalQueue({ model, input, key, fetchJson }) {
  const submitUrl = falQueueUrls(model).submit;
  let response;
  try {
    response = await fetchJson(submitUrl, {
      method: "POST",
      headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (error) {
    throw new FalSubmissionUnknownError(
      "fal submission response was lost; the request will not be submitted again automatically",
      error
    );
  }
  let json;
  try {
    json = await responseJson(response);
  } catch (error) {
    // A definitive client rejection (bad key/input) is safe to expose as a
    // normal failure. A timeout, throttle, or provider/server failure after
    // POST is not: the queue may have accepted the paid request before losing
    // its response. Quarantine those exactly like a lost socket so a member
    // retry can never double-submit.
    if (error instanceof FalQueueHttpError) {
      if (![408, 429].includes(error.status) && error.status < 500) throw error;
      throw new FalSubmissionUnknownError(
        `fal returned ${error.status} after submission; automatic retry is disabled because acceptance is unknown`,
        error
      );
    }
    throw new FalSubmissionUnknownError(
      "fal returned an unreadable success receipt; automatic retry is disabled",
      error
    );
  }
  if (typeof json.request_id !== "string" || !json.request_id.trim()) {
    throw new FalSubmissionUnknownError(
      "fal accepted the queue submission without a durable request id; automatic retry is disabled"
    );
  }
  return json.request_id.trim();
}

export async function inspectFalQueue({ model, requestId, key, fetchJson }) {
  const urls = falQueueUrls(model, requestId);
  const status = await responseJson(await fetchJson(urls.status, {
    headers: { Authorization: `Key ${key}` },
  }));
  const state = String(status.status || "").toUpperCase();
  if (["IN_QUEUE", "IN_PROGRESS"].includes(state)) return { kind: "pending", state };
  if (["FAILED", "CANCELLED", "CANCELED"].includes(state)) {
    return {
      kind: "failed",
      error: String(status.error ?? status.detail ?? `fal request ${state.toLowerCase()}`),
    };
  }
  if (state !== "COMPLETED") return { kind: "pending", state: state || "UNKNOWN" };

  const result = await responseJson(await fetchJson(urls.result, {
    headers: { Authorization: `Key ${key}` },
  }));
  const images = (Array.isArray(result.images) ? result.images : [])
    .filter((image) => image && typeof image.url === "string" && image.url)
    .map((image) => ({ url: image.url, width: image.width, height: image.height }));
  if (!images.length) return { kind: "failed", error: "fal returned no images" };
  return { kind: "ready", images };
}

export function falQueueErrorIsRetryable(error) {
  if (!(error instanceof FalQueueHttpError)) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500 || error.status === 401 || error.status === 403;
}
