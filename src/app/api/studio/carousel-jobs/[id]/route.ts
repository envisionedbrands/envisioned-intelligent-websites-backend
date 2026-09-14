/**
 * PATCH /api/studio/carousel-jobs/:id — lease-fenced HOUSE runner reports.
 * Every mutation compares the observed status, claim token, unexpired lease,
 * and (when relevant) model ledger state. The runner can stage only a DRAFT;
 * approve/reject remains a session-only human decision through outputs.
 */
import { NextRequest, NextResponse } from "next/server";
import { studioMachineAuth } from "@/lib/studio/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { mergeCarouselJobResult } from "@/lib/studio/carousel-job-result";
import {
  buildLegacyFactoryCarouselReport,
  sameStudioCarouselJsonValue,
  STUDIO_CAROUSEL_LEASE_SECONDS,
  STUDIO_CAROUSEL_RUNNER_PROTOCOL,
  validateStudioCarouselCheckpoint,
  validateStudioCarouselReadyEvidence,
} from "@/lib/studio/carousel-execution";
import { validateCarouselConfigReceipt } from "@/lib/studio/carousel-template-registry";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const carouselJobs = (supabase: ReturnType<typeof createAdminClient>): any =>
  (supabase as unknown as { from(table: string): unknown }).from("carousel_jobs");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Body = {
  claim_token?: string;
  status?: string;
  stage?: string;
  progress?: number;
  post_id?: string;
  model_spend_state?: "in_flight" | "checkpointed";
  structured_payload?: unknown;
  capability_deferred?:
    | "invalid_provider_credential"
    | "provider_permission_denied"
    | "billing_required"
    | "intermediary_policy_blocked"
    | "rate_limited";
  pre_submit_deferred?: true;
  result?: {
    config_receipt?: unknown;
    contact_sheet_url?: string;
    contact_sheet_receipt?: {
      contract_revision: "studio_carousel_contact_sheet_v1";
      columns: 2;
      rows: 5;
      numbered: true;
      slide_total: 10;
    };
    slide_urls?: string[];
    slide_total?: number;
  };
  scheduled_at?: string;
  error?: string;
};

const terminalReplay = (job: { status: string }, body: Body) => {
  if (job.status === "ready" && body.status === "ready") return "ready_replayed";
  if (job.status === "failed" && body.status === "failed") return "failed_replayed";
  if (["approved", "rejected"].includes(job.status) && body.status === "ready") {
    return "human_decision_stands";
  }
  return null;
};

const SAFE_ANTHROPIC_CAPABILITY_DEFERRALS = new Set([
  "invalid_provider_credential",
  "provider_permission_denied",
  "billing_required",
  "intermediary_policy_blocked",
  "rate_limited",
]);

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = studioMachineAuth(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  if (body.status && !["rendering", "ready", "failed"].includes(body.status)) {
    return NextResponse.json({ error: "status must be rendering, ready, or failed" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: job, error: jobError } = await carouselJobs(supabase).select("*").eq("id", id).maybeSingle();
  if (jobError) return NextResponse.json({ error: jobError.message }, { status: 500 });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const houseExecution = job.executor === "employee";
  if (
    houseExecution
    && request.headers.get("x-studio-carousel-protocol") !== STUDIO_CAROUSEL_RUNNER_PROTOCOL
  ) {
    return NextResponse.json(
      {
        error: "Studio carousel runner 1.6.7 setup is required before HOUSE reports are accepted.",
        code: "studio_carousel_runner_upgrade_required",
      },
      { status: 426 },
    );
  }

  // HOUSE failures may have already materialised deterministic post/media or
  // storage artifacts. They must therefore pass through the durable,
  // restartable cleanup_pending RPC lane; a plain report must never make the
  // job terminal and orphan those artifacts. FACTORY keeps its established
  // machine-report compatibility path because its artifacts are external.
  if (houseExecution && body.status === "failed") {
    return NextResponse.json(
      {
        error: "HOUSE carousel failures require confirmed durable cleanup before terminal failure",
        code: "studio_carousel_cleanup_required",
      },
      { status: 409 },
    );
  }

  const replay = terminalReplay(job, body);
  if (replay) return NextResponse.json({ ok: true, state: replay, status: job.status });
  if (["ready", "failed"].includes(job.status) || ["approved", "rejected"].includes(job.status)) {
    return NextResponse.json(
      { error: `Job is already terminal (${job.status}); machine reports cannot change it` },
      { status: 409 },
    );
  }

  if (!houseExecution) {
    if (body.model_spend_state || body.structured_payload !== undefined || body.capability_deferred !== undefined) {
      return NextResponse.json(
        { error: "The external FACTORY owns its own spend checkpoint protocol" },
        { status: 400 },
      );
    }
    const planned = buildLegacyFactoryCarouselReport(job, body);
    if (!planned.ok) {
      return NextResponse.json(
        { error: planned.issue === "ready_post_required"
          ? "ready requires post_id (the draft social post carrying the slides)"
          : "Nothing to update" },
        { status: 400 },
      );
    }
    if (planned.readyPostId) {
      const { data: post, error: postError } = await supabase
        .from("social_posts")
        .select("id")
        .eq("id", planned.readyPostId)
        .maybeSingle();
      if (postError) return NextResponse.json({ error: postError.message }, { status: 500 });
      if (!post) return NextResponse.json({ error: "post_id does not match a social post" }, { status: 400 });
    }
    const { data: changed, error } = await carouselJobs(supabase)
      .update(planned.update)
      .eq("id", id)
      .eq("status", job.status)
      .select("id,status")
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (changed) return NextResponse.json({ ok: true, state: "applied", status: changed.status });
    const { data: current, error: currentError } = await carouselJobs(supabase)
      .select("status")
      .eq("id", id)
      .maybeSingle();
    if (currentError) return NextResponse.json({ error: currentError.message }, { status: 500 });
    const lateReplay = current ? terminalReplay(current, body) : null;
    if (lateReplay) return NextResponse.json({ ok: true, state: lateReplay, status: current.status });
    return NextResponse.json(
      { error: "The carousel status changed before this FACTORY report committed" },
      { status: 409 },
    );
  }

  const now = new Date();
  if (houseExecution) {
    if (!body.claim_token || !UUID.test(body.claim_token) || body.claim_token !== job.claim_token) {
      return NextResponse.json({ error: "The HOUSE execution lease belongs to another runner" }, { status: 409 });
    }
    if (!job.lease_expires_at || Date.parse(job.lease_expires_at) <= now.getTime()) {
      return NextResponse.json({ error: "The HOUSE execution lease expired before this report" }, { status: 409 });
    }
  }

  const update: Record<string, unknown> = {};
  if (body.status) update.status = body.status;
  if (body.stage) update.stage = String(body.stage).slice(0, 300);
  if (typeof body.progress === "number") update.progress = Math.max(0, Math.min(100, Math.round(body.progress)));
  if (body.post_id) {
    if (!UUID.test(body.post_id)) return NextResponse.json({ error: "post_id must be a UUID" }, { status: 400 });
    update.post_id = body.post_id;
  }

  const existingReceipt = job.result && typeof job.result === "object" && !Array.isArray(job.result)
    ? job.result.config_receipt
    : null;
  const receipt = validateCarouselConfigReceipt(existingReceipt);
  if (!receipt.ok) {
    return NextResponse.json({ error: "The queue-time carousel configuration receipt is invalid" }, { status: 409 });
  }

  if (body.capability_deferred !== undefined) {
    if (
      !houseExecution
      || !SAFE_ANTHROPIC_CAPABILITY_DEFERRALS.has(body.capability_deferred)
      || body.pre_submit_deferred !== true
      || body.status !== undefined
      || body.model_spend_state !== undefined
      || body.structured_payload !== undefined
      || body.result !== undefined
      || body.post_id !== undefined
      || job.model_spend_state !== "in_flight"
      || job.structured_payload != null
    ) {
      return NextResponse.json(
        { error: "Only a locally confirmed pre-submit probe result may defer a HOUSE job" },
        { status: 409 },
      );
    }
    const existingResult = job.result && typeof job.result === "object" && !Array.isArray(job.result)
      ? job.result as Record<string, unknown>
      : {};
    const deferCount = Math.max(0, Number(existingResult.pre_submit_defer_count) || 0) + 1;
    update.result = { ...existingResult, pre_submit_defer_count: deferCount };
    update.status = deferCount >= 3 ? "failed" : "queued";
    update.stage = deferCount >= 3
      ? "Anthropic preflight needs manual attention"
      : "Anthropic preflight needs attention; HOUSE carousel returned to queue before submission";
    update.progress = 0;
    update.model_spend_state = "not_started";
    update.structured_payload = null;
    update.claim_token = null;
    update.lease_expires_at = null;
    update.claimed_at = null;
    update.completed_at = deferCount >= 3 ? new Date().toISOString() : null;
    update.error = deferCount >= 3
      ? "Anthropic preflight failed three times before any paid request. Resolve the capability and retry this job manually."
      : null;
  }

  if (houseExecution && body.model_spend_state) {
    if (body.model_spend_state === "in_flight") {
      if (
        !["not_started", "in_flight"].includes(job.model_spend_state)
        || job.structured_payload != null
        || body.structured_payload !== undefined
      ) {
        return NextResponse.json({ error: "The model spend ledger cannot move back to in-flight" }, { status: 409 });
      }
      // Same-token replay is intentional: a successful in-flight write whose
      // HTTP response was lost must renew the lease, not strand the job before
      // the provider call.
      update.model_spend_state = "in_flight";
      update.structured_payload = null;
    } else {
      const checkpoint = validateStudioCarouselCheckpoint(body.structured_payload, receipt.receipt);
      if (!checkpoint.ok) {
        return NextResponse.json(
          { error: `The structured carousel checkpoint is invalid (${checkpoint.issue})` },
          { status: 400 },
        );
      }
      if (job.model_spend_state === "checkpointed") {
        // PostgreSQL jsonb canonicalizes object keys. A successful checkpoint
        // write whose HTTP acknowledgement was lost must therefore replay by
        // JSON structure, not by insertion-order-sensitive serialization.
        if (!sameStudioCarouselJsonValue(job.structured_payload, checkpoint.checkpoint)) {
          return NextResponse.json({ error: "The durable model checkpoint is immutable" }, { status: 409 });
        }
      } else if (job.model_spend_state !== "in_flight") {
        return NextResponse.json({ error: "A checkpoint requires an acknowledged in-flight model request" }, { status: 409 });
      }
      update.model_spend_state = "checkpointed";
      update.structured_payload = checkpoint.checkpoint;
    }
  } else if (body.structured_payload !== undefined) {
    return NextResponse.json({ error: "structured_payload requires model_spend_state=checkpointed" }, { status: 400 });
  }

  let mergedResult = job.result;
  if (body.result) {
    const merged = mergeCarouselJobResult(job.result, body.result, body.scheduled_at);
    if (!merged.ok) {
      return NextResponse.json(
        { error: "The carousel configuration receipt is immutable after queueing", code: merged.issue },
        { status: 409 },
      );
    }
    mergedResult = merged.result;
    update.result = merged.result;
  }

  if (body.status === "failed") {
    update.error = body.error?.trim().slice(0, 400) || "The local HOUSE renderer could not finish this carousel";
    update.completed_at = new Date().toISOString();
    if (houseExecution) {
      update.claim_token = null;
      update.lease_expires_at = null;
    }
  } else if (body.status === "ready") {
    const postId = body.post_id ?? job.post_id;
    if (!postId) {
      return NextResponse.json(
        { error: "ready requires post_id (the draft social post carrying the slides)" },
        { status: 400 },
      );
    }
    const { data: post, error: postError } = await supabase
      .from("social_posts")
      .select("id,status,post_type")
      .eq("id", postId)
      .maybeSingle();
    if (postError) return NextResponse.json({ error: postError.message }, { status: 500 });
    const { data: media, error: mediaError } = await supabase
      .from("social_post_media")
      .select("position,kind,url")
      .eq("post_id", postId)
      .order("position", { ascending: true });
    if (mediaError) return NextResponse.json({ error: mediaError.message }, { status: 500 });
    const evidence = validateStudioCarouselReadyEvidence({
      result: mergedResult ?? {},
      post,
      media: media ?? [],
    });
    if (!evidence.ok) {
      return NextResponse.json(
        { error: `The carousel is not ready for human review (${evidence.issue})`, code: evidence.issue },
        { status: 409 },
      );
    }
    update.post_id = postId;
    update.stage = body.stage?.slice(0, 300) || "Ready for review on the board";
    update.progress = body.progress === undefined ? 100 : update.progress;
    update.completed_at = new Date().toISOString();
    if (houseExecution) {
      update.claim_token = null;
      update.lease_expires_at = null;
    }
  } else if (houseExecution && body.capability_deferred === undefined) {
    // Every acknowledged progress/checkpoint report is also the heartbeat.
    update.lease_expires_at = new Date(
      Date.now() + STUDIO_CAROUSEL_LEASE_SECONDS * 1000,
    ).toISOString();
  }

  if (!Object.keys(update).length) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  let mutation = carouselJobs(supabase)
    .update(update)
    .eq("id", id)
    .eq("status", job.status);
  if (houseExecution) {
    mutation = mutation
      .eq("claim_token", body.claim_token)
      .gt("lease_expires_at", now.toISOString());
  }
  if (body.model_spend_state || body.capability_deferred) {
    mutation = mutation.eq("model_spend_state", job.model_spend_state);
  }
  const { data: changed, error } = await mutation.select("id,status").maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (changed) return NextResponse.json({ ok: true, state: "applied", status: changed.status });

  // A lost final response may race the human decision. Re-read, but never
  // mutate: the decision is authoritative and the machine retry is a no-op.
  const { data: current, error: currentError } = await carouselJobs(supabase)
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (currentError) return NextResponse.json({ error: currentError.message }, { status: 500 });
  const lateReplay = current ? terminalReplay(current, body) : null;
  if (lateReplay) return NextResponse.json({ ok: true, state: lateReplay, status: current.status });
  return NextResponse.json({ error: "The HOUSE execution lease changed before this report committed" }, { status: 409 });
}
