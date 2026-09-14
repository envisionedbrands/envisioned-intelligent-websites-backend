/**
 * Studio outputs — the bridge from desk work to the real pipelines.
 *
 * POST — create a real pipeline object from the studio:
 *   { type: "calendar_topic", payload: { title, target_keyword, pillar_topic?, notes? } }
 *     → content_calendar row (status planned; pillar is the brand's own,
 *       free-form — the calendar column is nullable)
 *   { type: "carousel_job", payload: { request, source_title? } }
 *     → carousel_jobs row for the configured renderer. The local HOUSE
 *       renderer is the portable default; a factory is explicit and optional.
 *
 * GET — resolve live status for output mirror nodes:
 *   ?refs=calendar_topic:<id>,carousel_job:<id>,social_post:<id>
 */
import { NextRequest, NextResponse } from "next/server";
import { studioAuth } from "@/lib/studio/auth";
import { createAdminClient } from "@/lib/supabase/server";
import {
  audienceCount,
  audienceIds,
  claimBroadcastOperation,
  ctaLinks,
  decideBroadcast,
  EmailExtractionError,
  extractEmail,
  finalizeBroadcastOperation,
  linkWarnings,
  releaseBroadcastOperation,
  sendTestEmail,
  type BroadcastConfig,
  type BroadcastOperationResult,
  type ExtractedEmail,
} from "@/lib/studio/broadcast";
import {
  broadcastPayloadHash,
  isUuid,
  normalizeBroadcastTags,
  type BroadcastAudienceMode,
} from "@/lib/studio/broadcast-operation";
import {
  issueEmailCandidate,
  verifyEmailCandidate,
} from "@/lib/studio/email-candidate";
import { emailMarkdownSafetyIssue } from "@/lib/studio/email-extraction";
import { loadCarouselConfig } from "@/lib/studio/carousel-config";
import { decideStudioCarousel } from "@/lib/studio/carousel-decision";
import { normalizeStudioCarouselSourceTitle } from "@/lib/studio/carousel-execution";
import { CAROUSEL_CONFIG_ISSUE_MESSAGES } from "@/lib/studio/carousel-template-registry";
import { HOUSE_LOOKS } from "@/lib/studio/house-looks";
import {
  studioAnthropicCapabilityMessage,
  studioRunnerFailureMessage,
  type StudioAnthropicCapabilityStatus,
} from "@/lib/studio/runner-health";
import { expectedStudioRunnerInstanceId } from "@/lib/studio/runner-server-identity";

/** Untyped door to the optional content-factory table. The factory is a
 *  separate upgrade, so carousel_jobs stays out of the shipped Database
 *  types; calls degrade at runtime with a plain error when it's absent. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const carouselJobs = (supabase: ReturnType<typeof createAdminClient>): any =>
  (supabase as unknown as { from(table: string): unknown }).from("carousel_jobs");

function emailExtractionFailure(error: unknown) {
  if (error instanceof EmailExtractionError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  throw error;
}

const broadcastResponse = (result: BroadcastOperationResult, warnings: string[] = []) =>
  NextResponse.json({
    output: { output_type: "broadcast", ref_id: result.workflow_id, title: result.subject },
    estimated: result.estimated,
    warnings,
  });

async function requirePortableCarouselRunner(
  requestUrl: string,
  supabase: ReturnType<typeof createAdminClient>,
): Promise<NextResponse | null> {
  let instanceId: string;
  try {
    instanceId = await expectedStudioRunnerInstanceId(requestUrl);
  } catch {
    return NextResponse.json({
      code: "runner_identity_unavailable",
      error: "Studio runner identity is not configured. Deploy Studio 1.6.7 and rerun runner setup before queueing a HOUSE carousel.",
    }, { status: 503 });
  }
  const { data: health, error } = await supabase
    .from("studio_runner_health")
    .select("status,failure_code,capabilities,last_seen_at")
    .eq("instance_id", instanceId)
    .order("last_seen_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    return NextResponse.json({
      code: "runner_health_unavailable",
      error: "Studio could not verify the local runner. Deploy Studio 1.6.7 and rerun runner setup before queueing a HOUSE carousel.",
    }, { status: 503 });
  }
  if (health?.status === "blocked") {
    return NextResponse.json({
      code: health.failure_code ?? "runner_blocked",
      error: studioRunnerFailureMessage(health.failure_code)
        ?? "Studio’s local runner needs setup before it can render a HOUSE carousel.",
    }, { status: 503 });
  }
  const fresh = health?.last_seen_at
    ? Date.now() - new Date(health.last_seen_at).getTime() <= 2 * 60_000
    : false;
  if (!health || health.status !== "ready" || !fresh) {
    return NextResponse.json({
      code: "runner_health_stale",
      error: "The local Studio runner is not currently checking in. Rerun Studio runner setup or bring its supervised service online before queueing a HOUSE carousel.",
    }, { status: 503 });
  }
  const capabilities = health.capabilities && typeof health.capabilities === "object"
    ? health.capabilities as Record<string, unknown>
    : null;
  if (capabilities?.carousel_ready !== true) {
    return NextResponse.json({
      code: "carousel_runtime_not_ready",
      error: "The local Studio runner has not verified Chrome and every signed carousel template, font, and image. Rerun Studio runner setup before queueing a HOUSE carousel.",
    }, { status: 503 });
  }
  const anthropicStatus = capabilities?.anthropic_status;
  if (anthropicStatus !== "valid") {
    const code = typeof anthropicStatus === "string"
      ? `anthropic_${anthropicStatus}`
      : "anthropic_unverified";
    const errorMessage = studioAnthropicCapabilityMessage(
      typeof anthropicStatus === "string"
        ? anthropicStatus as StudioAnthropicCapabilityStatus
        : null,
    );
    return NextResponse.json({ code, error: errorMessage }, { status: 503 });
  }
  return null;
}

export async function POST(request: NextRequest) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });

  const body = (await request.json().catch(() => null)) as
    | { type?: string; payload?: Record<string, unknown> }
    | null;
  if (!body?.type || !body.payload) return NextResponse.json({ error: "type and payload required" }, { status: 400 });
  const supabase = createAdminClient();
  const p = body.payload;

  if (body.type === "calendar_topic") {
    const title = String(p.title ?? "").trim();
    const keyword = String(p.target_keyword ?? "").trim();
    const pillar = String(p.pillar_topic ?? "").trim();
    if (!title || !keyword) return NextResponse.json({ error: "title and target_keyword required" }, { status: 400 });
    const { data, error } = await supabase
      .from("content_calendar")
      .insert({
        title,
        target_keyword: keyword,
        pillar_topic: pillar || null,
        intent_type: "informational",
        priority: "medium",
        status: "planned",
        notes: p.notes ? String(p.notes).slice(0, 4000) : null,
        created_by: "studio",
      })
      .select("id,title,status")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ output: { output_type: "calendar_topic", ref_id: data.id, title: data.title } });
  }

  if (body.type === "carousel_job") {
    const req = String(p.request ?? "").trim();
    if (!req) return NextResponse.json({ error: "request text required" }, { status: 400 });
    const sourceTitle = normalizeStudioCarouselSourceTitle(p.source_title);
    if (!sourceTitle.ok) {
      return NextResponse.json(
        {
          error: `source_title must be ${sourceTitle.maxCodePoints} characters or fewer`,
          code: sourceTitle.issue,
        },
        { status: 400 },
      );
    }
    // Portable routing: `content_manager` means the local HOUSE runner. The
    // persisted queue still calls that executor `employee` for schema
    // compatibility, but no Buzz hire or browser claims it. A factory is never
    // inferred; it must be selected in an exact receipt and installed.
    const config = await loadCarouselConfig(supabase);
    if (!config.ready || config.issue || !config.receipt) {
      const issue = config.issue ?? "config_receipt_invalid";
      return NextResponse.json(
        {
          error: CAROUSEL_CONFIG_ISSUE_MESSAGES[issue],
          code: issue,
          config,
        },
        { status: 409 },
      );
    }
    if (config.renderer === "content_manager") {
      const runnerIssue = await requirePortableCarouselRunner(request.url, supabase);
      if (runnerIssue) return runnerIssue;
    }
    const executor = config.renderer === "factory" ? "factory" : "employee";
    const houseLabel = config.house_look ? HOUSE_LOOKS[config.house_look].label : null;
    // carousel_jobs stays out of the shipped types (this queue arrived after
    // the starter floor) — the untyped door degrades with a plain error when
    // the Studio's own migration hasn't run yet.
    const { data, error } = await carouselJobs(supabase)
      .insert({
        requested_by: "studio",
        request: req.slice(0, 8000),
        source_title: sourceTitle.title,
        executor,
        // Immutable execution snapshot. The runner must render this exact
        // queue-time tuple, never whatever house look happens to be current
        // when it later claims the job.
        result: { config_receipt: config.receipt },
        stage: executor === "employee"
          ? `Queued for the local HOUSE renderer (${houseLabel}; ${config.template_id}@${config.template_version})`
          : "Queued for the explicitly configured bespoke factory",
      })
      .select("id,status,stage")
      .single();
    if (error) {
      if (/relation .*carousel_jobs.* does not exist|schema cache|column .*executor/i.test(error.message)) {
        return NextResponse.json(
          { error: "This Studio predates carousel delivery — ask your Architect to re-run the studio upgrade (the migration adds the carousel job queue)." },
          { status: 400 }
        );
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({
      output: { output_type: "carousel_job", ref_id: data.id, title: sourceTitle.title ?? "Carousel" },
      executor,
      config,
    });
  }

  // On-canvas carousel decision (§13): the human's yes or no on a board-born
  // house-look carousel. Session ONLY — the hire stages, the human approves;
  // a machine key at this door is refused by construction. Approving
  // schedules the attached draft post at the hire's proposed slot.
  if (body.type === "carousel_decision") {
    if (auth.mode !== "session") {
      return NextResponse.json({ error: "Approval belongs to the human, on the canvas — machine keys cannot decide" }, { status: 403 });
    }
    const jobId = String(p.job_id ?? "");
    const decision = String(p.decision ?? "");
    const decisionOperationId = String(p.decision_operation_id ?? "");
    if (!isUuid(jobId) || !isUuid(decisionOperationId) || !["approve", "reject"].includes(decision)) {
      return NextResponse.json(
        { error: "job_id, decision_operation_id, and decision (approve|reject) required" },
        { status: 400 },
      );
    }
    let scheduledAt: string | null = null;
    if (typeof p.scheduled_at === "string" && p.scheduled_at !== "now") {
      const parsed = Date.parse(p.scheduled_at);
      if (!Number.isFinite(parsed)) {
        return NextResponse.json({ error: "The carousel schedule is invalid" }, { status: 400 });
      }
      scheduledAt = new Date(parsed).toISOString();
    }
    const result = await decideStudioCarousel(supabase, {
      jobId,
      decision: decision as "approve" | "reject",
      decisionOperationId,
      scheduledAt,
    });
    if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  }

  // Test send: exact rendering to the OWNER's inbox only. No output node.
  // (Email to the list is the "broadcast" type below — the desk UI routes
  // all list sends through the CRM engine's own approval + send rails.)
  if (body.type === "email_test") {
    const message = String(p.message ?? "");
    const subject = p.subject ? String(p.subject) : undefined;
    const candidateSecret = process.env.API_SECRET_KEY;
    if (!candidateSecret) {
      return NextResponse.json(
        { error: "The Studio could not seal this tested email for exact queueing. Ask your Builder to configure API_SECRET_KEY." },
        { status: 503 },
      );
    }
    const cta = await ctaLinks(supabase);
    let email: ExtractedEmail | null | undefined;
    try {
      email = await extractEmail(message, subject, cta);
    } catch (error) {
      return emailExtractionFailure(error);
    }
    const candidate = await issueEmailCandidate(email, message, subject, candidateSecret);
    const result = await sendTestEmail(supabase, email);
    if ("error" in result) return NextResponse.json({ error: result.error }, { status: 502 });
    return NextResponse.json({ ok: true, to: result.to, subject: email.subject, warnings: linkWarnings(email.body_md), candidate });
  }

  // Broadcast: template + inert draft workflow (see lib/studio/broadcast.ts).
  if (body.type === "broadcast") {
    const operationId = String(p.operation_id ?? "");
    if (!isUuid(operationId)) {
      return NextResponse.json({ error: "This queue attempt has no valid operation ID. Close this dialog and reopen it." }, { status: 400 });
    }
    const audienceMode = String(p.audience_mode ?? "") as BroadcastAudienceMode;
    const tags = normalizeBroadcastTags(p.tags);
    if (audienceMode !== "all" && audienceMode !== "tags") {
      return NextResponse.json({ error: "Choose either all subscribers or a tag-based audience." }, { status: 400 });
    }
    if (audienceMode === "tags" && tags.length === 0) {
      return NextResponse.json({ error: "Choose at least one tag before queueing this broadcast." }, { status: 400 });
    }
    if (audienceMode === "all" && tags.length > 0) {
      return NextResponse.json({ error: "An all-subscriber broadcast cannot also carry tag filters." }, { status: 400 });
    }
    const message = String(p.message ?? "");
    const subject = p.subject ? String(p.subject) : undefined;
    if (!message.trim()) return NextResponse.json({ error: "The email reply is empty." }, { status: 400 });
    let scheduledAt: string | null = null;
    if (p.scheduled_at) {
      const parsedSchedule = Date.parse(String(p.scheduled_at));
      if (!Number.isFinite(parsedSchedule)) return NextResponse.json({ error: "The scheduled time is invalid." }, { status: 400 });
      scheduledAt = new Date(parsedSchedule).toISOString();
    }
    const campaignIntent = String(p.campaign_intent ?? "").trim() || "Broadcast from the Content Studio email desk";
    // Reject an empty audience before spending time/tokens extracting copy.
    if (!(await audienceCount(supabase, audienceMode, tags))) {
      return NextResponse.json({ error: "No subscribed leads match that audience" }, { status: 400 });
    }
    let email: ExtractedEmail | null | undefined;
    let candidateSignature = "";
    if (p.candidate !== undefined) {
      const candidateSecret = process.env.API_SECRET_KEY;
      if (!candidateSecret) {
        return NextResponse.json(
          { error: "The Studio cannot verify this tested email. Ask your Builder to configure API_SECRET_KEY." },
          { status: 503 },
        );
      }
      email = await verifyEmailCandidate(p.candidate, message, subject, candidateSecret);
      candidateSignature = typeof p.candidate === "object"
        && p.candidate !== null
        && typeof (p.candidate as { signature?: unknown }).signature === "string"
        ? (p.candidate as { signature: string }).signature
        : "";
      // A valid signature proves provenance, not renderer safety. Reapply the
      // current outbound boundary so old receipts and other secret holders
      // cannot queue content that today's extractor would reject.
      if (!email || emailMarkdownSafetyIssue(email.body_md) || !candidateSignature) {
        return NextResponse.json(
          { error: "The tested email no longer matches this draft. Send a new test or close and reopen the dialog." },
          { status: 409 },
        );
      }
    }
    const payloadHash = await broadcastPayloadHash({
      message,
      subject,
      audienceMode,
      tags,
      scheduledAt,
      campaignIntent,
      candidateSignature,
    });
    const claimToken = crypto.randomUUID();
    let claim;
    try {
      claim = await claimBroadcastOperation(supabase, operationId, payloadHash, claimToken);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Could not claim this broadcast operation" }, { status: 500 });
    }
    if (claim.state === "ready") return broadcastResponse(claim);
    if (claim.state === "conflict") {
      return NextResponse.json({ error: "This queue operation was already used for different broadcast settings. Close and reopen the dialog." }, { status: 409 });
    }
    if (claim.state === "busy") {
      return NextResponse.json({ error: "This exact broadcast is already being prepared. Wait a moment, then retry." }, { status: 409 });
    }

    try {
      if (!email) {
        const cta = await ctaLinks(supabase);
        email = await extractEmail(message, subject, cta);
      }
      const result = await finalizeBroadcastOperation(supabase, {
        operationId,
        payloadHash,
        claimToken,
        email,
        audienceMode,
        tags,
        campaignIntent,
        scheduledAt,
      });
      return broadcastResponse(result, linkWarnings(email.body_md));
    } catch (error) {
      await releaseBroadcastOperation(supabase, operationId, payloadHash, claimToken);
      if (error instanceof EmailExtractionError) return emailExtractionFailure(error);
      return NextResponse.json({ error: error instanceof Error ? error.message : "Could not create this broadcast draft" }, { status: 500 });
    }
  }

  // Approve/reject a broadcast. The database decision RPC snapshots, tags,
  // enrolls, and activates atomically; retries return its canonical receipt.
  if (body.type === "broadcast_decision") {
    if (auth.mode !== "session") {
      return NextResponse.json({ error: "Broadcast approval belongs to the human on the canvas — machine keys cannot decide" }, { status: 403 });
    }
    const decision = String(p.decision ?? "");
    const workflowId = String(p.workflow_id ?? "");
    const decisionOperationId = String(p.decision_operation_id ?? "");
    if (!isUuid(workflowId) || !isUuid(decisionOperationId) || !["approve", "reject"].includes(decision)) {
      return NextResponse.json(
        { error: "workflow_id, decision_operation_id, and decision (approve|reject) required" },
        { status: 400 },
      );
    }
    const result = await decideBroadcast(
      supabase,
      workflowId,
      decision as "approve" | "reject",
      decisionOperationId,
    );
    if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status ?? 500 });
    return NextResponse.json(result);
  }

  return NextResponse.json({ error: `Unknown output type: ${body.type}` }, { status: 400 });
}

export async function GET(request: NextRequest) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });

  const refs = (request.nextUrl.searchParams.get("refs") ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .slice(0, 50)
    .map((r) => {
      const i = r.indexOf(":");
      return { type: r.slice(0, i), id: r.slice(i + 1) };
    })
    .filter((r) => r.type && r.id);
  if (!refs.length) return NextResponse.json({ statuses: {} });

  const supabase = createAdminClient();
  const statuses: Record<string, unknown> = {};

  const byType = (t: string) => refs.filter((r) => r.type === t).map((r) => r.id);

  const calIds = byType("calendar_topic");
  if (calIds.length) {
    const { data } = await supabase.from("content_calendar").select("id,title,status,pillar_topic").in("id", calIds);
    for (const row of data ?? []) statuses[`calendar_topic:${row.id}`] = { status: row.status, title: row.title, detail: row.pillar_topic };
  }

  const carIds = byType("carousel_job");
  if (carIds.length) {
    const { data } = await carouselJobs(supabase)
      .select("id,status,stage,progress,error,post_id,executor,result")
      .in("id", carIds);
    // Slides live wherever the executor put them: the job's own result
    // (partial reports feed the live filmstrip) OR the draft post's media.
    // The node renders whichever exists — the filmstrip is renderer-agnostic.
    const postIds = (data ?? []).map((r: { post_id: string | null }) => r.post_id).filter(Boolean) as string[];
    const mediaByPost: Record<string, string[]> = {};
    if (postIds.length) {
      const { data: media } = await supabase
        .from("social_post_media")
        .select("post_id,url,kind,position")
        .in("post_id", postIds)
        .order("position");
      for (const m of media ?? []) {
        if (m.kind !== "image" || !m.url) continue;
        (mediaByPost[m.post_id] ??= []).push(m.url);
      }
    }
    for (const row of data ?? []) {
      const result = row.result as { contact_sheet_url?: string; slide_urls?: string[]; slide_total?: number } | null;
      const postSlides = row.post_id ? mediaByPost[row.post_id] : undefined;
      const slideUrls = result?.slide_urls ?? postSlides ?? null;
      statuses[`carousel_job:${row.id}`] = {
        status: row.status === "ready" ? "ready for review" : row.status,
        detail: row.error ?? row.stage,
        progress: row.progress,
        post_id: row.post_id,
        executor: row.executor,
        contact_sheet_url: result?.contact_sheet_url ?? null,
        slide_urls: slideUrls,
        slide_total: result?.slide_total ?? (slideUrls?.length ?? null),
      };
    }
  }

  const detail = request.nextUrl.searchParams.get("detail") === "1";
  const broadcastIds = byType("broadcast");
  for (const wid of broadcastIds) {
    const { data: wf, error: workflowError } = await supabase
      .from("workflows")
      .select("status,trigger_config,steps,enrolled_count,completed_count")
      .eq("id", wid)
      .maybeSingle();
    if (workflowError) {
      return NextResponse.json({ error: `Could not load broadcast status: ${workflowError.message}` }, { status: 500 });
    }
    if (!wf) continue;
    const cfg = wf.trigger_config as unknown as BroadcastConfig;
    const audience = cfg.all ? `all subscribed (~${cfg.estimated})` : `${cfg.tags.join(", ")} (~${cfg.estimated})`;
    const scheduled = cfg.scheduled_at ? ` · scheduled ${String(cfg.scheduled_at).slice(0, 16).replace("T", " ")}` : "";
    const base: Record<string, unknown> = {};
    if (detail) {
      const steps = wf.steps as { type: string; config?: { template_id?: string } }[];
      const templateId = steps.find((s) => s.type === "send_email")?.config?.template_id;
      if (templateId) {
        const { data: t } = await supabase
          .from("email_templates")
          .select("subject,preheader,body_md")
          .eq("id", templateId)
          .maybeSingle();
        if (t) base.preview = t;
      }
      base.audience = audience;
      base.scheduled_at = cfg.scheduled_at;
      base.estimated = cfg.estimated;
    }
    if (wf.status === "draft") {
      statuses[`broadcast:${wid}`] = { status: "awaiting approval", detail: audience + scheduled, ...base };
    } else if (wf.status === "archived") {
      statuses[`broadcast:${wid}`] = { status: "rejected", detail: audience, ...base };
    } else {
      const expected = Number.isInteger(cfg.estimated) && cfg.estimated > 0 ? cfg.estimated : 0;
      const recorded = Number.isInteger(wf.enrolled_count) && wf.enrolled_count > 0 ? wf.enrolled_count : 0;
      // The pre-hardening browser activated first and enrolled in batches. If
      // it stopped mid-flight, reopen the human decision instead of pretending
      // that the partial audience is already sending. The RPC converges only
      // missing rows and writes the canonical decision receipt.
      if (expected > 0 && recorded < expected) {
        statuses[`broadcast:${wid}`] = {
          status: "awaiting approval",
          detail: `Approval recovery required — ${recorded}/${expected} enrolled${scheduled}`,
          recovery: true,
          ...base,
        };
        continue;
      }
      const [{ count: active }, { count: completed }] = await Promise.all([
        supabase.from("workflow_enrollments").select("id", { count: "exact", head: true }).eq("workflow_id", wid).eq("status", "active"),
        supabase.from("workflow_enrollments").select("id", { count: "exact", head: true }).eq("workflow_id", wid).eq("status", "completed"),
      ]);
      const total = (active ?? 0) + (completed ?? 0);
      statuses[`broadcast:${wid}`] = {
        status: total === 0 ? "enrolling" : (active ?? 0) > 0 ? "sending" : "sent",
        detail: `${completed ?? 0}/${total || cfg.estimated} delivered${scheduled}`,
        progress: total ? Math.round(((completed ?? 0) / total) * 100) : 0,
        ...base,
      };
    }
  }

  if (request.nextUrl.searchParams.get("audience") === "1" && broadcastIds.length === 1) {
    if (auth.mode !== "session") {
      return NextResponse.json({ error: "Broadcast audience details are only available to the signed-in human" }, { status: 403 });
    }
    const { data: wf } = await supabase.from("workflows").select("trigger_config").eq("id", broadcastIds[0]).maybeSingle();
    if (wf) {
      const cfg = wf.trigger_config as unknown as BroadcastConfig;
      return NextResponse.json({
        statuses,
        lead_ids: await audienceIds(supabase, cfg.audience_mode ?? (cfg.all ? "all" : "tags"), cfg.tags),
        campaign_tag: cfg.campaign_tag,
      });
    }
  }

  const postIds = byType("social_post");
  if (postIds.length) {
    const { data } = await supabase.from("social_posts").select("id,caption,status").in("id", postIds);
    for (const row of data ?? [])
      statuses[`social_post:${row.id}`] = { status: row.status, title: (row.caption ?? "").slice(0, 60) };
  }

  return NextResponse.json({ statuses });
}
