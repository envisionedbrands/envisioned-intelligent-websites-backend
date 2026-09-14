/**
 * POST /api/studio/jobs/claim — the studio runner claims one queued ingest
 * job. Same optimistic-lock pattern as /api/agent/carousel-jobs/claim.
 * Body: { runner_id?: string }
 */
import { NextRequest, NextResponse } from "next/server";
import { studioMachineAuth } from "@/lib/studio/auth";
import { createAdminClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const auth = studioMachineAuth(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let runnerId = "studio-runner";
  try {
    const body = await request.json();
    if (body?.runner_id) runnerId = String(body.runner_id);
  } catch {
    // empty body is fine
  }

  const supabase = createAdminClient();
  const leaseId = `${runnerId}:${crypto.randomUUID()}`;

  // A laptop can sleep, reboot, or lose its connection after claiming a job.
  // Reclaim expired leases instead of leaving the source orange forever.
  // Three failed leases become an explicit failure the member can Retry.
  const activeStatuses = ["claimed", "fetching", "transcribing", "analyzing"] as const;
  const leaseCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data: stale, error: staleError } = await supabase
    .from("studio_ingest_jobs")
    .select("id,source_id,status,attempts,runner_id,updated_at")
    .in("status", activeStatuses)
    .lt("updated_at", leaseCutoff)
    .limit(25);
  if (staleError) return NextResponse.json({ error: staleError.message }, { status: 500 });
  for (const abandoned of stale ?? []) {
    if ((abandoned.attempts ?? 0) >= 3) {
      const { data: failedLease, error: failJobError } = await supabase
        .from("studio_ingest_jobs")
        .update({
          status: "failed",
          stage: "Runner stopped before this source could finish",
          error: "STUDIO:runner_interrupted:job lease expired three times",
          completed_at: new Date().toISOString(),
        })
        .eq("id", abandoned.id)
        .eq("status", abandoned.status)
        .eq("attempts", abandoned.attempts)
        .eq("updated_at", abandoned.updated_at)
        .select("source_id")
        .maybeSingle();
      if (failJobError) return NextResponse.json({ error: failJobError.message }, { status: 500 });
      if (!failedLease) continue;
      const { error: failSourceError } = await supabase
        .from("studio_sources")
        .update({ status: "failed" })
        .eq("id", failedLease.source_id)
        .in("status", ["ingesting", "failed"]);
      if (failSourceError) return NextResponse.json({ error: failSourceError.message }, { status: 500 });
      continue;
    }
    const { data: requeued, error: requeueError } = await supabase
      .from("studio_ingest_jobs")
      .update({
        status: "queued",
        stage: "Runner connection was interrupted — retrying",
        progress: 0,
        runner_id: null,
        claimed_at: null,
      })
      .eq("id", abandoned.id)
      .eq("status", abandoned.status)
      .eq("attempts", abandoned.attempts)
      .eq("updated_at", abandoned.updated_at)
      .select("source_id")
      .maybeSingle();
    if (requeueError) return NextResponse.json({ error: requeueError.message }, { status: 500 });
    if (!requeued) continue;
    // Leave the source in ingesting while queued. A second claim request can
    // take this lease immediately; writing pending here would race and
    // overwrite that newer runner's ingesting state.
  }

  const { data: queued, error } = await supabase
    .from("studio_ingest_jobs")
    .select("*, source:studio_sources(*)")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!queued) return NextResponse.json({ job: null });

  // If a previous terminal report wrote the source but lost its final job
  // update, finish that transition here instead of reprocessing or leaving a
  // green source behind an orange queue row.
  const queuedSource = Array.isArray(queued.source) ? queued.source[0] : queued.source;
  if (queuedSource?.status === "ready" && queuedSource.transcript) {
    const { error: repairError } = await supabase
      .from("studio_ingest_jobs")
      .update({ status: "ready", stage: "Source ready", progress: 100, completed_at: new Date().toISOString() })
      .eq("id", queued.id)
      .eq("status", "queued")
      .eq("attempts", queued.attempts)
      .eq("updated_at", queued.updated_at);
    if (repairError) return NextResponse.json({ error: repairError.message }, { status: 500 });
    return NextResponse.json({ job: null });
  }
  if (queuedSource?.status === "ready" && !queuedSource.transcript) {
    const { data: resetSource, error: resetSourceError } = await supabase
      .from("studio_sources")
      .update({ status: "pending" })
      .eq("id", queued.source_id)
      .eq("status", "ready")
      .select("id")
      .maybeSingle();
    if (resetSourceError) return NextResponse.json({ error: resetSourceError.message }, { status: 500 });
    if (!resetSource) return NextResponse.json({ job: null });
  }
  if (queuedSource?.status === "failed") {
    const { error: repairError } = await supabase
      .from("studio_ingest_jobs")
      .update({
        status: "failed",
        stage: queued.stage || "Ingestion failed",
        error: queued.error || "STUDIO:ingestion_failed:terminal source write was interrupted",
        completed_at: new Date().toISOString(),
      })
      .eq("id", queued.id)
      .eq("status", "queued")
      .eq("attempts", queued.attempts)
      .eq("updated_at", queued.updated_at);
    if (repairError) return NextResponse.json({ error: repairError.message }, { status: 500 });
    return NextResponse.json({ job: null });
  }

  const { data: claimed, error: claimError } = await supabase
    .from("studio_ingest_jobs")
    .update({
      status: "claimed",
      stage: "Claimed by the studio runner",
      progress: 5,
      runner_id: leaseId,
      attempts: (queued.attempts ?? 0) + 1,
      claimed_at: new Date().toISOString(),
      error: null,
    })
    .eq("id", queued.id)
    .eq("status", "queued")
    .eq("attempts", queued.attempts)
    .eq("updated_at", queued.updated_at)
    .select("*")
    .maybeSingle();
  if (claimError) return NextResponse.json({ error: claimError.message }, { status: 500 });
  if (!claimed) return NextResponse.json({ job: null });

  const { data: claimedSource, error: sourceClaimError } = await supabase
    .from("studio_sources")
    .update({ status: "ingesting" })
    .eq("id", claimed.source_id)
    .in("status", ["pending", "ingesting"])
    .select("id")
    .maybeSingle();
  if (sourceClaimError || !claimedSource) {
    await supabase
      .from("studio_ingest_jobs")
      .update({ status: "queued", stage: "Queued for the studio runner", progress: 0, runner_id: null, claimed_at: null })
      .eq("id", claimed.id)
      .eq("status", "claimed")
      .eq("runner_id", leaseId)
      .eq("attempts", claimed.attempts);
    return NextResponse.json(
      { error: sourceClaimError?.message ?? "The source changed while this job was being claimed. Please retry." },
      { status: sourceClaimError ? 500 : 409 }
    );
  }

  return NextResponse.json({ job: { ...claimed, source: queued.source } });
}
