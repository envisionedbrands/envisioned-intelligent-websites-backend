/**
 * POST /api/studio/carousel-jobs/claim — CAS lease door for the local HOUSE
 * renderer. The installed local runner remains the sole HOUSE executor. A
 * stale pre-spend job or durable structured checkpoint is safe to
 * reclaim. An expired `in_flight` model request is deliberately failed closed:
 * the backend cannot prove whether Anthropic charged before the process died.
 */
import { NextRequest, NextResponse } from "next/server";
import { studioMachineAuth } from "@/lib/studio/auth";
import { createAdminClient } from "@/lib/supabase/server";
import {
  STUDIO_CAROUSEL_LEASE_SECONDS,
  STUDIO_CAROUSEL_RUNNER_PROTOCOL,
  validateStudioCarouselCheckpoint,
} from "@/lib/studio/carousel-execution";
import { validateCarouselConfigReceipt } from "@/lib/studio/carousel-template-registry";
import { expectedStudioRunnerInstanceId } from "@/lib/studio/runner-server-identity";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const carouselJobs = (supabase: ReturnType<typeof createAdminClient>): any =>
  (supabase as unknown as { from(table: string): unknown }).from("carousel_jobs");

const ACTIVE_HOUSE_STATUSES = ["running", "writing", "rendering", "uploading", "revising"];

const leaseExpiry = () => new Date(Date.now() + STUDIO_CAROUSEL_LEASE_SECONDS * 1000).toISOString();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bindObservedLease = (query: any, job: Record<string, unknown>) => {
  let guarded = query.eq("id", job.id).eq("status", job.status);
  guarded = job.claim_token
    ? guarded.eq("claim_token", job.claim_token)
    : guarded.is("claim_token", null);
  return job.lease_expires_at
    ? guarded.eq("lease_expires_at", job.lease_expires_at)
    : guarded.is("lease_expires_at", null);
};

async function failAmbiguousSpend(
  supabase: ReturnType<typeof createAdminClient>,
  job: Record<string, unknown>,
  detail = "The previous HOUSE runner ended during the paid structure request. Studio stopped instead of risking a second charge.",
) {
  const update = carouselJobs(supabase).update({
    status: "failed",
    stage: "Stopped after an ambiguous model request",
    progress: 100,
    error: detail,
    claim_token: null,
    lease_expires_at: null,
    completed_at: new Date().toISOString(),
  });
  return bindObservedLease(update, job)
    .eq("model_spend_state", job.model_spend_state)
    .select("id")
    .maybeSingle();
}

async function queueInvalidCheckpointCleanup(
  supabase: ReturnType<typeof createAdminClient>,
  job: Record<string, unknown>,
  issue: string,
) {
  // A checkpoint can become invalid after deterministic rendering or even a
  // response-lost draft materialization. Give cleanup a fresh ownership token
  // and keep the row non-terminal until its draft, media and eleven fixed
  // object paths have all been swept.
  const cleanupToken = crypto.randomUUID();
  const update = carouselJobs(supabase).update({
    status: "cleanup_pending",
    stage: "Invalid durable checkpoint quarantined for deterministic cleanup",
    progress: 100,
    error: `The durable HOUSE checkpoint failed validation (${issue}). Studio stopped before any second model request and queued its artifacts for cleanup.`,
    claim_token: cleanupToken,
    lease_expires_at: null,
    completed_at: null,
    cleanup_attempts: 0,
    cleanup_last_error: null,
    cleanup_retry_at: null,
  });
  return bindObservedLease(update, job)
    .eq("model_spend_state", job.model_spend_state)
    .select("id,claim_token")
    .maybeSingle();
}

export async function POST(request: NextRequest) {
  const auth = studioMachineAuth(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (request.headers.get("x-studio-carousel-protocol") !== STUDIO_CAROUSEL_RUNNER_PROTOCOL) {
    return NextResponse.json(
      {
        error: "Studio carousel runner 1.6.7 setup is required before HOUSE work can be claimed.",
        code: "studio_carousel_runner_upgrade_required",
      },
      { status: 426 },
    );
  }

  const supabase = createAdminClient();
  let instanceId: string;
  try {
    instanceId = await expectedStudioRunnerInstanceId(request.url);
  } catch {
    return NextResponse.json({ error: "Runner identity is not configured" }, { status: 503 });
  }
  const { data: runnerHealth, error: runnerHealthError } = await supabase
    .from("studio_runner_health")
    .select("status,capabilities,last_seen_at")
    .eq("instance_id", instanceId)
    .maybeSingle();
  const capabilities = runnerHealth?.capabilities && typeof runnerHealth.capabilities === "object"
    ? runnerHealth.capabilities as Record<string, unknown>
    : null;
  const healthFresh = runnerHealth?.last_seen_at
    && Date.now() - Date.parse(runnerHealth.last_seen_at) <= 2 * 60_000;
  if (
    runnerHealthError
    || !runnerHealth
    || runnerHealth.status !== "ready"
    || !healthFresh
    || capabilities?.carousel_ready !== true
    || capabilities?.anthropic_status !== "valid"
  ) {
    return NextResponse.json(
      {
        error: "The local Studio carousel runtime is not freshly verified. Rerun Studio runner setup before queueing HOUSE work.",
        code: "studio_carousel_runner_not_ready",
      },
      { status: 503 },
    );
  }
  const now = new Date().toISOString();

  // Bound the loop: one request may fence a few abandoned ambiguous rows, but
  // it can never become an unbounded cleanup Worker request.
  for (let attempt = 0; attempt < 8; attempt++) {
    const { data: ambiguous, error: ambiguousError } = await carouselJobs(supabase)
      .select("*")
      .eq("executor", "employee")
      .in("status", ACTIVE_HOUSE_STATUSES)
      .eq("model_spend_state", "in_flight")
      .lte("lease_expires_at", now)
      .order("lease_expires_at", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (ambiguousError) return NextResponse.json({ error: ambiguousError.message }, { status: 500 });
    if (ambiguous) {
      const { data: fenced, error: fenceError } = await failAmbiguousSpend(supabase, ambiguous);
      if (fenceError) return NextResponse.json({ error: fenceError.message }, { status: 500 });
      if (fenced) continue;
    }

    const { data: stale, error: staleError } = await carouselJobs(supabase)
      .select("*")
      .eq("executor", "employee")
      .in("status", ACTIVE_HOUSE_STATUSES)
      .in("model_spend_state", ["not_started", "checkpointed"])
      .lte("lease_expires_at", now)
      .order("lease_expires_at", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (staleError) return NextResponse.json({ error: staleError.message }, { status: 500 });
    if (stale) {
      if (stale.model_spend_state === "checkpointed") {
        const rawReceipt = stale.result && typeof stale.result === "object" && !Array.isArray(stale.result)
          ? stale.result.config_receipt
          : null;
        const receipt = validateCarouselConfigReceipt(rawReceipt);
        const checkpoint = receipt.ok
          ? validateStudioCarouselCheckpoint(stale.structured_payload, receipt.receipt)
          : { ok: false as const, issue: "config_receipt_invalid" };
        if (!checkpoint.ok) {
          const { data: fenced, error: fenceError } = await queueInvalidCheckpointCleanup(
            supabase,
            stale,
            checkpoint.issue,
          );
          if (fenceError) return NextResponse.json({ error: fenceError.message }, { status: 500 });
          if (fenced) continue;
        }
      }

      const claimToken = crypto.randomUUID();
      const recovered = bindObservedLease(
        carouselJobs(supabase).update({
          claim_token: claimToken,
          lease_expires_at: leaseExpiry(),
          claimed_at: new Date().toISOString(),
          stage: stale.model_spend_state === "checkpointed"
            ? "Resuming from the durable structured carousel checkpoint"
            : "Resuming before the model structure request",
          error: null,
        }),
        stale,
      )
        .eq("model_spend_state", stale.model_spend_state)
        .select("*")
        .maybeSingle();
      const { data: claimed, error: recoverError } = await recovered;
      if (recoverError) return NextResponse.json({ error: recoverError.message }, { status: 500 });
      if (claimed) return NextResponse.json({ job: claimed });
      continue;
    }

    const { data: queued, error } = await carouselJobs(supabase)
      .select("*")
      .eq("status", "queued")
      .eq("executor", "employee")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!queued) return NextResponse.json({ job: null });

    const claimToken = crypto.randomUUID();
    const { data: claimed, error: claimError } = await carouselJobs(supabase)
      .update({
        status: "rendering",
        stage: "The local HOUSE renderer claimed an exclusive execution lease",
        progress: 10,
        claim_token: claimToken,
        lease_expires_at: leaseExpiry(),
        model_spend_state: "not_started",
        structured_payload: null,
        claimed_at: new Date().toISOString(),
        error: null,
      })
      .eq("id", queued.id)
      .eq("status", "queued")
      .is("claim_token", null)
      .select("*")
      .maybeSingle();
    if (claimError) return NextResponse.json({ error: claimError.message }, { status: 500 });
    if (claimed) return NextResponse.json({ job: claimed });
  }

  return NextResponse.json({ job: null });
}
