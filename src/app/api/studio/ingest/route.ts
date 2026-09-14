/**
 * Content Studio ingest door.
 *
 * POST — paste a URL: classifies the platform, upserts a studio_sources row,
 *        queues a studio_ingest_jobs row for the local runner. Idempotent per
 *        URL: re-ingesting an existing source re-queues a refresh.
 * GET  — list sources (filters: status, kind, platform, q).
 *
 * Bearer-authenticated with the machine keys (master/hermes), same boundary
 * as the carousel job queue. The /studio UI arrives in Phase 2 with session
 * auth; until then this is a machine door.
 */
import { NextRequest, NextResponse } from "next/server";
import { studioAuth } from "@/lib/studio/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { classifyUrl } from "@/lib/studio/platform";
import {
  ACTIVE_INGEST_JOB_STATUSES,
  presentIngestJob,
  type IngestJobSummaryRow,
} from "@/lib/studio/ingest-errors";
import { studioContextTextError } from "@/lib/studio/text-limits";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function unauthorized(request: NextRequest) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function POST(request: NextRequest) {
  const denied = await unauthorized(request);
  if (denied) return denied;

  let body: { url?: string; kind?: string; notes?: string; added_by?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.url) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }
  const notesError = studioContextTextError(body.notes, "Source notes");
  if (notesError) {
    return NextResponse.json(
      { error: notesError, code: "studio_text_too_large" },
      { status: 413 },
    );
  }
  const kind = body.kind ?? "inspiration";
  if (!["own", "competitor", "inspiration"].includes(kind)) {
    return NextResponse.json({ error: "kind must be own|competitor|inspiration" }, { status: 400 });
  }

  let classified;
  try {
    classified = classifyUrl(body.url);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const supabase = createAdminClient();

  // Instant card dressing (the Poppy feel): a YouTube thumbnail is derivable
  // from the video id alone, and oEmbed hands over the real title in ~200ms —
  // the card lands looking finished while the runner does the heavy lifting.
  let title: string | null = null;
  let author: string | null = null;
  let thumbnail: string | null = null;
  if (classified.platform === "youtube") {
    const vid = classified.url.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/)?.[1];
    if (vid) thumbnail = `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
    try {
      const oe = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(classified.url)}&format=json`,
        { signal: AbortSignal.timeout(2500) }
      );
      if (oe.ok) {
        const j = (await oe.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
        title = j.title ?? null;
        author = j.author_name ?? null;
        thumbnail = thumbnail ?? j.thumbnail_url ?? null;
      }
    } catch {
      // best-effort — the runner fills anything oEmbed didn't
    }
  } else if (classified.platform === "tiktok") {
    try {
      const oe = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(classified.url)}`, {
        signal: AbortSignal.timeout(2500),
        headers: { "User-Agent": BROWSER_UA },
      });
      if (oe.ok) {
        const j = (await oe.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
        title = j.title?.slice(0, 200) ?? null;
        author = j.author_name ?? null;
        thumbnail = j.thumbnail_url ?? null;
      }
    } catch {
      // best-effort — the runner's early metadata report covers it in seconds
    }
  } else if (classified.platform === "instagram") {
    // Instagram retired public oEmbed — best-effort og: tags; when IG blocks
    // data-center IPs, the runner's early metadata report dresses the card
    // within seconds anyway.
    try {
      const res = await fetch(classified.url, {
        signal: AbortSignal.timeout(2500),
        headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en" },
      });
      if (res.ok) {
        const html = await res.text();
        const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        const og = (prop: string) =>
          html.match(new RegExp(`property="og:${prop}"\\s+content="([^"]+)"`))?.[1] ??
          html.match(new RegExp(`content="([^"]+)"\\s+property="og:${prop}"`))?.[1] ??
          null;
        const image = og("image");
        const ogTitle = og("title");
        if (image) thumbnail = decode(image);
        if (ogTitle) title = decode(ogTitle).slice(0, 200);
      }
    } catch {
      // best-effort only
    }
  }

  const { data: source, error: sourceError } = await supabase
    .from("studio_sources")
    .upsert(
      {
        url: classified.url,
        platform: classified.platform,
        kind,
        notes: body.notes ?? null,
        added_by: body.added_by ?? "owner",
        refreshed_at: new Date().toISOString(),
        ...(title ? { title } : {}),
        ...(author ? { author } : {}),
        ...(thumbnail ? { thumbnail } : {}),
      },
      { onConflict: "url" }
    )
    .select("*")
    .single();
  if (sourceError) {
    return NextResponse.json({ error: sourceError.message }, { status: 500 });
  }

  // One live job per source: skip if a queued/claimed job already exists.
  // New installations use source.id as the canonical job id, so PostgreSQL's
  // existing primary key is also the concurrency lock. This closes the
  // check-then-insert race without adding a migration.
  const { data: existingJob, error: existingJobError } = await supabase
    .from("studio_ingest_jobs")
    .select("id,status,stage,progress")
    .eq("source_id", source.id)
    .in("status", ACTIVE_INGEST_JOB_STATUSES)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingJobError) {
    return NextResponse.json({ error: "The ingestion queue could not be checked. Please try again." }, { status: 503 });
  }

  if (existingJob) {
    return NextResponse.json({ source: { ...source, job: existingJob }, job: existingJob, queued: false });
  }

  // Do not regress a job that another request has already claimed. Pending is
  // only written while the source is still terminal (or already pending).
  const { error: pendingSourceError } = await supabase
    .from("studio_sources")
    .update({ status: "pending" })
    .eq("id", source.id)
    .in("status", ["pending", "ready", "failed"]);
  if (pendingSourceError) {
    return NextResponse.json({ error: "The source could not be prepared for ingestion. Please try again." }, { status: 503 });
  }

  const queuedJob = {
    status: "queued" as const,
    stage: "Added — fetching shortly",
    progress: 0,
    runner_id: null,
    error: null,
    attempts: 0,
    claimed_at: null,
    completed_at: null,
  };
  const { data: resetJob, error: resetJobError } = await supabase
    .from("studio_ingest_jobs")
    .update(queuedJob)
    .eq("id", source.id)
    .eq("source_id", source.id)
    .in("status", ["ready", "failed"])
    .select("*")
    .maybeSingle();
  if (resetJobError) {
    return NextResponse.json({ error: "The ingestion queue could not be reset. Please try again." }, { status: 503 });
  }

  let job = resetJob;
  if (!job) {
    const { data: insertedJob, error: insertJobError } = await supabase
      .from("studio_ingest_jobs")
      .insert({ id: source.id, source_id: source.id, ...queuedJob })
      .select("*")
      .maybeSingle();
    if (insertJobError && insertJobError.code !== "23505") {
      await supabase.from("studio_sources").update({ status: "failed" }).eq("id", source.id);
      return NextResponse.json({ error: insertJobError.message }, { status: 500 });
    }
    job = insertedJob;
  }

  // A concurrent request may have inserted or requeued the canonical row.
  // Read that one bounded row instead of creating a second live job.
  if (!job) {
    const { data: concurrentJob, error: concurrentJobError } = await supabase
      .from("studio_ingest_jobs")
      .select("*")
      .eq("id", source.id)
      .eq("source_id", source.id)
      .single();
    if (concurrentJobError) {
      return NextResponse.json({ error: "The ingestion queue could not be confirmed. Please try again." }, { status: 503 });
    }
    job = concurrentJob;
  }

  return NextResponse.json({ source: { ...source, status: "pending", job }, job, queued: true });
}

export async function GET(request: NextRequest) {
  const denied = await unauthorized(request);
  if (denied) return denied;

  const params = request.nextUrl.searchParams;
  const supabase = createAdminClient();

  let query = supabase
    .from("studio_sources")
    .select(
      "id,url,platform,kind,status,title,author,seconds,analysis,engagement,notes,thumbnail,added_at,refreshed_at,jobs:studio_ingest_jobs!studio_ingest_jobs_source_id_fkey(source_id,stage,progress,status,error,created_at,updated_at,claimed_at)",
      { count: "exact" }
    )
    .order("updated_at", { ascending: false, referencedTable: "jobs" })
    .limit(1, { referencedTable: "jobs" });

  const status = params.get("status");
  const kind = params.get("kind");
  const platform = params.get("platform");
  const q = params.get("q");
  const id = params.get("id");
  if (id) query = query.eq("id", id);
  if (status) query = query.eq("status", status as "pending" | "ingesting" | "ready" | "failed");
  if (kind) query = query.eq("kind", kind as "own" | "competitor" | "inspiration");
  if (platform) query = query.eq("platform", platform as "youtube" | "instagram" | "tiktok" | "facebook_ads" | "website" | "article" | "upload");
  if (q) query = query.or(`title.ilike.%${q}%,transcript.ilike.%${q}%`);

  const { data, count, error } = await query
    .order("added_at", { ascending: false })
    .limit(Math.min(Number(params.get("limit") || 25), 100));
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Attach the live job stage for anything still ingesting, so the canvas
  // can show real progress instead of a generic spinner.
  type SourceWithLatestJob = Record<string, unknown> & {
    id: string;
    status: string;
    jobs?: IngestJobSummaryRow[];
  };
  const sourceRows = (data ?? []) as unknown as SourceWithLatestJob[];
  const visibleJobIds = sourceRows
    .filter((source) => source.status === "pending" || source.status === "ingesting" || source.status === "failed")
    .map((source) => source.id);
  let runnerIsWorking = false;
  if (visibleJobIds.length) {
    const { data: activeJob, error: activeJobError } = await supabase
      .from("studio_ingest_jobs")
      .select("id")
      .in("status", ACTIVE_INGEST_JOB_STATUSES.slice(1))
      .limit(1)
      .maybeSingle();
    if (activeJobError) {
      return NextResponse.json({ error: "Source progress could not be read. Please try again." }, { status: 503 });
    }
    runnerIsWorking = Boolean(activeJob);
  }
  const sources = sourceRows.map((source) => {
    const { jobs: embeddedJobs, ...cleanSource } = source;
    const latestJob = embeddedJobs?.[0];
    return {
      ...cleanSource,
      ...(cleanSource.status !== "ready" && latestJob?.status === "failed"
        ? { status: "failed" }
        : {}),
      job: latestJob ? presentIngestJob(latestJob, runnerIsWorking) : null,
    };
  });

  return NextResponse.json({ sources, count });
}
