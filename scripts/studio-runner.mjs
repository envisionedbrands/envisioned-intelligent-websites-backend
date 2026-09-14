#!/usr/bin/env node
/**
 * studio-runner.mjs — the Content Studio's local ingest runner.
 *
 * Sovereignty pattern (Herald / carousel-worker family): the Cloudflare worker
 * can't run yt-dlp/ffmpeg, so this script runs on the owner's machine and
 * connects OUTWARD. One pass per invocation (launchd StartInterval drives it):
 *
 *   1. Mirror own YouTube videos: video_transcripts → studio_sources.
 *   2. Claim queued studio_ingest_jobs from the backend, process each:
 *        fetch (yt-dlp captions-first → Whisper fallback | site fetch),
 *        analyze (Claude), report results back.
 *
 * Run:     node --env-file=.env.local scripts/studio-runner.mjs
 * Ingest:  node --env-file=.env.local scripts/studio-ingest.mjs <url>
 * Setup:   scripts/setup-studio-runner.sh   (venv with yt-dlp + launchd job)
 *
 * Plan: Auto Agency/PLANS/CONTENT-STUDIO.md (Phase 1).
 */
import { execFile } from "node:child_process";
import { X_OK } from "node:constants";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  accessSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireRunnerLock,
  normalizeRunnerOrigin,
  runnerProjectRef,
  RunnerLockError,
  runnerLockPorts,
  studioRunnerIdentity,
} from "./studio-runner-lock.mjs";
import {
  FalQueueHttpError,
  GEN_FAL_CAPABILITY_RETRY_MS,
  GEN_FAL_CAPABILITY_ACTION,
  GEN_POLL_INTERVAL_MS,
  GEN_RECOVERY_ACTION,
  deferredGenerationClaimPatch,
  falQueueErrorIsRetryable,
  genLeaseId,
  genProviderReceiptReclaimCutoff,
  genReclaimCutoff,
  generationFalCapabilityAction,
  inspectFalQueue,
  refreshGenerationHeartbeat,
  recoverGenerationCandidate,
  runGenerationJobStateMachine,
  submitFalQueue,
} from "./studio-gen-queue.mjs";
import {
  assertStudioCarouselConfigReceipt,
  buildStudioCarouselContactSheet,
  normalizeStudioCarouselPayload,
  renderStudioCarouselSlide,
  STUDIO_CAROUSEL_SLIDE_COUNT,
  studioCarouselContactSheetProbeScript,
  studioCarouselFitProbeScript,
  studioCarouselModelInstruction,
} from "./studio-carousel-contract.mjs";
import {
  anthropicCapabilityRemediation,
  anthropicMessageFailureAction,
  anthropicMessageFailureMessage,
  drainAnthropicGatedQueue,
  probeAnthropicCapability,
} from "./studio-anthropic-capability.mjs";
import {
  assertStudioCarouselRuntimeReady,
  proveStudioCarouselFitReady,
  proveStudioCarouselBrowserReady,
} from "./studio-carousel-preflight.mjs";
import {
  attemptStudioCarouselCleanup,
  runStudioCarouselIdempotentOperation,
  StudioCarouselTransportOutcomeUnknownError,
} from "./studio-carousel-cleanup.mjs";
import { withStudioCarouselLeaseHeartbeat } from "./studio-carousel-heartbeat.mjs";
import { studioCarouselCleanupFailurePatch } from "./studio-carousel-cleanup-queue.mjs";

const exec = promisify(execFile);

const BACKEND_URL = process.env.STUDIO_BACKEND_URL || "http://localhost:3000";
const API_KEY = process.env.API_SECRET_KEY;
const PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVER_SUPABASE_URL = process.env.SUPABASE_URL;
// Match the backend's precedence exactly. verifyBackendDatabasePairing rejects
// the configuration when both variables exist but name different projects.
const SUPABASE_URL = PUBLIC_SUPABASE_URL || SERVER_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const FAL_KEY = process.env.FAL_KEY;
let falCapability = FAL_KEY ? "unverified" : "missing";
let falCapabilityCheckedAt = 0;
let anthropicCapability = ANTHROPIC_KEY ? "unverified" : "missing";
let anthropicCapabilityCheckedAt = 0;
let carouselReady = false;
let carouselChrome = null;
const ANALYSIS_MODEL = process.env.STUDIO_ANALYSIS_MODEL || "claude-sonnet-4-6";
const FFMPEG_BIN = process.env.STUDIO_FFMPEG_BIN || "ffmpeg";
const FFPROBE_BIN = process.env.STUDIO_FFPROBE_BIN || "ffprobe";
const IDENTITY = SUPABASE_URL
  ? studioRunnerIdentity(BACKEND_URL, SUPABASE_URL)
  : {
      backendOrigin: normalizeRunnerOrigin(BACKEND_URL, "STUDIO_BACKEND_URL"),
      databaseOrigin: "",
      databaseOriginSha256: "",
      projectRef: "missing",
      instanceId: "missing",
    };
const BACKEND_ORIGIN = IDENTITY.backendOrigin;
const DATABASE_ORIGIN_SHA256 = IDENTITY.databaseOriginSha256;
const INSTANCE_ID = IDENTITY.instanceId;
const RUNNER_ID = `studio@${hostname()}:${INSTANCE_ID}`;
const RUNNER_DIR = join(process.env.HOME || "", `.config/digital-home/studio-runners/${INSTANCE_ID}`);
const VENV_YTDLP = process.env.STUDIO_YTDLP_BIN || join(RUNNER_DIR, "venv/bin/yt-dlp");
const VENV_PIP = process.env.STUDIO_PIP_BIN || join(RUNNER_DIR, "venv/bin/pip");
const EXPECTED_YTDLP_VERSION = "2026.08.19";
const EXPECTED_YTDLP_EJS_VERSION = "0.8.0";
const EXPECTED_CURL_CFFI_VERSION = "0.16.2";

const boundedMs = (raw, fallback, minimum, maximum) => {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.round(value))) : fallback;
};
const API_TIMEOUT_MS = boundedMs(process.env.STUDIO_API_TIMEOUT_MS, 20_000, 1_000, 120_000);
const WEB_TIMEOUT_MS = boundedMs(process.env.STUDIO_WEB_TIMEOUT_MS, 45_000, 1_000, 180_000);
const MODEL_TIMEOUT_MS = boundedMs(process.env.STUDIO_MODEL_TIMEOUT_MS, 5 * 60_000, 5_000, 10 * 60_000);
const SUPABASE_TIMEOUT_MS = boundedMs(process.env.STUDIO_SUPABASE_TIMEOUT_MS, 30_000, 1_000, 120_000);
// Deliberately shorter than the backend's 30-minute abandoned-lease cutoff.
const JOB_TIMEOUT_MS = boundedMs(process.env.STUDIO_JOB_TIMEOUT_MS, 25 * 60_000, 30_000, 29 * 60_000);
const CAROUSEL_LEASE_MS = 120_000;
const CAROUSEL_LEASE_HEARTBEAT_MS = 30_000;
if (CAROUSEL_LEASE_HEARTBEAT_MS >= CAROUSEL_LEASE_MS) {
  throw new Error("Studio carousel heartbeat must be shorter than its claim lease");
}
const CAROUSEL_RUNNER_PROTOCOL = "studio_carousel_execution_167_v1";
const CAROUSEL_PROTOCOL_HEADERS = Object.freeze({
  "x-studio-carousel-protocol": CAROUSEL_RUNNER_PROTOCOL,
});
const CAROUSEL_CONTACT_SHEET_RECEIPT = Object.freeze({
  contract_revision: "studio_carousel_contact_sheet_v1",
  columns: 2,
  rows: 5,
  numbered: true,
  slide_total: STUDIO_CAROUSEL_SLIDE_COUNT,
});

const SAFE_CHILD_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "XDG_CONFIG_HOME",
];

function safeChildEnv(extra = {}) {
  const env = {};
  for (const key of SAFE_CHILD_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.PATH ||= "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
  return { ...env, ...extra };
}

function composedSignal(timeoutMs, ...parents) {
  const signals = [AbortSignal.timeout(timeoutMs), ...parents.filter(Boolean)];
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

function boundedFetch(input, init = {}, timeoutMs = WEB_TIMEOUT_MS, parentSignal) {
  return fetch(input, {
    ...init,
    signal: composedSignal(timeoutMs, init.signal, parentSignal),
  });
}

async function refreshFalCapability({ force = false } = {}) {
  if (!FAL_KEY) {
    falCapability = "missing";
    return falCapability;
  }
  if (!force && Date.now() - falCapabilityCheckedAt < 5 * 60_000) return falCapability;
  falCapabilityCheckedAt = Date.now();
  try {
    // Authenticated, read-only Platform API: proves this key can authenticate
    // without submitting an image request or consuming generation credits.
    const response = await boundedFetch(
      "https://api.fal.ai/v1/models/requests/by-endpoint?endpoint_id=openai%2Fgpt-image-2&limit=1",
      { headers: { Authorization: `Key ${FAL_KEY}` } },
      API_TIMEOUT_MS,
    );
    if (response.ok) falCapability = "ready";
    else if (response.status === 401 || response.status === 403) falCapability = "invalid";
    else falCapability = "unavailable";
  } catch {
    falCapability = "unavailable";
  }
  return falCapability;
}

async function refreshAnthropicCapability({ force = false } = {}) {
  if (!ANTHROPIC_KEY) {
    anthropicCapability = "missing";
    return anthropicCapability;
  }
  if (!force && Date.now() - anthropicCapabilityCheckedAt < 5 * 60_000) {
    return anthropicCapability;
  }
  anthropicCapabilityCheckedAt = Date.now();
  anthropicCapability = await probeAnthropicCapability({
    apiKey: ANTHROPIC_KEY,
    fetcher: (input, init) => boundedFetch(input, init, API_TIMEOUT_MS),
  });
  return anthropicCapability;
}

if (!API_KEY || !SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing env (API_SECRET_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). Run with --env-file=.env.local");
  process.exit(1);
}

let supabase = null;
let createSupabaseClient = null;
const jobLeases = new Map();
let runnerLock = null;
let lastRunnerHealthAt = 0;

async function initializeSupabase() {
  if (supabase) return supabase;
  ({ createClient: createSupabaseClient } = await import("@supabase/supabase-js"));
  supabase = createSupabaseClient(SUPABASE_URL, SERVICE_KEY, {
    global: {
      fetch: (input, init) => boundedFetch(input, init, SUPABASE_TIMEOUT_MS),
    },
  });
  return supabase;
}

function carouselSupabase(signal) {
  if (!createSupabaseClient) {
    throw new Error("Studio Supabase client was not initialized before carousel execution");
  }
  return createSupabaseClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: {
      fetch: (input, init) => boundedFetch(input, init, SUPABASE_TIMEOUT_MS, signal),
    },
  });
}

class StudioRunnerError extends Error {
  constructor(code, stage, message, retryable = true) {
    super(message);
    this.name = "StudioRunnerError";
    this.code = code;
    this.stage = stage;
    this.retryable = retryable;
  }
}

class RunnerLeaseExpiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "RunnerLeaseExpiredError";
  }
}

class CarouselLeaseExpiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "CarouselLeaseExpiredError";
  }
}

class CarouselExecutionOutcomeUnknownError extends Error {
  constructor(stage, cause) {
    super(`${stage} outcome could not be confirmed; the durable lease will recover it safely`);
    this.name = "CarouselExecutionOutcomeUnknownError";
    this.stage = stage;
    this.cause = cause;
  }
}

class AnthropicCapabilityDeferredError extends Error {
  constructor(capability, message) {
    super(message);
    this.name = "AnthropicCapabilityDeferredError";
    this.capability = capability;
  }
}

class AnthropicMessageFailureError extends Error {
  constructor(action, status, message, cause) {
    super(message);
    this.name = "AnthropicMessageFailureError";
    this.action = action;
    this.status = status;
    this.cause = cause;
  }
}

class JobWatchdogError extends StudioRunnerError {
  constructor() {
    super(
      "job_timeout",
      "Ingestion timed out",
      `The job exceeded the ${Math.round(JOB_TIMEOUT_MS / 60_000)} minute runner watchdog`
    );
    this.name = "JobWatchdogError";
  }
}

class BackendApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "BackendApiError";
    this.status = status;
  }
}

const WORKER_ANTHROPIC_STATUSES = new Set([
  "valid",
  "missing",
  "invalid_provider_credential",
  "provider_permission_denied",
  "billing_required",
  "intermediary_policy_blocked",
  "rate_limited",
  "unavailable",
]);

const WORKER_ANTHROPIC_STATUS_CODES = new Map([
  ["valid", new Set(["worker_anthropic_valid"])],
  ["missing", new Set(["worker_anthropic_missing"])],
  ["invalid_provider_credential", new Set(["worker_anthropic_invalid_provider_credential"])],
  ["provider_permission_denied", new Set(["worker_anthropic_provider_permission_denied"])],
  ["billing_required", new Set(["worker_anthropic_billing_required"])],
  ["intermediary_policy_blocked", new Set([
    "worker_anthropic_intermediary_policy_blocked",
    "worker_anthropic_unverified_rejection",
  ])],
  ["rate_limited", new Set(["worker_anthropic_rate_limited"])],
  ["unavailable", new Set([
    "worker_anthropic_unavailable",
    "worker_anthropic_unverified_response",
  ])],
]);

function workerAnthropicRemediation(probe) {
  switch (probe?.status) {
    case "missing":
      return "The deployed Worker is missing ANTHROPIC_API_KEY. Configure the Cloudflare Worker secret, deploy the backend, then rerun runner setup. The local runner secret is separate.";
    case "invalid_provider_credential":
      return "Anthropic returned a 401 with a request-id classification hint from the deployed Worker path. That unauthenticated header does not prove the key is bad; verify the direct path and the key in the Anthropic account before replacing it, then rerun runner setup.";
    case "provider_permission_denied":
      return "Anthropic returned a 403 with a request-id classification hint from the deployed Worker path. The header is not proof; do not rotate the key automatically. Check the direct path and Anthropic account permissions, then rerun runner setup.";
    case "billing_required":
      return "Anthropic returned a 402 with a request-id classification hint from the deployed Worker path. The header is not authentication; check the direct path and Anthropic account billing/spend settings, then rerun runner setup.";
    case "intermediary_policy_blocked":
      return "The deployed Worker Anthropic request was rejected without an Anthropic request-id classification hint. The key has not been marked invalid. Most often this is location, not routing: Anthropic does not serve some Cloudflare locations (Hong Kong, for example), and a Worker that runs near the visitor can make its request from one of them. Pin the Worker to your database's region in wrangler.jsonc (\"placement\": { \"region\": \"aws:<your Supabase region>\" }), redeploy, and rerun this check. If it still fails, remove any custom intermediary routing or inspect Cloudflare/account policy, then rerun runner setup.";
    case "rate_limited":
      return "The deployed Worker read-only proof was temporarily rate- or spend-limited. Wait and rerun runner setup; do not replace the key.";
    case "unavailable":
      return "The deployed Worker could not verify its direct Anthropic connection. Check provider/network availability and rerun runner setup; do not replace the key based only on response headers.";
    default:
      return "The deployed Worker returned an invalid Anthropic proof. Deploy the current Studio 1.6.7 backend, then rerun runner setup.";
  }
}

async function verifyWorkerAnthropicCapability() {
  let response;
  try {
    response = await boundedFetch(`${BACKEND_ORIGIN}/api/studio/runner/check-anthropic`, {
      method: "GET",
      cache: "no-store",
      headers: { Authorization: `Bearer ${API_KEY}` },
    }, API_TIMEOUT_MS);
  } catch {
    throw new Error(
      "The deployed Worker Anthropic proof could not be reached. Check the backend deployment and connectivity, then rerun runner setup."
    );
  }

  const probe = await response.json().catch(() => null);
  if (response.status === 404) {
    throw new Error(
      "The deployed Worker Anthropic proof is missing (404). Deploy the current Studio 1.6.7 backend first, then rerun runner setup."
    );
  }
  if (response.status === 401 && !probe?.status) {
    throw new Error(
      "The deployed Worker rejected the runner machine credential. Confirm API_SECRET_KEY matches the deployed backend, then rerun runner setup."
    );
  }
  if (
    !probe
    || !WORKER_ANTHROPIC_STATUSES.has(probe.status)
    || probe.transport !== "direct_anthropic"
    || probe.probe !== "authenticated_read_only_models_list"
    || typeof probe.configured !== "boolean"
    || typeof probe.code !== "string"
    || !WORKER_ANTHROPIC_STATUS_CODES.get(probe.status)?.has(probe.code)
    || !(
      probe.upstream_status === null
      || (Number.isInteger(probe.upstream_status) && probe.upstream_status >= 100 && probe.upstream_status <= 599)
    )
    || typeof probe.provider_request_id_present !== "boolean"
    || typeof probe.intermediary_trace_present !== "boolean"
  ) {
    throw new Error(
      "The deployed Worker returned an invalid Anthropic proof. Deploy the current Studio 1.6.7 backend first, then rerun runner setup."
    );
  }
  if (
    response.ok
    && probe.status === "valid"
    && probe.configured === true
    && probe.code === "worker_anthropic_valid"
    && probe.upstream_status === 200
    && probe.provider_request_id_present === true
  ) return probe;
  throw new Error(workerAnthropicRemediation(probe));
}

const failure = (error, fallbackCode, fallbackStage) =>
  error instanceof StudioRunnerError
    ? error
    : new StudioRunnerError(fallbackCode, fallbackStage, error instanceof Error ? error.message : String(error));

// ── Lock: one daemon per backend + database pair ────────────────────────────
async function releaseLock() {
  const owned = runnerLock;
  runnerLock = null;
  if (owned?.acquired) await owned.release();
}

// ── Backend API helpers ─────────────────────────────────────────────────────
async function api(path, method = "GET", body, parentSignal, extraHeaders = {}) {
  const res = await boundedFetch(`${BACKEND_ORIGIN}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  }, API_TIMEOUT_MS, parentSignal);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new BackendApiError(res.status, `${method} ${path} → ${res.status}: ${json.error || "?"}`);
  return json;
}

async function reportRunnerHealth(status, failureCode = null, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastRunnerHealthAt < 30_000) return;
  if (status === "ready" && !carouselReady) {
    status = "blocked";
    failureCode = "carousel_toolchain_unavailable";
  }
  try {
    await api("/api/studio/runner/health", "POST", {
      instance_id: INSTANCE_ID,
      status,
      failure_code: failureCode,
      capabilities: {
        fal_configured: Boolean(process.env.FAL_KEY),
        fal_ready: falCapability === "ready",
        openai_configured: Boolean(OPENAI_KEY),
        anthropic_configured: Boolean(ANTHROPIC_KEY),
        anthropic_status: anthropicCapability,
        carousel_ready: carouselReady,
      },
    }, undefined, CAROUSEL_PROTOCOL_HEADERS);
    lastRunnerHealthAt = now;
  } catch (error) {
    // Health is observability, never a second ownership or queue gate.
    console.error(`runner health report failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const leasedPatch = (jobId, patch) => ({ ...patch, ...(jobLeases.get(jobId) ?? {}) });

const report = async (jobId, patch, signal) => {
  try {
    return await api(`/api/studio/jobs/${jobId}`, "PATCH", leasedPatch(jobId, patch), signal);
  } catch (error) {
    if (error instanceof BackendApiError && error.status === 409) throw new RunnerLeaseExpiredError(error.message);
    // Progress is also a lease heartbeat. If the runner cannot confirm it,
    // stop before doing more (potentially paid) work.
    throw error;
  }
};

async function terminalReport(jobId, patch) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await api(`/api/studio/jobs/${jobId}`, "PATCH", leasedPatch(jobId, patch));
    } catch (error) {
      if (error instanceof BackendApiError && error.status === 409) {
        throw new RunnerLeaseExpiredError(error.message);
      }
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastError;
}

async function verifyBackendDatabasePairing() {
  const backend = new URL(BACKEND_ORIGIN);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(backend.hostname);
  if (backend.protocol !== "https:" && !(backend.protocol === "http:" && loopback)) {
    throw new Error("STUDIO_BACKEND_URL must use https (plain http is allowed only on loopback for local development)");
  }
  const localOrigin = normalizeRunnerOrigin(SUPABASE_URL, "SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL");
  if (PUBLIC_SUPABASE_URL && SERVER_SUPABASE_URL) {
    const publicOrigin = normalizeRunnerOrigin(PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL");
    const serverOrigin = normalizeRunnerOrigin(SERVER_SUPABASE_URL, "SUPABASE_URL");
    if (publicOrigin !== serverOrigin) {
      throw new Error(
        `Runner Supabase URLs disagree (${runnerProjectRef(publicOrigin)} vs ${runnerProjectRef(serverOrigin)}). Refusing to start.`
      );
    }
  }

  let check;
  try {
    check = await api("/api/studio/runner/check");
  } catch (error) {
    if (error instanceof BackendApiError && error.status === 404) {
      throw new Error(
        "Studio runner pairing check is missing (404). Deploy the Studio 1.6.7 backend first, confirm STUDIO_BACKEND_URL points to that deployment, then rerun runner setup."
      );
    }
    throw error;
  }
  if (!check?.database_origin_sha256) {
    throw new Error(
      "Studio runner pairing check is from an older backend. Deploy the current Studio 1.6.7 backend first, then rerun runner setup."
    );
  }
  if (check.database_origin_sha256 !== DATABASE_ORIGIN_SHA256) {
    throw new Error(
      `Backend uses Supabase project ${check?.project_ref || "unknown"}, ` +
      `but this runner uses ${runnerProjectRef(localOrigin)}. Refusing to start.`
    );
  }
  if (check.runner_instance_id !== INSTANCE_ID) {
    throw new Error(
      "The backend returned a different Studio runner identity. Confirm STUDIO_BACKEND_URL uses the canonical live origin, then rerun runner setup."
    );
  }
  if (check.queue_readable !== true) {
    throw new Error("The backend pairing check did not prove that its Studio queue is readable. Refusing to start.");
  }
  if (
    check.studio_167_schema_ready !== true
    || check.studio_167_schema_contract !== "studio_167_carousel_execution_v1"
  ) {
    throw new Error("Studio 1.6.7 database migrations are missing. Deploy/apply the 1.6.7 backend migrations before runner setup.");
  }

  // The origin match catches a stale URL. These two read-only calls also prove
  // the local credential belongs to that project and has the service-role
  // capability the mirror, generation and carousel lanes require.
  await initializeSupabase();
  const { error: adminError } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (adminError) {
    throw new Error(`Runner service credential could not verify Supabase project ${runnerProjectRef(localOrigin)}. Refusing to start.`);
  }
  const { error: queueError } = await supabase
    .from("studio_ingest_jobs")
    .select("id", { head: true, count: "exact" })
    .limit(1);
  if (queueError) {
    throw new Error(`Runner could not read the Studio queue in Supabase project ${runnerProjectRef(localOrigin)}. Refusing to start.`);
  }
  return { project_ref: check?.project_ref || runnerProjectRef(localOrigin) };
}

// ── Thumbnails ──────────────────────────────────────────────────────────────
const ytThumb = (url) => {
  const m = url.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : null;
};

/** Download an image and return a data: URL (resized via sips when too big). */
async function captureThumb(imageUrl, dir, signal) {
  if (!imageUrl) return null;
  try {
    const res = await boundedFetch(
      imageUrl,
      { headers: { "User-Agent": "Mozilla/5.0" } },
      WEB_TIMEOUT_MS,
      signal
    );
    if (!res.ok) return null;
    let buf = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    if (buf.length > 200 * 1024) {
      try {
        const f = join(dir, "thumb-raw");
        writeFileSync(f, buf);
        await exec("sips", ["-Z", "480", "-s", "format", "jpeg", f, "--out", join(dir, "thumb.jpg")], {
          timeout: 20_000,
          signal,
          env: safeChildEnv(),
        });
        buf = readFileSync(join(dir, "thumb.jpg"));
        if (buf.length > 200 * 1024) return null;
        return `data:image/jpeg;base64,${buf.toString("base64")}`;
      } catch {
        return null;
      }
    }
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

// ── yt-dlp ──────────────────────────────────────────────────────────────────
function requirePinnedExecutable(path, label) {
  try {
    accessSync(path, X_OK);
    return path;
  } catch {
    throw new Error(`${label} is missing or not executable at ${path}; rerun Studio runner setup`);
  }
}

function ytdlpBin() {
  try {
    return requirePinnedExecutable(VENV_YTDLP, "Pinned yt-dlp");
  } catch (error) {
    throw new StudioRunnerError(
      "runner_outdated",
      "Studio runner setup needs attention",
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function ytdlp(args, timeoutMs = 180000, signal) {
  const bin = ytdlpBin();
  const base = [
    "--ignore-config",
    "--js-runtimes", `node:${process.execPath}`,
    ...(FFMPEG_BIN.includes("/") ? ["--ffmpeg-location", dirname(FFMPEG_BIN)] : []),
  ];
  return exec(bin, [...base, ...args], {
    timeout: timeoutMs,
    signal,
    maxBuffer: 64 * 1024 * 1024,
    env: safeChildEnv({ YTDLP_NO_PLUGINS: "1" }),
  });
}

async function verifyPinnedToolchain() {
  const ytDlp = requirePinnedExecutable(VENV_YTDLP, "Pinned yt-dlp");
  const pip = requirePinnedExecutable(VENV_PIP, "Pinned pip");
  const toolEnv = safeChildEnv({ YTDLP_NO_PLUGINS: "1" });
  const { stdout: ytVersionRaw } = await exec(ytDlp, ["--version"], {
    timeout: 20_000,
    env: toolEnv,
  });
  const ytVersion = ytVersionRaw.trim();
  if (ytVersion !== EXPECTED_YTDLP_VERSION) {
    throw new Error(`yt-dlp ${EXPECTED_YTDLP_VERSION} required (found ${ytVersion}); rerun setup`);
  }
  const packageVersion = async (name) => {
    const { stdout } = await exec(pip, ["show", name], { timeout: 20_000, env: toolEnv });
    return stdout.match(/^Version:\s*(.+)$/m)?.[1]?.trim() || "missing";
  };
  const ejsVersion = await packageVersion("yt-dlp-ejs");
  if (ejsVersion !== EXPECTED_YTDLP_EJS_VERSION) {
    throw new Error(`yt-dlp-ejs ${EXPECTED_YTDLP_EJS_VERSION} required (found ${ejsVersion}); rerun setup`);
  }
  const curlCffiVersion = await packageVersion("curl-cffi");
  if (curlCffiVersion !== EXPECTED_CURL_CFFI_VERSION) {
    throw new Error(`curl-cffi ${EXPECTED_CURL_CFFI_VERSION} required (found ${curlCffiVersion}); rerun setup`);
  }
  const { stdout: ffmpegVersion } = await exec(FFMPEG_BIN, ["-version"], {
    timeout: 20_000,
    env: toolEnv,
  });
  const { stdout: ffprobeVersion } = await exec(FFPROBE_BIN, ["-version"], {
    timeout: 20_000,
    env: toolEnv,
  });
  return { ytVersion, ffmpegVersion, ffprobeVersion };
}

function parseVtt(vtt) {
  const lines = [];
  let last = "";
  for (const raw of vtt.split("\n")) {
    const line = raw.trim();
    if (!line || line === "WEBVTT" || /^(Kind|Language|NOTE|\d+$)/.test(line) || line.includes("-->")) continue;
    const text = line.replace(/<[^>]+>/g, "").trim();
    if (text && text !== last) {
      lines.push(text);
      last = text;
    }
  }
  return lines.join(" ");
}

async function fetchVideo(url, dir, jobId, signal) {
  await report(jobId, { status: "fetching", stage: "Reading video metadata", progress: 15 }, signal);
  let meta;
  try {
    const { stdout: metaRaw } = await ytdlp([
      "--skip-download", "--no-playlist",
      "--print", "%(.{id,title,uploader,channel,duration,upload_date,view_count,like_count,comment_count,thumbnail})j",
      url,
    ], 180_000, signal);
    meta = JSON.parse(metaRaw.trim().split("\n")[0]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/unavailable|private video|members-only|copyright/i.test(detail)) {
      throw new StudioRunnerError("video_unavailable", "Video unavailable", detail, false);
    }
    throw new StudioRunnerError("metadata_failed", "Could not read video details", detail);
  }

  // Thumbnail: stable YouTube CDN link when we can derive it; otherwise
  // capture the platform thumb as an embedded image (IG/TikTok URLs expire).
  const thumbnail = ytThumb(url) ?? (await captureThumb(meta.thumbnail, dir, signal));

  // Early dressing: hand the card its title/author/thumbnail NOW (seconds in)
  // instead of holding them hostage until the transcript completes.
  await report(jobId, {
    status: "transcribing",
    stage: "Pulling captions",
    progress: 35,
    result: {
      title: meta.title || undefined,
      author: meta.uploader || meta.channel || undefined,
      thumbnail: thumbnail || undefined,
    },
  }, signal);
  let transcript = "";
  try {
    await ytdlp([
      "--skip-download", "--no-playlist",
      "--write-subs", "--write-auto-subs", "--sub-langs", "en.*", "--sub-format", "vtt",
      "-o", join(dir, "cap"), url,
    ], 180_000, signal);
    const vttFile = readdirSync(dir).find((f) => f.startsWith("cap") && f.endsWith(".vtt"));
    if (vttFile) transcript = parseVtt(readFileSync(join(dir, vttFile), "utf8"));
  } catch (error) {
    // Captions are optional; retain the technical detail in the local log and
    // continue to the local audio/Whisper fallback.
    console.error(`  captions unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!transcript) {
    if (!OPENAI_KEY) {
      throw new StudioRunnerError(
        "transcription_not_configured",
        "Transcription is not configured",
        "OPENAI_API_KEY is missing"
      );
    }
    await report(jobId, { stage: "No captions — transcribing audio with Whisper", progress: 45 }, signal);
    try {
      await ytdlp([
        "-f", "bestaudio/best", "--no-playlist",
        "-o", join(dir, "input.%(ext)s"), url,
      ], 300_000, signal);
    } catch (error) {
      throw new StudioRunnerError(
        "audio_download_failed",
        "Could not download video audio",
        error instanceof Error ? error.message : String(error)
      );
    }
    const audio = readdirSync(dir).find((file) => file.startsWith("input."));
    if (!audio) {
      throw new StudioRunnerError("audio_download_failed", "Could not download video audio", "yt-dlp produced no audio file");
    }
    try {
      await exec(FFMPEG_BIN, [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", join(dir, audio), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k",
        "-f", "segment", "-segment_time", "1200", "-reset_timestamps", "1", join(dir, "chunk-%03d.mp3"),
      ], { timeout: 300_000, signal, maxBuffer: 16 * 1024 * 1024, env: safeChildEnv() });
    } catch (error) {
      throw new StudioRunnerError(
        "ffmpeg_missing",
        "Could not prepare audio for transcription",
        error instanceof Error ? error.message : String(error)
      );
    }
    const chunks = readdirSync(dir).filter((file) => /^chunk-\d+\.mp3$/.test(file)).sort();
    if (!chunks.length) {
      throw new StudioRunnerError("ffmpeg_missing", "Could not prepare audio for transcription", "FFmpeg produced no chunks");
    }
    const transcriptParts = [];
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      await report(jobId, {
        stage: `Transcribing audio ${index + 1} of ${chunks.length}`,
        progress: 45 + Math.round(((index + 1) / chunks.length) * 20),
      }, signal);
      const form = new FormData();
      form.append("model", "whisper-1");
      form.append("file", new Blob([readFileSync(join(dir, chunk))]), chunk);
      const res = await boundedFetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_KEY}` },
        body: form,
      }, MODEL_TIMEOUT_MS, signal);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = res.status === 429 ? "transcription_rate_limited" : "transcription_failed";
        throw new StudioRunnerError(code, "Audio transcription failed", json.error?.message || `OpenAI ${res.status}`);
      }
      if (!json.text?.trim()) {
        throw new StudioRunnerError("transcription_failed", "Audio transcription failed", "Whisper returned no text");
      }
      transcriptParts.push(json.text.trim());
    }
    transcript = transcriptParts.join("\n\n");
  }
  if (!transcript) throw new StudioRunnerError("transcription_failed", "Audio transcription failed", "No transcript was produced");

  const views = meta.view_count ?? null;
  const likes = meta.like_count ?? null;
  const comments = meta.comment_count ?? null;
  return {
    thumbnail,
    title: meta.title,
    author: meta.uploader || meta.channel || null,
    seconds: meta.duration ?? null,
    published_at: meta.upload_date
      ? `${meta.upload_date.slice(0, 4)}-${meta.upload_date.slice(4, 6)}-${meta.upload_date.slice(6, 8)}T00:00:00Z`
      : null,
    transcript,
    engagement: {
      views, likes, comments,
      engagement_rate: views && likes != null ? Number((((likes ?? 0) + (comments ?? 0)) / views).toFixed(4)) : null,
    },
  };
}

// ── Websites ────────────────────────────────────────────────────────────────
async function fetchWebsite(url, jobId, dir, signal) {
  await report(jobId, { status: "fetching", stage: "Fetching the page", progress: 25 }, signal);
  const res = await boundedFetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
    redirect: "follow",
  }, WEB_TIMEOUT_MS, signal);
  if (!res.ok) throw new StudioRunnerError("website_fetch_failed", "Could not fetch the page", `Page fetch failed: ${res.status}`);
  const html = await res.text();
  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "").trim();
  const ogImage =
    html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i)?.[1] ??
    html.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i)?.[1] ??
    null;
  const thumbnail = ogImage ? await captureThumb(new URL(ogImage, url).toString(), dir, signal) : null;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(nbsp|amp|quot|#39|lt|gt);/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60000);
  if (text.length < 200) {
    throw new StudioRunnerError("website_fetch_failed", "Could not read the page", "Page produced almost no text (likely JS-rendered)");
  }
  return { title: title || url, author: null, transcript: text, engagement: null, thumbnail };
}

// ── Direct uploads ──────────────────────────────────────────────────────────
// Images are ready references as soon as Storage confirms them. PDFs need a
// transcript before a desk can use them, so the runner asks Claude to read the
// public Storage URL. No PDF bytes pass through the Cloudflare Worker.
async function fetchUploadedPdf(source, jobId, signal) {
  if (!ANTHROPIC_KEY) throw new StudioRunnerError('pdf_read_failed', 'PDF reader is not configured', 'ANTHROPIC_API_KEY is missing');
  if (!/\.pdf(?:\?|$)/i.test(source.url)) {
    throw new StudioRunnerError('unsupported_platform', 'Unsupported uploaded file', 'Uploaded file is not a PDF', false);
  }

  await report(jobId, { status: 'transcribing', stage: 'Reading the PDF', progress: 35 }, signal);
  const res = await boundedFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    redirect: 'error',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ANALYSIS_MODEL,
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'url', url: source.url } },
          {
            type: 'text',
            text: 'Extract the full text of this document as clean plain text in reading order. Skip headers, footers, and page numbers. Output only the extracted text.',
          },
        ],
      }],
    }),
  }, MODEL_TIMEOUT_MS, signal);
  const json = await res.json();
  if (!res.ok) throw new StudioRunnerError('pdf_read_failed', 'Could not read the PDF', json.error?.message || `Claude ${res.status}`);
  const transcript = (json.content || [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text || '')
    .join('\n')
    .trim();
  if (transcript.length < 40) {
    throw new StudioRunnerError('pdf_read_failed', 'Could not read the PDF', 'The PDF produced almost no text (is it a scanned image?)');
  }
  return {
    title: source.title || 'Uploaded PDF',
    author: null,
    transcript,
    engagement: null,
    thumbnail: null,
  };
}

// ── Analysis pass ───────────────────────────────────────────────────────────
async function analyze(source, result, jobId, signal) {
  if (!ANTHROPIC_KEY) return null;
  await report(jobId, { status: "analyzing", stage: "Analyzing hook and structure", progress: 75 }, signal);
  const excerpt = result.transcript.slice(0, 24000);
  const res = await boundedFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    redirect: "error",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANALYSIS_MODEL,
      max_tokens: 1200,
      messages: [{
        role: "user",
        content:
          `Analyze this ${source.platform} content for a content-strategy swipe bank. ` +
          `Title: ${result.title || "unknown"}. ` +
          `Return ONLY a JSON object with keys: hook (the opening hook, verbatim if identifiable), ` +
          `structure_beats (array of 3-8 short strings naming the structural beats in order), ` +
          `why_it_worked (2-3 sentences on why this held attention or converted), ` +
          `topics (array of 2-5 topic tags), format (one of: talking_head, tutorial, listicle, story, ad, sales_page, article, other), ` +
          `tone (2-4 words).\n\nTranscript/text:\n${excerpt}`,
      }],
    }),
  }, MODEL_TIMEOUT_MS, signal);
  const json = await res.json();
  if (!res.ok) {
    console.error(`  analysis failed: ${json.error?.message || res.status}`);
    return null;
  }
  const text = json.content?.[0]?.text || "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// ── Job processing ──────────────────────────────────────────────────────────
async function processJob(job) {
  const source = job.source;
  const dir = mkdtempSync(join(tmpdir(), "studio-"));
  const watchdog = new AbortController();
  const watchdogTimer = setTimeout(() => watchdog.abort(new JobWatchdogError()), JOB_TIMEOUT_MS);
  watchdogTimer.unref?.();
  jobLeases.set(job.id, { runner_id: job.runner_id, attempt: job.attempts });
  console.log(`→ job ${job.id.slice(0, 8)} ${source.platform} ${source.url}`);
  try {
    let result;
    if (["youtube", "instagram", "tiktok"].includes(source.platform)) {
      result = await fetchVideo(source.url, dir, job.id, watchdog.signal);
    } else if (source.platform === "website" || source.platform === "facebook_ads") {
      result = await fetchWebsite(source.url, job.id, dir, watchdog.signal);
    } else if (source.platform === 'upload') {
      result = await fetchUploadedPdf(source, job.id, watchdog.signal);
    } else {
      throw new StudioRunnerError(
        "unsupported_platform",
        "Unsupported source type",
        `Platform ${source.platform} not handled by this runner yet`,
        false
      );
    }
    const analysis = await analyze(source, result, job.id, watchdog.signal);
    if (watchdog.signal.aborted) throw watchdog.signal.reason;
    // Network reporting has its own bounded retry policy. Once all source work
    // is complete, stop the processing watchdog before the terminal CAS.
    clearTimeout(watchdogTimer);
    await terminalReport(job.id, {
      status: "ready",
      stage: "Source ready",
      result: { ...result, analysis: analysis ?? undefined },
    });
    console.log(`  ✓ ready: "${result.title}" (${result.transcript.length} chars)`);
  } catch (caught) {
    const e = watchdog.signal.aborted ? watchdog.signal.reason : caught;
    if (e instanceof RunnerLeaseExpiredError) {
      console.warn(`  lease expired; stopping local work for job ${job.id.slice(0, 8)}`);
      return;
    }
    console.error(`  ✗ failed: ${e.message}`);
    const problem = failure(e, "metadata_failed", "Source ingestion failed");
    try {
      await terminalReport(job.id, {
        status: "failed",
        stage: problem.stage,
        error: `STUDIO:${problem.code}:${problem.message}`.slice(0, 500),
      });
    } catch (reportError) {
      if (reportError instanceof RunnerLeaseExpiredError) {
        console.warn(`  lease expired before failure could be reported for job ${job.id.slice(0, 8)}`);
        return;
      }
      throw reportError;
    }
  } finally {
    clearTimeout(watchdogTimer);
    jobLeases.delete(job.id);
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Mirror own videos: video_transcripts → studio_sources ───────────────────
async function mirrorOwnVideos() {
  const { data: vids, error } = await supabase
    .from("video_transcripts")
    .select("video_id,title,published_at,seconds,transcript")
    .order("published_at", { ascending: false })
    .limit(100);
  if (error) {
    // Optional table: Digital Homes without a YouTube transcript mirror simply
    // skip this pass — own videos arrive by pasting them into the Studio.
    if (!/does not exist|schema cache/i.test(error.message)) console.error(`mirror: ${error.message}`);
    return;
  }
  let added = 0;
  for (const v of vids || []) {
    const { error: upsertError } = await supabase.from("studio_sources").upsert(
      {
        url: `https://www.youtube.com/watch?v=${v.video_id}`,
        platform: "youtube",
        kind: "own",
        status: "ready",
        thumbnail: `https://i.ytimg.com/vi/${v.video_id}/hqdefault.jpg`,
        title: v.title,
        author: "own channel",
        seconds: v.seconds,
        published_at: v.published_at,
        transcript: v.transcript,
        mirrored_from: "video_transcripts",
        mirror_key: v.video_id,
        added_by: "mirror",
        refreshed_at: new Date().toISOString(),
      },
      { onConflict: "url", ignoreDuplicates: false }
    );
    if (!upsertError) added += 1;
  }
  if (added) console.log(`mirror: ${added} own videos synced from video_transcripts`);

  // Backfill: YouTube sources ingested before thumbnails existed.
  const { data: bare } = await supabase
    .from("studio_sources")
    .select("id,url")
    .eq("platform", "youtube")
    .is("thumbnail", null)
    .limit(50);
  for (const s of bare ?? []) {
    const t = ytThumb(s.url);
    if (t) await supabase.from("studio_sources").update({ thumbnail: t }).eq("id", s.id);
  }
  if (bare?.length) console.log(`thumbnails: backfilled ${bare.length} YouTube sources`);
}

// ── Living memory: engagement refresh (daily per source) ────────────────────
async function enrichOwnEngagement() {
  const { data: own } = await supabase
    .from("studio_sources")
    .select("id,url,engagement")
    .eq("kind", "own")
    .eq("platform", "youtube")
    .eq("status", "ready")
    .limit(50);
  const stale = (own ?? []).filter((s) => {
    const checked = s.engagement?.checked_at;
    return !checked || Date.now() - new Date(checked).getTime() > 24 * 3600 * 1000;
  });
  for (const s of stale.slice(0, 8)) {
    try {
      const { stdout } = await ytdlp([
        "--skip-download", "--no-playlist",
        "--print", "%(.{view_count,like_count,comment_count})j", s.url,
      ]);
      const m = JSON.parse(stdout.trim().split("\n")[0]);
      const views = m.view_count ?? null;
      const likes = m.like_count ?? null;
      const comments = m.comment_count ?? null;
      await supabase
        .from("studio_sources")
        .update({
          engagement: {
            views, likes, comments,
            engagement_rate: views ? Number((((likes ?? 0) + (comments ?? 0)) / views).toFixed(4)) : null,
            checked_at: new Date().toISOString(),
          },
        })
        .eq("id", s.id);
    } catch (e) {
      console.error(`engagement refresh failed for ${s.url}: ${e.message}`);
    }
  }
  if (stale.length) console.log(`ledger: refreshed engagement on ${Math.min(stale.length, 8)} own sources`);
}

// ── Living memory: weekly voice-profile regeneration ────────────────────────
async function regenerateVoiceProfile() {
  if (!ANTHROPIC_KEY) return;
  const { data: latest } = await supabase
    .from("voice_profiles")
    .select("version,generated_at")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latest && Date.now() - new Date(latest.generated_at).getTime() < 7 * 24 * 3600 * 1000) return;

  const { data: sources } = await supabase
    .from("studio_sources")
    .select("title,transcript,published_at")
    .eq("kind", "own")
    .eq("status", "ready")
    .not("transcript", "is", null)
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(5);
  if (!sources?.length) return;

  const corpus = sources
    .map((s) => `### ${s.title}\n${(s.transcript ?? "").slice(0, 12000)}`)
    .join("\n\n");
  const res = await boundedFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    redirect: "error",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: ANALYSIS_MODEL,
      max_tokens: 1500,
      messages: [{
        role: "user",
        content:
          "Analyze how this creator ACTUALLY speaks, from these transcripts of their recent published videos. " +
          "Return ONLY a JSON object: { tone (3-5 words), cadence (1 sentence), signature_phrases (5-10 verbatim), " +
          "openers (how they actually open, 2-3 examples), vocabulary_notes (what they say and never say), " +
          "dos (5 short rules for writing as them), donts (5 short rules), summary (2 sentences) }.\n\n" +
          corpus,
      }],
    }),
  }, MODEL_TIMEOUT_MS);
  const json = await res.json();
  if (!res.ok) {
    console.error(`voice profile failed: ${json.error?.message}`);
    return;
  }
  const match = (json.content?.[0]?.text ?? "").match(/\{[\s\S]*\}/);
  if (!match) return;
  try {
    const profile = JSON.parse(match[0]);
    await supabase.from("voice_profiles").insert({
      version: (latest?.version ?? 0) + 1,
      profile,
      source_count: sources.length,
    });
    console.log(`voice profile v${(latest?.version ?? 0) + 1} generated from ${sources.length} sources`);
  } catch (e) {
    console.error(`voice profile parse failed: ${e.message}`);
  }
}

// ── Living memory: weekly outlier radar ─────────────────────────────────────
// Channels live in backend_settings key 'studio_radar_channels' (JSON array of
// channel URLs). Flags videos ≥3× the channel's recent median views, ingests
// them as competitor sources, and files a digest note on the Outlier Radar board.
async function outlierRadar() {
  const { data: cfg } = await supabase.from("backend_settings").select("value").eq("key", "studio_radar_channels").maybeSingle();
  const channels = Array.isArray(cfg?.value) ? cfg.value : [];
  if (!channels.length) return;

  const { data: last } = await supabase.from("backend_settings").select("value").eq("key", "studio_radar_last_run").maybeSingle();
  if (last?.value && Date.now() - new Date(String(last.value)).getTime() < 7 * 24 * 3600 * 1000) return;

  console.log(`radar: scanning ${channels.length} channels`);
  const findings = [];
  for (const ch of channels.slice(0, 10)) {
    try {
      const { stdout } = await ytdlp(
        ["--flat-playlist", "--playlist-end", "20", "--print", "%(.{id,title,view_count})j", String(ch)],
        240000
      );
      const vids = stdout.trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((v) => v && typeof v.view_count === "number");
      if (vids.length < 5) continue;
      const sorted = [...vids].sort((a, b) => a.view_count - b.view_count);
      const median = sorted[Math.floor(sorted.length / 2)].view_count || 1;
      for (const v of vids.filter((v) => v.view_count >= 3 * median).slice(0, 3)) {
        findings.push({ ...v, channel: ch, multiple: (v.view_count / median).toFixed(1) });
      }
    } catch (e) {
      console.error(`radar: ${ch} failed: ${e.message}`);
    }
  }

  for (const f of findings) {
    await api("/api/studio/ingest", "POST", {
      url: `https://www.youtube.com/watch?v=${f.id}`,
      kind: "competitor",
      notes: `Outlier radar: ${f.multiple}× the channel's median views (${f.view_count} views) on ${f.channel}`,
      added_by: "radar",
    }).catch((e) => console.error(`radar ingest: ${e.message}`));
  }

  // Digest note on the Outlier Radar board (created on first run).
  const { boards } = await api("/api/studio/boards");
  let radarBoard = boards.find((b) => b.name === "Outlier Radar");
  if (!radarBoard) radarBoard = (await api("/api/studio/boards", "POST", { name: "Outlier Radar" })).board;
  const { count } = await supabase.from("studio_nodes").select("id", { count: "exact", head: true }).eq("board_id", radarBoard.id);
  const digest = findings.length
    ? `RADAR ${new Date().toISOString().slice(0, 10)} — ${findings.length} outliers found:\n` +
      findings.map((f) => `• ${f.title} — ${f.multiple}× median (${f.view_count} views)`).join("\n") +
      "\nOutliers are ingesting into the swipe bank as competitor sources."
    : `RADAR ${new Date().toISOString().slice(0, 10)} — no outliers ≥3× median this week.`;
  await supabase.from("studio_nodes").insert({
    board_id: radarBoard.id,
    kind: "note",
    position: { x: 0, y: (count ?? 0) * 240 },
    data: { text: digest },
  });

  await supabase.from("backend_settings").upsert({ key: "studio_radar_last_run", value: new Date().toISOString() });
  console.log(`radar: done — ${findings.length} outliers`);
}

// ── Creative generation (fal.ai — factory contract: GPT Image 2) ────────────
class GenJobLeaseLostError extends Error {
  constructor(jobId, fromStatuses) {
    super(`Generation job ${jobId} is no longer owned by this runner in ${fromStatuses.join("/")}`);
    this.name = "GenJobLeaseLostError";
  }
}

/**
 * Every generation transition is a checked compare-and-set. In particular,
 * never spend at fal until `generating` is durably visible, bind every write
 * to a unique claim lease, and never print a terminal result that the database
 * did not confirm.
 */
async function transitionGenJob(job, fromStatuses, patch, attempts = 1, { requireActive = false } = {}) {
  let lastError = null;
  const boundedAttempts = Math.max(1, Math.min(3, Math.trunc(attempts)));
  for (let attempt = 1; attempt <= boundedAttempts; attempt++) {
    let update = supabase
      .from("studio_gen_jobs")
      .update(patch)
      .eq("id", job.id)
      .eq("runner_id", job.runner_id)
      .eq("claimed_at", job.claimed_at)
      .in("status", fromStatuses);
    if (requireActive) update = update.eq("dismissed", false);
    const { data, error } = await update
      .select("*")
      .maybeSingle();
    if (!error && data) return data;
    if (!error) throw new GenJobLeaseLostError(job.id, fromStatuses);
    lastError = error;
    if (attempt < boundedAttempts) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw new Error(
    `Could not persist generation job ${job.id}: ${lastError?.message || "unknown database error"}`
  );
}

const genFetch = (input, init) => boundedFetch(input, init, API_TIMEOUT_MS);

async function persistSubmissionUnknown(job, detail) {
  const safe = String(detail || "The fal submission may have been accepted before its receipt was saved")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 360);
  const terminal = await transitionGenJob(job, ["generating"], {
    status: "submission_unknown",
    stage: "Generation needs review",
    error: `STUDIO:submission_unknown:${safe}`,
    completed_at: new Date().toISOString(),
  }, 3);
  console.error(`  ! gen submission unknown: ${terminal.id}`);
}

async function transitionGenJobToGenerating(job) {
  const submissionStartedAt = new Date().toISOString();
  return transitionGenJob(job, ["claimed"], {
    status: "generating",
    stage: "Submitting to fal",
    submission_started_at: submissionStartedAt,
    provider_request_id: null,
    error: null,
    completed_at: null,
  }, 3, { requireActive: true });
}

async function submitGenProvider(job) {
  const refs = Array.isArray(job.reference_urls) ? job.reference_urls : [];
  const input = {
    prompt: job.prompt,
    num_images: job.count,
    image_size: job.image_size ?? (refs.length ? "auto" : "landscape_4_3"),
    output_format: "png",
    ...(refs.length ? { image_urls: refs } : {}),
  };
  return submitFalQueue({
    model: job.model,
    input,
    key: FAL_KEY,
    fetchJson: genFetch,
  });
}

async function persistRejectedGenJob(job, error) {
  if (error instanceof FalQueueHttpError && [401, 403].includes(error.status)) {
    falCapability = "invalid";
    await reportRunnerHealth("ready", null, { force: true });
  }
  const message = error instanceof Error ? error.message : String(error);
  const terminal = await transitionGenJob(job, ["generating"], {
    status: "failed",
    stage: "Generation rejected",
    error: message.slice(0, 500),
    completed_at: new Date().toISOString(),
  }, 3);
  console.error(`  ✗ gen rejected: ${terminal.error}`);
}

async function persistGenProviderRequest(job, requestId) {
  // fal has accepted a potentially paid request. Persist its recovery handle
  // before polling. If this write cannot be confirmed, exit without submitting
  // again; the stale no-id sweep will expose submission_unknown for review.
  return transitionGenJob(job, ["generating"], {
    stage: "fal is rendering",
    provider_request_id: requestId,
    submitted_at: new Date().toISOString(),
  }, 3);
}

async function reportLostGenProviderReceipt(_job, requestId, error) {
  console.error(
    `  ! fal request ${requestId} was accepted but its recovery id could not be saved; automatic resubmission is disabled (${error instanceof Error ? error.message : String(error)})`
  );
}

async function pollGenJob(job) {
  const deadline = Date.now() + MODEL_TIMEOUT_MS;
  let heartbeatAt = Date.now();
  while (Date.now() < deadline) {
    let outcome;
    try {
      outcome = await inspectFalQueue({
        model: job.model,
        requestId: job.provider_request_id,
        key: FAL_KEY,
        fetchJson: genFetch,
      });
    } catch (error) {
      if (error instanceof FalQueueHttpError && [401, 403].includes(error.status)) {
        falCapability = "invalid";
        await reportRunnerHealth("ready", null, { force: true });
      }
      if (falQueueErrorIsRetryable(error)) {
        console.error(
          `  fal status is temporarily unavailable; request ${job.provider_request_id} remains recoverable (${error instanceof Error ? error.message : String(error)})`
        );
        return;
      }
      const terminal = await transitionGenJob(job, ["generating"], {
        status: "failed",
        stage: "Generation failed",
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        completed_at: new Date().toISOString(),
      }, 3);
      console.error(`  ✗ gen failed: ${terminal.error}`);
      return;
    }

    if (outcome.kind === "pending") {
      const heartbeat = await refreshGenerationHeartbeat(job, {
        lastHeartbeatAt: heartbeatAt,
        touch: (current) => transitionGenJob(current, ["generating"], {
          stage: "fal is rendering",
        }, 3),
      });
      job = heartbeat.job;
      heartbeatAt = heartbeat.lastHeartbeatAt;
      await reportRunnerHealth("ready");
      await new Promise((resolve) => setTimeout(resolve, GEN_POLL_INTERVAL_MS));
      continue;
    }
    if (outcome.kind === "failed") {
      const terminal = await transitionGenJob(job, ["generating"], {
        status: "failed",
        stage: "Generation failed",
        error: outcome.error.slice(0, 500),
        completed_at: new Date().toISOString(),
      }, 3);
      console.error(`  ✗ gen failed: ${terminal.error}`);
      return;
    }
    const terminal = await transitionGenJob(job, ["generating"], {
      status: "ready",
      stage: `${outcome.images.length} image(s) ready`,
      results: outcome.images,
      completed_at: new Date().toISOString(),
    }, 3);
    console.log(`  ✓ gen ready: ${outcome.images.length} image(s) (${terminal.id})`);
    return;
  }
  await transitionGenJob(job, ["generating"], {
    stage: "fal is still rendering",
  }, 3);
  console.log(`  fal request ${job.provider_request_id} is still rendering; its durable id will be resumed`);
}

async function processGenJob(job) {
  console.log(`→ gen ${job.id.slice(0, 8)} ${job.model} x${job.count}`);
  if (falCapability !== "ready") await refreshFalCapability({ force: true });
  const capabilityAction = generationFalCapabilityAction({
    hasKey: Boolean(FAL_KEY),
    capability: falCapability,
  });
  if (capabilityAction !== GEN_FAL_CAPABILITY_ACTION.READY) {
    const detail = !FAL_KEY || falCapability === "missing"
      ? "FAL_KEY is not configured; ask the setup agent to connect fal"
      : falCapability === "invalid"
        ? "The configured fal key was rejected; ask the setup agent to reconnect fal"
        : "fal verification is temporarily unavailable; the runner will retry this job";
    if (job.status === "claimed") {
      if (capabilityAction === GEN_FAL_CAPABILITY_ACTION.TERMINAL) {
        const terminal = await transitionGenJob(job, ["claimed"], {
          status: "failed",
          stage: "Image generation is not connected",
          error: `STUDIO:fal_not_configured:${detail}`,
          completed_at: new Date().toISOString(),
        }, 3);
        console.error(`  ✗ gen failed: ${terminal.error}`);
      } else {
        await transitionGenJob(job, ["claimed"], deferredGenerationClaimPatch(), 3);
        console.error("  ! fal verification is temporarily unavailable; generation was returned to the queue");
      }
    } else {
      console.error(
        capabilityAction === GEN_FAL_CAPABILITY_ACTION.DEFER
          ? `  ! fal verification is temporarily unavailable; request ${job.provider_request_id} remains recoverable`
          : `  ! fal request ${job.provider_request_id} remains recoverable but fal authentication needs attention`
      );
    }
    return capabilityAction === GEN_FAL_CAPABILITY_ACTION.DEFER ? "deferred" : "continue";
  }

  await runGenerationJobStateMachine(job, {
    transitionToGenerating: transitionGenJobToGenerating,
    submit: submitGenProvider,
    persistSubmissionUnknown: (current, error) => persistSubmissionUnknown(current, error.message),
    persistRejected: persistRejectedGenJob,
    persistRequestId: persistGenProviderRequest,
    onAcceptedReceiptLost: reportLostGenProviderReceipt,
    poll: pollGenJob,
  });
  return "continue";
}

async function compareAndSetGenRecovery(job, spec) {
  let update = supabase
    .from("studio_gen_jobs")
    .update(spec.patch)
    .eq("id", job.id)
    .eq("status", spec.expectedStatus)
    .eq("updated_at", spec.expectedUpdatedAt);
  if (spec.requireActive) update = update.eq("dismissed", false);
  const { data, error } = await update.select("*").maybeSingle();
  if (error) throw new Error(`Could not recover generation job ${job.id}: ${error.message}`);
  return data;
}

async function claimQueuedGenJob() {
  const { data: queued, error: queueError } = await supabase
    .from("studio_gen_jobs")
    .select("*")
    .eq("status", "queued")
    .eq("dismissed", false)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (queueError) throw new Error(`Could not read generation queue: ${queueError.message}`);
  if (!queued) return null;
  const claimedAt = new Date().toISOString();
  const recovered = await recoverGenerationCandidate(queued, {
    leaseId: genLeaseId(RUNNER_ID),
    nowIso: claimedAt,
    compareAndSet: compareAndSetGenRecovery,
  });
  return recovered.job;
}

async function reclaimStaleGenJob() {
  const providerReceiptCutoff = genProviderReceiptReclaimCutoff();
  const { data: staleProviderReceipt, error: providerReceiptError } = await supabase
    .from("studio_gen_jobs")
    .select("*")
    .eq("status", "generating")
    .not("provider_request_id", "is", null)
    .neq("provider_request_id", "")
    .lt("updated_at", providerReceiptCutoff)
    .order("updated_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (providerReceiptError) {
    throw new Error(`Could not read resumable generation jobs: ${providerReceiptError.message}`);
  }
  if (staleProviderReceipt) {
    const recovered = await recoverGenerationCandidate(staleProviderReceipt, {
      leaseId: genLeaseId(RUNNER_ID),
      nowIso: new Date().toISOString(),
      compareAndSet: compareAndSetGenRecovery,
    });
    return recovered.job || undefined;
  }

  const cutoff = genReclaimCutoff();
  const { data: staleGenerating, error: generatingError } = await supabase
    .from("studio_gen_jobs")
    .select("*")
    .eq("status", "generating")
    .lt("updated_at", cutoff)
    .order("updated_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (generatingError) throw new Error(`Could not read recoverable generation jobs: ${generatingError.message}`);
  if (staleGenerating) {
    const recovered = await recoverGenerationCandidate(staleGenerating, {
      leaseId: genLeaseId(RUNNER_ID),
      nowIso: new Date().toISOString(),
      compareAndSet: compareAndSetGenRecovery,
    });
    if (recovered.action === GEN_RECOVERY_ACTION.QUARANTINE_SUBMISSION_UNKNOWN && recovered.job) {
      console.error(`  ! quarantined ambiguous generation ${staleGenerating.id}; no automatic resubmission`);
    }
    if (recovered.rescan) return undefined;
    return recovered.job || undefined;
  }

  const { data: staleClaimed, error: claimedError } = await supabase
    .from("studio_gen_jobs")
    .select("*")
    .eq("status", "claimed")
    .eq("dismissed", false)
    .lt("claimed_at", cutoff)
    .order("claimed_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (claimedError) throw new Error(`Could not read abandoned generation claims: ${claimedError.message}`);
  if (!staleClaimed) return null;
  const recovered = await recoverGenerationCandidate(staleClaimed, {
    leaseId: genLeaseId(RUNNER_ID),
    nowIso: new Date().toISOString(),
    compareAndSet: compareAndSetGenRecovery,
  });
  return recovered.job || undefined;
}

async function drainGenJobs() {
  for (;;) {
    const recovered = await reclaimStaleGenJob();
    if (recovered === undefined) continue;
    const claimed = recovered || await claimQueuedGenJob();
    if (!claimed) break;
    const result = await processGenJob(claimed);
    if (result === "deferred") return "deferred";
  }
  return "complete";
}

// ── Carousel rendering (§13, client-grade: the RUNNER is the hire) ──────────
// The runner is the sole HOUSE queue executor. A canonical backend receipt
// selects one of five signed local templates; arbitrary database HTML never
// crosses the render boundary. Claude returns plain JSON text + layout hints,
// then deterministic code forces the cover/closer, validates exactly ten
// slides, escapes all content and renders the matching template. The result is
// always a DRAFT post until the member approves it on the canvas. fal belongs
// to Generate image and is never involved in carousels.

async function verifyCarouselToolchain() {
  carouselReady = false;
  carouselChrome = null;
  const proof = assertStudioCarouselRuntimeReady();
  await exec(proof.chrome, ["--version"], { timeout: 20_000, env: safeChildEnv() });
  const browser = await proveStudioCarouselBrowserReady({ proof, env: safeChildEnv() });
  carouselChrome = proof.chrome;
  carouselReady = true;
  return Object.freeze({ ...proof, browserProofs: browser.browserProofs });
}

let carouselToolchainRefreshInFlight = null;
async function refreshCarouselToolchainCapability({ reportHealth = true } = {}) {
  if (carouselToolchainRefreshInFlight) return carouselToolchainRefreshInFlight;
  carouselToolchainRefreshInFlight = (async () => {
    try {
      const proof = await verifyCarouselToolchain();
      if (reportHealth) await reportRunnerHealth("ready", null, { force: true });
      return proof;
    } catch (error) {
      carouselReady = false;
      carouselChrome = null;
      console.error(`carousel toolchain blocked: ${error instanceof Error ? error.message : String(error)}`);
      if (reportHealth) {
        await reportRunnerHealth("blocked", "carousel_toolchain_unavailable", { force: true });
      }
      return null;
    } finally {
      carouselToolchainRefreshInFlight = null;
    }
  })();
  return carouselToolchainRefreshInFlight;
}

async function captureCarouselHtml(
  chrome,
  htmlFile,
  pngFile,
  width,
  height,
  fitLook = null,
  contactSheet = false,
  signal = null,
) {
  let captureFile = htmlFile;
  if (fitLook || contactSheet) {
    const source = readFileSync(htmlFile, "utf8");
    const fitFile = htmlFile.replace(/\.html$/i, "-fit.html");
    const probeScript = contactSheet
      ? studioCarouselContactSheetProbeScript()
      : studioCarouselFitProbeScript(fitLook);
    const instrumented = source.replace(
      /<\/body>/i,
      `<script>${probeScript}</script></body>`,
    );
    if (instrumented === source) throw new Error("Carousel fit proof could not instrument the signed slide");
    writeFileSync(fitFile, instrumented);
    await proveStudioCarouselFitReady({
      chrome,
      htmlFile: fitFile,
      width,
      height,
      label: contactSheet ? "Studio carousel contact-sheet capture" : "Studio carousel production capture",
      runChrome: async (bin, args, options) => exec(bin, args, { ...options, signal }),
      env: safeChildEnv(),
    });
    captureFile = fitFile;
  }
  await exec(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      "--allow-file-access-from-files",
      "--run-all-compositor-stages-before-draw",
      "--virtual-time-budget=30000",
      "--force-device-scale-factor=1",
      `--window-size=${width},${height}`,
      `--screenshot=${pngFile}`,
      pathToFileURL(captureFile).href,
    ],
    { timeout: 60_000, env: safeChildEnv(), signal }
  );
  if (!existsSync(pngFile)) throw new Error("Chrome produced no carousel screenshot");
}

async function uploadCarouselPng(storagePath, pngFile, signal) {
  const bytes = readFileSync(pngFile);
  const operationSupabase = carouselSupabase(signal);
  const upload = await runStudioCarouselIdempotentOperation({
    stage: `storage upload ${storagePath}`,
    operation: () => operationSupabase.storage
      .from("images")
      .upload(storagePath, bytes, { contentType: "image/png", upsert: true }),
    wait: (attempt) => new Promise((resolve) => setTimeout(resolve, attempt * 500)),
    signal,
  });
  const { error } = upload;
  if (error) throw new Error(`carousel image upload failed: ${error.message}`);
  const { data } = supabase.storage.from("images").getPublicUrl(storagePath);
  if (!data?.publicUrl) throw new Error("carousel image upload returned no public URL");
  return data.publicUrl;
}

async function claudeJson(prompt, maxTokens = 3000, parentSignal) {
  const capability = await refreshAnthropicCapability();
  if (capability !== "valid") {
    throw new AnthropicCapabilityDeferredError(
      capability,
      anthropicCapabilityRemediation(capability) || "Anthropic is not ready before the paid request",
    );
  }
  let res;
  try {
    res = await boundedFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      redirect: "error",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: ANALYSIS_MODEL, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
    }, MODEL_TIMEOUT_MS, parentSignal);
  } catch (error) {
    // Force the next lane pass through the zero-cost probe without rewriting
    // the last probe's capability classification from a paid transport error.
    anthropicCapabilityCheckedAt = 0;
    throw new AnthropicMessageFailureError(
      "fail_closed_ambiguous",
      null,
      "The Anthropic response was lost after the paid carousel request was submitted. Studio did not retry the spend-ambiguous request automatically.",
      error,
    );
  }
  if (!res.ok) {
    const messageFailure = anthropicMessageFailureAction(res);
    anthropicCapabilityCheckedAt = 0;
    await res.body?.cancel?.().catch(() => undefined);
    throw new AnthropicMessageFailureError(
      messageFailure.action,
      messageFailure.status,
      anthropicMessageFailureMessage(messageFailure),
    );
  }
  let json;
  try {
    json = await res.json();
  } catch (error) {
    anthropicCapabilityCheckedAt = 0;
    throw new AnthropicMessageFailureError(
      "fail_closed_ambiguous",
      res.status,
      "Anthropic returned HTTP 200, but the paid carousel response was unreadable. Studio did not retry the spend-ambiguous request automatically.",
      error,
    );
  }
  const match = (json.content?.[0]?.text ?? "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Claude returned no JSON");
  return JSON.parse(match[0]);
}

async function reportCarouselJob(job, patch, { terminal = false, durable = false } = {}) {
  let lastError;
  const attempts = terminal || durable ? 3 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await api(
        `/api/studio/carousel-jobs/${job.id}`,
        "PATCH",
        { ...patch, claim_token: job.claim_token },
        undefined,
        CAROUSEL_PROTOCOL_HEADERS,
      );
    } catch (error) {
      if (error instanceof BackendApiError && error.status === 409) {
        throw new CarouselLeaseExpiredError(error.message);
      }
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
  }
  if (
    !(lastError instanceof BackendApiError)
    || [401, 403, 404, 408, 425, 429].includes(lastError.status)
    || lastError.status >= 500
  ) {
    throw new CarouselExecutionOutcomeUnknownError("carousel report", lastError);
  }
  throw lastError;
}

async function carouselDatabaseMutation(stage, task, signal) {
  return runStudioCarouselIdempotentOperation({
    stage,
    operation: task,
    wait: (attempt) => new Promise((resolve) => setTimeout(resolve, attempt * 500)),
    signal,
  });
}

async function withCarouselLeaseHeartbeat(job, report, task) {
  return withStudioCarouselLeaseHeartbeat({
    heartbeatMs: CAROUSEL_LEASE_HEARTBEAT_MS,
    leaseMs: CAROUSEL_LEASE_MS,
    report,
    task,
  });
}

let lastCarouselCleanupFailure = null;
async function cleanupUncommittedCarouselDraft(job, failureMessage) {
  lastCarouselCleanupFailure = null;
  const storagePaths = [
    ...Array.from({ length: STUDIO_CAROUSEL_SLIDE_COUNT }, (_, index) =>
      `carousels/${job.id}/${String(index + 1).padStart(2, "0")}.png`),
    `carousels/${job.id}/contact-sheet.png`,
  ];
  const outcome = await attemptStudioCarouselCleanup({
    cleanDatabase: async () => {
      const { data, error } = await supabase.rpc("studio_cleanup_carousel_draft", {
        p_job_id: job.id,
        p_claim_token: job.claim_token,
        p_error: String(failureMessage || job.error || "The local HOUSE renderer could not finish this carousel").slice(0, 400),
      });
      if (error) throw new Error(error.message);
      return data;
    },
    removeStorage: () => supabase.storage.from("images").remove(storagePaths),
    completeDatabase: async () => {
      const { data, error } = await supabase.rpc("studio_complete_carousel_cleanup", {
        p_job_id: job.id,
        p_claim_token: job.claim_token,
        p_error: String(failureMessage || job.error || "The local HOUSE renderer could not finish this carousel").slice(0, 400),
      });
      if (error) throw new Error(error.message);
      return data;
    },
    wait: (attempt) => new Promise((resolve) => setTimeout(resolve, attempt * 500)),
  });
  if (!outcome.complete) {
    const detail = outcome.error instanceof Error ? `: ${outcome.error.message}` : "";
    lastCarouselCleanupFailure = outcome.error instanceof Error
      ? outcome.error
      : new Error(`Carousel cleanup ${outcome.stage} was not confirmed`);
    console.error(`  carousel cleanup ${outcome.stage} was not confirmed${detail}`);
    return false;
  }
  if (outcome.stage === "preserved_conflict") {
    console.error(`  preserved member-edited carousel draft ${job.id.slice(0, 8)}; automatic cleanup stopped`);
    return "preserved";
  }
  console.error(`  removed uncommitted deterministic carousel draft ${job.id.slice(0, 8)}`);
  return "cleaned";
}

async function processCarouselJob(job) {
  const report = (patch, options) => reportCarouselJob(job, patch, options);
  const dir = mkdtempSync(join(tmpdir(), "studio-carousel-"));
  try {
    if (job.executor !== "employee") throw new Error("The house runner refuses non-employee carousel jobs");
    const jobResult = job.result && typeof job.result === "object" && !Array.isArray(job.result)
      ? job.result
      : null;
    const receipt = assertStudioCarouselConfigReceipt(jobResult?.config_receipt);
    if (receipt.renderer !== "content_manager") {
      throw new Error("This carousel belongs to the external factory, not the house runner");
    }
    const look = receipt.house_look;
    if (!carouselReady || !carouselChrome) {
      throw new Error("Studio carousel runtime was not proven before this claim");
    }
    const chrome = carouselChrome;

    let carousel;
    if (job.model_spend_state === "checkpointed") {
      // The normalized payload is the durable paid-work receipt. Recovery
      // validates and reuses it; it must never call Anthropic a second time.
      carousel = normalizeStudioCarouselPayload(job.structured_payload, look);
      await report({ stage: `Resuming ten slides from the durable ${look} checkpoint`, progress: 14 });
    } else if (job.model_spend_state === "not_started") {
      // Persist the ambiguous boundary before submitting the paid request. If
      // the process disappears after this acknowledgement, stale recovery
      // fails closed instead of guessing whether the provider charged.
      await report({
        stage: `Structuring ten slides (${look})`,
        progress: 12,
        model_spend_state: "in_flight",
      }, { durable: true });
      const structured = await withCarouselLeaseHeartbeat(job, report, (signal) => claudeJson(
        `${studioCarouselModelInstruction(look)}\n\nDraft:\n${job.request}`,
        3000,
        signal,
      ));
      carousel = normalizeStudioCarouselPayload(structured, look);
      // This acknowledgement is the resume checkpoint and therefore receives
      // bounded response-loss retries. Rendering never starts without it.
      await report({
        stage: `Structured ten slides (${look}); durable checkpoint saved`,
        progress: 14,
        model_spend_state: "checkpointed",
        structured_payload: carousel,
      }, { durable: true });
    } else {
      throw new Error("The HOUSE model spend state is ambiguous; refusing a second Anthropic request");
    }
    const slides = carousel.slides;

    const urls = [];
    const pngFiles = [];
    for (let i = 0; i < slides.length; i++) {
      await report({
        stage: `Rendering slide ${i + 1} of ${slides.length} (${look} template)`,
        progress: 15 + Math.round((i / slides.length) * 70),
        result: { slide_total: slides.length, slide_urls: urls },
      });
      const htmlFile = join(dir, `slide-${i + 1}.html`);
      const pngFile = join(dir, `slide-${i + 1}.png`);
      writeFileSync(htmlFile, renderStudioCarouselSlide({ look, slide: slides[i], number: i + 1 }));
      await withCarouselLeaseHeartbeat(job, report, (signal) =>
        captureCarouselHtml(chrome, htmlFile, pngFile, 1080, 1350, look, false, signal));
      const path = `carousels/${job.id}/${String(i + 1).padStart(2, "0")}.png`;
      urls.push(await withCarouselLeaseHeartbeat(job, report, (signal) =>
        uploadCarouselPng(path, pngFile, signal)));
      pngFiles.push(pngFile);
      await report({ result: { slide_total: slides.length, slide_urls: urls } });
    }

    if (urls.length !== STUDIO_CAROUSEL_SLIDE_COUNT) {
      throw new Error(`Carousel renderer produced ${urls.length} slides instead of ${STUDIO_CAROUSEL_SLIDE_COUNT}`);
    }
    await report({ stage: "Building the 2 × 5 contact sheet", progress: 88, result: { slide_total: slides.length, slide_urls: urls } });
    const contactHtml = join(dir, "contact-sheet.html");
    const contactPng = join(dir, "contact-sheet.png");
    writeFileSync(contactHtml, buildStudioCarouselContactSheet({
      look,
      imageSources: pngFiles.map((file) => pathToFileURL(file).href),
    }));
    await withCarouselLeaseHeartbeat(job, report, (signal) =>
      captureCarouselHtml(chrome, contactHtml, contactPng, 1200, 3600, null, true, signal));
    const contactSheetUrl = await withCarouselLeaseHeartbeat(job, report, (signal) =>
      uploadCarouselPng(`carousels/${job.id}/contact-sheet.png`, contactPng, signal));

    await report({
      stage: "Filing the draft post",
      progress: 92,
      result: {
        contact_sheet_url: contactSheetUrl,
        contact_sheet_receipt: CAROUSEL_CONTACT_SHEET_RECEIPT,
        slide_total: slides.length,
        slide_urls: urls,
      },
    });
    const { data: materialized, error: materializeError } = await withCarouselLeaseHeartbeat(
      job,
      report,
      (signal) => carouselDatabaseMutation(
        "lease-fenced draft and media materialization",
        () => carouselSupabase(signal).rpc("studio_materialize_carousel_draft", {
          p_job_id: job.id,
          p_claim_token: job.claim_token,
          p_title: `Carousel · ${job.source_title ?? "Studio"}`,
          p_caption: carousel.caption,
          p_slide_urls: urls,
        }),
        signal,
      ),
    );
    if (materializeError) throw new Error(`carousel draft materialization failed: ${materializeError.message}`);
    if (materialized?.state === "cleanup_pending") {
      console.error(`  member-deleted draft ${job.id.slice(0, 8)} was not recreated; deterministic storage cleanup will resume on the next pass`);
      return "deferred";
    }
    if (
      !materialized
      || materialized.state !== "materialized"
      || materialized.post_id !== job.id
      || materialized.media_count !== STUDIO_CAROUSEL_SLIDE_COUNT
    ) {
      throw new CarouselLeaseExpiredError(
        "The HOUSE lease changed before its draft and ten media rows could commit atomically",
      );
    }
    const postId = materialized.post_id;
    await report({
      status: "ready",
      post_id: postId,
      stage: "Ready for review on the board",
      result: {
        contact_sheet_url: contactSheetUrl,
        contact_sheet_receipt: CAROUSEL_CONTACT_SHEET_RECEIPT,
        slide_total: slides.length,
        slide_urls: urls,
      },
    }, { terminal: true });
    console.log(`  ✓ carousel ready: ${slides.length} slides + contact sheet (${look}, ${receipt.template_id})`);
  } catch (e) {
    console.error(`  ✗ carousel failed: ${e.message}`);
    if (e instanceof AnthropicCapabilityDeferredError) {
      try {
        await report({
          capability_deferred: e.capability,
          pre_submit_deferred: true,
          stage: "Anthropic capability needs attention; returned to queue before a model spend",
          progress: 0,
        }, { durable: true });
      } catch (reportError) {
        console.error(`  carousel Anthropic deferral acknowledgement was not confirmed: ${reportError.message}`);
      }
      return "deferred";
    }
    if (
      e instanceof CarouselExecutionOutcomeUnknownError
      || e instanceof StudioCarouselTransportOutcomeUnknownError
    ) {
      console.error(`  ${e.stage} will be resolved by lease expiry and deterministic replay; job was not failed`);
      return "deferred";
    }
    if (e instanceof CarouselLeaseExpiredError) {
      console.error(`  carousel lease changed; the current owner or human decision stands for ${job.id.slice(0, 8)}`);
      return "deferred";
    }
    // Never create a terminal failed row while deterministic artifacts may
    // still exist. The active leased job itself is the durable retry receipt:
    // if database/storage cleanup cannot be confirmed, lease recovery retries
    // cleanup after restart. Only a confirmed zero-artifact state may become
    // terminal failed.
    const cleanup = await cleanupUncommittedCarouselDraft(job, e.message);
    if (!cleanup) {
      console.error("  carousel cleanup is still pending; leaving the leased job recoverable instead of orphaning artifacts");
      return "deferred";
    }
    if (cleanup === "preserved") {
      console.error("  carousel stopped safely because the member-edited draft was preserved");
      return e instanceof AnthropicMessageFailureError ? "deferred" : "complete";
    }
    console.error("  carousel cleanup completed and the failure is terminal without orphaned artifacts");
    if (e instanceof AnthropicMessageFailureError) return "deferred";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function drainCarouselCleanupJobs() {
  const now = new Date().toISOString();
  const { data: candidates, error } = await supabase
    .from("carousel_jobs")
    .select("*")
    .eq("executor", "employee")
    .eq("status", "cleanup_pending")
    .or(`cleanup_retry_at.is.null,cleanup_retry_at.lte.${now}`)
    .order("cleanup_retry_at", { ascending: true, nullsFirst: true })
    .order("updated_at", { ascending: true })
    .limit(8);
  if (error) throw new Error(`carousel cleanup queue read failed: ${error.message}`);

  for (const candidate of candidates ?? []) {
    let job = candidate;
    if (!job.claim_token) {
      // Recover a malformed/legacy pending row by fencing it before touching
      // deterministic objects. A compare-and-set prevents two runners from
      // inventing different cleanup owners.
      const token = randomUUID();
      const { data: fenced, error: fenceError } = await supabase
        .from("carousel_jobs")
        .update({ claim_token: token })
        .eq("id", job.id)
        .eq("status", "cleanup_pending")
        .is("claim_token", null)
        .select("*")
        .maybeSingle();
      if (fenceError) {
        console.error(`carousel cleanup ${job.id.slice(0, 8)} could not acquire a recovery token: ${fenceError.message}`);
        continue;
      }
      if (!fenced) continue;
      job = fenced;
    }

    const cleanup = await cleanupUncommittedCarouselDraft(job, job.error);
    if (cleanup) continue;

    const failurePatch = studioCarouselCleanupFailurePatch({
      attempts: job.cleanup_attempts,
      error: lastCarouselCleanupFailure
        || job.cleanup_last_error
        || job.error
        || "Carousel cleanup could not be confirmed",
    });
    const mutation = supabase
      .from("carousel_jobs")
      .update(failurePatch)
      .eq("id", job.id)
      .eq("status", "cleanup_pending")
      .eq("claim_token", job.claim_token)
      .eq("cleanup_attempts", Number(job.cleanup_attempts) || 0);
    const { data: recorded, error: recordError } = await mutation
      .select("id,status,cleanup_attempts")
      .maybeSingle();
    if (recordError) {
      console.error(`carousel cleanup ${job.id.slice(0, 8)} retry receipt failed: ${recordError.message}`);
      continue;
    }
    if (recorded?.status === "cleanup_quarantined") {
      console.error(`carousel cleanup ${job.id.slice(0, 8)} quarantined after ${recorded.cleanup_attempts} bounded attempts; later jobs may continue`);
    }
  }
  return "complete";
}

async function drainCarouselJobs() {
  await drainCarouselCleanupJobs();
  if (!carouselReady) {
    console.error("carousel lane blocked: local Chrome/template toolchain is not verified");
    return "deferred";
  }
  const capability = await refreshAnthropicCapability();
  if (capability !== "valid") {
    console.error(`carousel lane deferred: ${anthropicCapabilityRemediation(capability)}`);
    return "deferred";
  }
  return drainAnthropicGatedQueue({
    getCapability: () => anthropicCapability,
    claim: async () => {
      await reportRunnerHealth("ready");
      const { job } = await api(
        "/api/studio/carousel-jobs/claim",
        "POST",
        {},
        undefined,
        CAROUSEL_PROTOCOL_HEADERS,
      );
      return job;
    },
    process: async (job) => {
      console.log(`→ carousel ${job.id.slice(0, 8)} "${(job.source_title ?? "untitled").slice(0, 40)}"`);
      return processCarouselJob(job);
    },
  });
}

// ── Passes ──────────────────────────────────────────────────────────────────
let busy = false;
let rerun = false;
let genRetryNotBefore = 0;

/** Drain the queue: claim and process until empty. Re-entrant safe. */
async function drain(withMirror = false) {
  if (busy) {
    rerun = true;
    return;
  }
  busy = true;
  try {
    do {
      rerun = false;
      // Each section fails alone — a transient "fetch failed" in the mirror
      // pass must not stop queued jobs from being claimed, and vice versa.
      if (withMirror) {
        await refreshFalCapability();
        try {
          const cleanup = await api("/api/studio/uploads/cleanup", "POST", {});
          if (cleanup.removed || cleanup.failed) {
            console.log(`uploads: removed ${cleanup.removed || 0}; pending failures ${cleanup.failed || 0}`);
          }
        } catch (e) {
          console.error(`upload cleanup pass error: ${e.message}`);
        }
        try {
          await mirrorOwnVideos();
          await enrichOwnEngagement();
          await regenerateVoiceProfile();
          await outlierRadar();
        } catch (e) {
          console.error(`mirror pass error: ${e.message}`);
        }
      }
      withMirror = false;
      try {
        for (;;) {
          const { job } = await api("/api/studio/jobs/claim", "POST", { runner_id: RUNNER_ID });
          if (!job) break;
          await processJob(job);
        }
      } catch (e) {
        console.error(`claim error: ${e.message}`);
      }
      try {
        if (Date.now() >= genRetryNotBefore) {
          const genResult = await drainGenJobs();
          if (genResult === "deferred") {
            genRetryNotBefore = Date.now() + GEN_FAL_CAPABILITY_RETRY_MS;
          }
        }
      } catch (e) {
        console.error(`gen error: ${e.message}`);
      }
      try {
        await drainCarouselJobs();
      } catch (e) {
        console.error(`carousel error: ${e.message}`);
      }
      await reportRunnerHealth("ready");
    } while (rerun);
  } catch (e) {
    console.error(`pass error: ${e.message}`);
  } finally {
    busy = false;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
// Daemon by default (launchd KeepAlive): initial sweep, then Supabase
// Realtime pushes new jobs → claimed in seconds. A 5-min fallback sweep
// catches anything a dropped websocket missed. `--once` = single pass.
async function main() {
  const once = process.argv.includes("--once");
  if (Number(process.versions.node.split(".")[0]) < 22) {
    throw new Error(`Node 22+ required (found ${process.versions.node})`);
  }
  if (process.argv.includes("--print-identity")) {
    console.log(`${BACKEND_ORIGIN}\t${INSTANCE_ID}`);
    return;
  }
  const pairing = await verifyBackendDatabasePairing();
  // Parsing candidates is side-effect free and catches a bad explicit override
  // during setup's mutation-free pairing gate.
  runnerLockPorts(INSTANCE_ID);
  if (process.argv.includes("--check-pairing")) {
    console.log(`runner pairing passed: ${BACKEND_ORIGIN} database=${pairing.project_ref}`);
    return;
  }
  if (process.argv.includes("--check-worker-anthropic")) {
    const workerAnthropic = await verifyWorkerAnthropicCapability();
    console.log(`Worker Anthropic check passed: worker_anthropic=${workerAnthropic.status} transport=${workerAnthropic.transport}`);
    return;
  }
  if (process.argv.includes("--check-carousel")) {
    const carousel = await verifyCarouselToolchain();
    console.log(`runner carousel check passed: chrome=${carousel.chrome} looks=${carousel.loadedLooks.length} browser_proofs=${carousel.browserProofs.length} assets=${carousel.loadedAssets.length}`);
    return;
  }
  await refreshAnthropicCapability({ force: true });
  if (process.argv.includes("--check-anthropic")) {
    if (anthropicCapability !== "valid") {
      throw new Error(anthropicCapabilityRemediation(anthropicCapability));
    }
    console.log(`runner Anthropic check passed: anthropic=${anthropicCapability}`);
    return;
  }
  const checkMode = process.argv.includes("--check");
  const carousel = checkMode
    ? await verifyCarouselToolchain()
    : await refreshCarouselToolchainCapability({ reportHealth: false });
  const toolchain = await verifyPinnedToolchain();
  await refreshFalCapability({ force: true });
  if (checkMode) {
    if (anthropicCapability !== "valid") {
      throw new Error(anthropicCapabilityRemediation(anthropicCapability));
    }
    const workerAnthropic = await verifyWorkerAnthropicCapability();
    console.log(
      `runner check passed: ${BACKEND_ORIGIN} instance=${INSTANCE_ID} ` +
      `database=${pairing.project_ref} ` +
      `node=${process.versions.node} yt-dlp=${toolchain.ytVersion} ` +
      `ffmpeg=${toolchain.ffmpegVersion.split("\n")[0]} ` +
      `ffprobe=${toolchain.ffprobeVersion.split("\n")[0]} ` +
      `chrome=${carousel.chrome} carousel_assets=${carousel.loadedAssets.length} ` +
      `openai=${OPENAI_KEY ? "present" : "optional-missing"} ` +
      `studio_queue=readable anthropic=${anthropicCapability} ` +
      `worker_anthropic=${workerAnthropic.status} fal=${falCapability}`
    );
    return;
  }
  runnerLock = await acquireRunnerLock(INSTANCE_ID);
  if (!runnerLock.acquired) {
    console.log("another runner is active; exiting");
    runnerLock = null;
    return;
  }
  await reportRunnerHealth("ready", null, { force: true });
  const cleanup = async () => {
    await releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  await drain(true);
  if (once) {
    await releaseLock();
    return;
  }

  // Realtime with self-healing: a dead websocket must never mean 5-minute
  // latency. On error/timeout, tear the channel down and resubscribe.
  let channel = null;
  const subscribeRealtime = () => {
    if (channel) supabase.removeChannel(channel).catch(() => {});
    channel = supabase
      .channel("studio-jobs")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "studio_ingest_jobs" },
        () => {
          console.log("realtime: new ingest job");
          drain();
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "studio_gen_jobs" },
        () => {
          console.log("realtime: new gen job");
          drain();
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "carousel_jobs" },
        () => {
          console.log("realtime: new carousel job");
          drain();
        }
      )
      .subscribe((status) => {
        console.log(`realtime: ${status}`);
        if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
          setTimeout(subscribeRealtime, 10_000);
        }
      });
  };
  subscribeRealtime();

  // Two cadences: a light claim-poll every 20s (one cheap API call when the
  // queue is empty) keeps worst-case latency in seconds even with realtime
  // down; the heavy pass (mirror, engagement, voice, radar) stays at 5 min.
  setInterval(() => drain(), 20 * 1000);
  setInterval(() => drain(true), 5 * 60 * 1000);
  setInterval(() => {
    if (!carouselReady) void refreshCarouselToolchainCapability();
  }, 5 * 60 * 1000);
  console.log(`daemon up (${RUNNER_ID}) — realtime + 20s claim-poll + 5-min full sweep`);
}

main().catch(async (e) => {
  if (e instanceof RunnerLockError) {
    console.error(`[${e.code}] ${e.message}`);
    await reportRunnerHealth("blocked", e.code, { force: true });
  } else console.error(e);
  await releaseLock();
  process.exit(1);
});
