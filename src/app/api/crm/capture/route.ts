/**
 * POST /api/crm/capture — universal lead-capture endpoint.
 *
 * The front door for every lead source: site forms (proxied server-side),
 * GHL webhooks during migration, Zapier/Make, or agents. Upserts by email,
 * logs activities, and fires workflow triggers.
 *
 * Auth: x-capture-key header (crm_capture_key setting) or standard API auth.
 * Body: { email, name?, first_name?, last_name?, phone?, company?, source?,
 *         page?, form?, message?, tags?: string[], custom?: {}, workflow_id? }
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateCapture } from "@/lib/crm/capture-auth";
import { isValidEmail, upsertLead } from "@/lib/crm/leads";
import { enrollLead, ensureLeadOpportunity } from "@/lib/crm/engine";
import { logActivity } from "@/lib/crm/activity";
import type { Database, Json } from "@/types/database";

type AssessmentInsert = Database["public"]["Tables"]["assessment_completions"]["Insert"];

const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

function assessmentRow(raw: unknown, leadId: string): AssessmentInsert | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const assessmentKey = text(value.assessment_key, 80);
  const version = text(value.version, 80);
  const sessionId = text(value.session_id, 100);
  const rawScore = Number(value.raw_score);
  const normalizedScore = Number(value.normalized_score);
  const stage = text(value.maturity_stage, 40);

  if (!assessmentKey || !version || !sessionId || !stage || !Number.isInteger(rawScore) || !Number.isInteger(normalizedScore) || normalizedScore < 0 || normalizedScore > 100) {
    throw new Error("Invalid assessment completion");
  }

  const jsonObject = (item: unknown): Json =>
    item && typeof item === "object" && !Array.isArray(item)
      ? JSON.parse(JSON.stringify(item)) as Json
      : {};

  return {
    lead_id: leadId,
    assessment_key: assessmentKey,
    version,
    session_id: sessionId,
    raw_score: rawScore,
    normalized_score: normalizedScore,
    maturity_stage: stage,
    dimension_scores: jsonObject(value.dimension_scores),
    answers: jsonObject(value.answers),
    commercial_fit: text(value.commercial_fit, 40),
    qualification: jsonObject(value.qualification),
    marketing_consent: value.marketing_consent === true,
    page_url: text(value.page_url, 500),
    referrer: text(value.referrer, 500),
    completed_at: text(value.completed_at, 40) || new Date().toISOString(),
  };
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-capture-key",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(request: NextRequest) {
  const supabase = createAdminClient();

  const auth = await authenticateCapture(request, supabase);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS_HEADERS });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: CORS_HEADERS });
  }

  // Honeypot: bots fill every field — silently accept and drop
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return NextResponse.json({ ok: true }, { headers: CORS_HEADERS });
  }

  const email = typeof body.email === "string" ? body.email : "";
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: "Valid email is required" }, { status: 400, headers: CORS_HEADERS });
  }

  try {
    const input = {
      email,
      name: body.name as string | undefined,
      first_name: body.first_name as string | undefined,
      last_name: body.last_name as string | undefined,
      phone: body.phone as string | undefined,
      company: body.company as string | undefined,
      source: (body.source as string | undefined) || (body.form as string | undefined) || "capture",
      capture_page: (body.page as string | undefined) || (body.capture_page as string | undefined),
      form: body.form as string | undefined,
      message: body.message as string | undefined,
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
      custom: body.custom && typeof body.custom === "object" ? (body.custom as Record<string, unknown>) : {},
    };

    const { lead, created } = await upsertLead(supabase, input, { actor: `capture:${auth.via}` });

    const completion = assessmentRow(body.assessment, lead.id);
    if (completion) {
      const { error: assessmentError } = await supabase
        .from("assessment_completions")
        .upsert(completion, { onConflict: "assessment_key,session_id" });
      if (assessmentError) throw new Error(`assessment completion failed: ${assessmentError.message}`);

      await logActivity(supabase, {
        lead_id: lead.id,
        activity_type: "assessment_completed",
        title: `Assessment completed: ${completion.assessment_key}`,
        data: {
          score: completion.normalized_score,
          stage: completion.maturity_stage,
          commercial_fit: completion.commercial_fit,
          version: completion.version,
        },
        actor: `capture:${auth.via}`,
      });
    }

    // Auto-file into the sales pipeline: a fresh inbound lead opens a deal in
    // "New". Idempotent and forward-only. If upsertLead already enrolled them
    // in a sequence via a tag trigger, that enroll hook has already put them in
    // "Nurturing" — this call then no-ops. Never fail a capture over a pipeline write.
    try {
      await ensureLeadOpportunity(supabase, lead, { stage: "New", actor: `capture:${auth.via}` });
    } catch (e) {
      console.error("capture: ensureLeadOpportunity failed", e);
    }

    // Optional direct enrollment into a specific workflow
    if (typeof body.workflow_id === "string" && body.workflow_id) {
      const { data: wf } = await supabase.from("workflows").select("*").eq("id", body.workflow_id).single();
      if (wf && wf.status === "active") await enrollLead(supabase, wf, lead, "capture");
    }

    return NextResponse.json({ ok: true, lead_id: lead.id, created }, { headers: CORS_HEADERS });
  } catch (e) {
    const message = e instanceof Error ? e.message : "capture failed";
    return NextResponse.json({ error: message }, { status: 500, headers: CORS_HEADERS });
  }
}
