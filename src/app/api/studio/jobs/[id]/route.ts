/**
 * PATCH /api/studio/jobs/:id — the studio runner reports progress or results.
 *
 * Progress:  { status?, stage?, progress? }
 * Complete:  { status: "ready", result: { title?, author?, seconds?,
 *              published_at?, transcript, analysis?, engagement? } }
 *            → job closes and the result is written onto the source row.
 * Failure:   { status: "failed", error }
 */
import { NextRequest, NextResponse } from "next/server";
import { studioMachineAuth } from "@/lib/studio/auth";
import { createAdminClient } from "@/lib/supabase/server";
import type { Json } from "@/types/database";

const PROGRESS_STATUSES = ["claimed", "fetching", "transcribing", "analyzing"] as const;

type JobUpdate = {
  runner_id?: string;
  attempt?: number;
  status?: string;
  stage?: string;
  progress?: number;
  error?: string;
  result?: {
    title?: string;
    author?: string;
    seconds?: number;
    published_at?: string;
    transcript?: string;
    analysis?: Json;
    engagement?: Json;
    thumbnail?: string;
  };
};

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = studioMachineAuth(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as JobUpdate | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const supabase = createAdminClient();
  const { data: job, error: jobError } = await supabase
    .from("studio_ingest_jobs")
    .select("id,source_id,status,runner_id,attempts")
    .eq("id", id)
    .maybeSingle();
  if (jobError) return NextResponse.json({ error: jobError.message }, { status: 500 });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (!job.runner_id || body.runner_id !== job.runner_id || body.attempt !== job.attempts) {
    return NextResponse.json(
      { error: "This runner lease has expired; a newer attempt owns the job." },
      { status: 409 }
    );
  }
  if (
    ["ready", "failed"].includes(job.status) &&
    body.status !== "queued" &&
    body.status !== job.status
  ) {
    return NextResponse.json({ error: `Job already ${job.status}` }, { status: 409 });
  }

  const leaseExpired = () =>
    NextResponse.json(
      { error: "This runner lease has expired; a newer attempt owns the job." },
      { status: 409 }
    );

  // Failure path. Win the terminal compare-and-swap before touching the
  // source row. A reclaimed runner can never mark a newer attempt failed.
  if (body.status === "failed") {
    if (job.status !== "failed") {
      if (!PROGRESS_STATUSES.includes(job.status as (typeof PROGRESS_STATUSES)[number])) return leaseExpired();
      const { data: heartbeat, error: heartbeatError } = await supabase
        .from("studio_ingest_jobs")
        .update({
          stage: body.stage ?? "Ingestion failed",
          error: body.error ?? "Unknown runner error",
        })
        .eq("id", id)
        .eq("runner_id", job.runner_id)
        .eq("attempts", job.attempts)
        .eq("status", job.status)
        .select("id")
        .maybeSingle();
      if (heartbeatError) return NextResponse.json({ error: heartbeatError.message }, { status: 500 });
      if (!heartbeat) return leaseExpired();
    }
    const { data: failedSource, error: failSourceError } = await supabase
      .from("studio_sources")
      .update({ status: "failed" })
      .eq("id", job.source_id)
      .in("status", job.status === "failed" ? ["ingesting", "failed"] : ["pending", "ingesting", "ready", "failed"])
      .select("id")
      .maybeSingle();
    if (failSourceError) return NextResponse.json({ error: failSourceError.message }, { status: 500 });
    if (!failedSource) return leaseExpired();
    if (job.status !== "failed") {
      const { data: failedJob, error: failJobError } = await supabase
        .from("studio_ingest_jobs")
        .update({
          status: "failed",
          stage: body.stage ?? "Ingestion failed",
          error: body.error ?? "Unknown runner error",
          completed_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("runner_id", job.runner_id)
        .eq("attempts", job.attempts)
        .eq("status", job.status)
        .select("id")
        .maybeSingle();
      if (failJobError) return NextResponse.json({ error: failJobError.message }, { status: 500 });
      if (!failedJob) return leaseExpired();
    }
    return NextResponse.json({ ok: true });
  }

  // Completion path. The terminal job transition owns the lease; the source
  // write is conditional so a user-triggered requeue cannot be overwritten.
  if (body.status === "ready") {
    if (!body.result?.transcript) {
      return NextResponse.json({ error: "result.transcript required to complete" }, { status: 400 });
    }
    if (job.status !== "ready") {
      if (!PROGRESS_STATUSES.includes(job.status as (typeof PROGRESS_STATUSES)[number])) return leaseExpired();
      const { data: heartbeat, error: heartbeatError } = await supabase
        .from("studio_ingest_jobs")
        .update({
          stage: "Finishing source",
          progress: 99,
        })
        .eq("id", id)
        .eq("runner_id", job.runner_id)
        .eq("attempts", job.attempts)
        .eq("status", job.status)
        .select("id")
        .maybeSingle();
      if (heartbeatError) return NextResponse.json({ error: heartbeatError.message }, { status: 500 });
      if (!heartbeat) return leaseExpired();
    }

    const r = body.result;
    // title/author/thumbnail may already be set by the ingest door's instant
    // oEmbed dressing — a runner result missing one must not null it out.
    const { data: readySource, error: sourceError } = await supabase
      .from("studio_sources")
      .update({
        status: "ready",
        seconds: r.seconds ?? null,
        published_at: r.published_at ?? null,
        transcript: r.transcript,
        analysis: r.analysis ?? null,
        engagement: r.engagement ?? null,
        refreshed_at: new Date().toISOString(),
        ...(r.title ? { title: r.title } : {}),
        ...(r.author ? { author: r.author } : {}),
        ...(r.thumbnail ? { thumbnail: r.thumbnail } : {}),
      })
      .eq("id", job.source_id)
      .in("status", job.status === "ready" ? ["ingesting", "ready"] : ["pending", "ingesting", "ready", "failed"])
      .select("id")
      .maybeSingle();
    if (sourceError) return NextResponse.json({ error: sourceError.message }, { status: 500 });
    if (!readySource) return leaseExpired();
    if (job.status !== "ready") {
      const { data: readyJob, error: readyJobError } = await supabase
        .from("studio_ingest_jobs")
        .update({
          status: "ready",
          stage: body.stage ?? "Source ready",
          progress: 100,
          completed_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("runner_id", job.runner_id)
        .eq("attempts", job.attempts)
        .eq("status", job.status)
        .select("id")
        .maybeSingle();
      if (readyJobError) return NextResponse.json({ error: readyJobError.message }, { status: 500 });
      if (!readyJob) return leaseExpired();
    }
    return NextResponse.json({ ok: true });
  }

  // Progress path. A partial result rides along when the runner has the
  // card's dressing (title/author/thumbnail) before the transcript is done —
  // write it to the source immediately so the canvas dresses in seconds.
  const update: Record<string, unknown> = {};
  if (body.status) {
    if (!PROGRESS_STATUSES.includes(body.status as (typeof PROGRESS_STATUSES)[number])) {
      return NextResponse.json({ error: `Invalid status: ${body.status}` }, { status: 400 });
    }
    update.status = body.status;
  }
  if (body.stage) update.stage = body.stage;
  if (typeof body.progress === "number") {
    update.progress = Math.max(0, Math.min(100, Math.round(body.progress)));
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }
  if (!PROGRESS_STATUSES.includes(job.status as (typeof PROGRESS_STATUSES)[number])) return leaseExpired();
  const { data: updatedJob, error: updateError } = await supabase
    .from("studio_ingest_jobs")
    .update(update)
    .eq("id", id)
    .eq("runner_id", job.runner_id)
    .eq("attempts", job.attempts)
    .eq("status", job.status)
    .select("id")
    .maybeSingle();
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });
  if (!updatedJob) return leaseExpired();

  // Only dress the source after the guarded heartbeat wins. If a lease was
  // reclaimed, the stale runner exits before writing any source fields.
  if (body.result && (body.result.title || body.result.author || body.result.thumbnail)) {
    const { error: dressingError } = await supabase
      .from("studio_sources")
      .update({
        ...(body.result.title ? { title: body.result.title } : {}),
        ...(body.result.author ? { author: body.result.author } : {}),
        ...(body.result.thumbnail ? { thumbnail: body.result.thumbnail } : {}),
      })
      .eq("id", job.source_id)
      .eq("status", "ingesting");
    if (dressingError) return NextResponse.json({ error: dressingError.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
