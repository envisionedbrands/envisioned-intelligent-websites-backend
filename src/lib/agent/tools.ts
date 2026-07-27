/**
 * The Operator's tool belt — thin wrappers over the existing CRM lib,
 * funnel analytics, and content pipeline. Outward-facing work (emails,
 * publishes) NEVER executes here; those tools only write proposals into
 * agent_actions for the owner to approve.
 */
import { createHmac } from "crypto";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { AdminClient } from "@/lib/crm/types";
import { logActivity } from "@/lib/crm/activity";
import { getFunnelStats } from "@/lib/crm/funnel";
import { getCrmSettings } from "@/lib/crm/settings";
import { fireTrigger } from "@/lib/crm/engine";
import { routeOfferForLead } from "@/lib/crm/offers";
import { callClaudeStructured, loadBrandContext, REWRITE_SCHEMA, SEQUENCE_CRAFT_RULES } from "@/lib/crm/ai";
import { getContentAttribution } from "@/lib/crm/attribution";
import { draftPersonalizedBatch } from "./batch";
import type { Json, Tables } from "@/types/database";

const STALLED_AFTER_DAYS = 7;

/** Friendly error when the A/B columns aren't there yet (migration 018). */
function isMissingAbColumns(message: string): boolean {
  return /subject_b|variant/.test(message) && /column|does not exist|schema cache/i.test(message);
}

export interface ToolContext {
  supabase: AdminClient;
  origin: string; // this deployment's own origin, for signed self-calls
  runId: string;
}

export interface ToolOutcome {
  data: unknown; // returned to the model as JSON
  summary: string; // one line for the live activity feed
}

type Executor = (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutcome>;

// ── signed self-call (reuses the machine-auth path; pathname WITHOUT query) ──

async function callInternalApi(origin: string, path: string, body: unknown): Promise<unknown> {
  const bodyText = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secret = process.env.API_REQUEST_SIGNING_SECRET || process.env.API_SECRET_KEY || "";
  const signature = createHmac("sha256", secret)
    .update(`POST:${path}:${timestamp}:${bodyText}`)
    .digest("hex");

  const request = new Request(`${origin}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.API_SECRET_KEY || "",
      "x-timestamp": timestamp,
      "x-signature": signature,
    },
    body: bodyText,
  });

  // On Workers a fetch to our own public URL fails — route through the
  // self-reference service binding (same pattern as write-article's
  // frontendFetch). Local dev has no Cloudflare context; plain fetch works.
  let res: Response;
  try {
    const ctx = getCloudflareContext();
    const binding = ctx.env.WORKER_SELF_REFERENCE;
    res = binding ? await binding.fetch(request) : await fetch(request);
  } catch {
    res = await fetch(request);
  }
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (payload as { error?: string }).error || `${path} responded ${res.status}`;
    throw new Error(msg);
  }
  return payload;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

async function findLead(supabase: AdminClient, input: Record<string, unknown>) {
  const email = str(input.email).toLowerCase();
  const id = str(input.lead_id);
  let query = supabase.from("leads").select("*");
  if (id) query = query.eq("id", id);
  else if (email) query = query.eq("email", email);
  else throw new Error("Provide lead_id or email");
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`No lead found for ${id || email}`);
  return data;
}

// ── tool definitions (Anthropic schema) + executors ──────────────────────────

/** Provider-neutral tool definition (plain JSON Schema body). */
export interface ToolDefinition {
  name: string;
  description?: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "list_leads",
    description:
      "List leads from the CRM, newest first. Use since_days to see recent arrivals (e.g. since_days=1 for 'new since yesterday'). For 'hottest leads', use order_by='score' (optionally with min_score=1).",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["new", "engaged", "qualified", "converted", "lost"],
          description: "Filter by lead status",
        },
        since_days: { type: "number", description: "Only leads created in the last N days" },
        min_score: { type: "number", description: "Only leads with score >= this" },
        order_by: {
          type: "string",
          enum: ["newest", "score"],
          description: "'newest' (default) or 'score' for hottest-first",
        },
        limit: { type: "number", description: "Max rows (default 25, max 100)" },
      },
    },
  },
  {
    name: "get_lead",
    description:
      "Fetch one lead's full record plus their recent activity timeline (emails, form fills, notes, tags) and email engagement (opens/clicks). Look up by email or lead_id.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Lead email address" },
        lead_id: { type: "string", description: "Lead UUID" },
      },
    },
  },
  {
    name: "tag_lead",
    description: "Add a tag to a lead (e.g. 'hot', 'follow-up'). Additive; never removes tags.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string" },
        lead_id: { type: "string" },
        tag: { type: "string", description: "The tag to add" },
      },
      required: ["tag"],
    },
  },
  {
    name: "add_note",
    description: "Add a note to a lead's timeline (visible in the CRM).",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string" },
        lead_id: { type: "string" },
        note: { type: "string", description: "The note text" },
      },
      required: ["note"],
    },
  },
  {
    name: "get_crm_overview",
    description:
      "Headline CRM numbers: total leads, new leads (7d and 1d), subscribed count, emails sent/simulated last 7d, active workflow enrollments.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_funnel_stats",
    description:
      "Funnel analytics for the owner's opt-in funnel: starts, opt-in rate, per-step drop-off, CTA clicks, daily sessions. days=0 means all time. Reads the 'default' funnel unless another funnel id is named.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Lookback window in days (default 7)" },
        funnel: { type: "string", description: "Funnel id (default 'default' — the funnel the site ingests into)" },
      },
    },
  },
  {
    name: "get_content_calendar",
    description:
      "Read the content calendar: planned/approved topics, drafts in review, published articles. Optionally filter by status.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["planned", "approved", "writing", "draft", "published", "archived"],
        },
        limit: { type: "number", description: "Max rows (default 20)" },
      },
    },
  },
  {
    name: "trend_scan",
    description:
      "Scan the web for rising topics in the owner's subject areas and add the best ones to the content calendar. Entries land as 'planned' (for the owner's review) unless they explicitly ask for 'approved'. Slow (~1 min). Returns what it found and added.",
    input_schema: {
      type: "object",
      properties: {
        max_new_entries: { type: "number", description: "Cap on new calendar entries (default 5)" },
        target_status: {
          type: "string",
          enum: ["planned", "approved"],
          description: "Calendar status for new entries (default 'planned'; only use 'approved' when the owner explicitly says so)",
        },
      },
    },
  },
  {
    name: "add_topics",
    description:
      "File one or more article topics straight into the content calendar — use this after pitching titles and getting the owner's pick. Default status 'planned'; use 'approved' only when he explicitly approves them for writing. Never publishes anything.",
    input_schema: {
      type: "object",
      properties: {
        topics: {
          type: "array",
          description: "Topics to file",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Article title" },
              target_keyword: { type: "string", description: "Primary SEO keyword" },
              keyword_cluster: { type: "string", description: "Cluster name, e.g. 'ai-strategy'" },
              pillar_topic: { type: "string", description: "Which content pillar this ladders to" },
              priority: { type: "string", enum: ["high", "medium", "low"] },
              notes: { type: "string", description: "Angle/context for the writer" },
            },
            required: ["title", "target_keyword"],
          },
        },
        status: {
          type: "string",
          enum: ["planned", "approved"],
          description: "Status for all filed topics (default 'planned')",
        },
      },
      required: ["topics"],
    },
  },
  {
    name: "draft_article",
    description:
      "Write a full SEO article DRAFT via the content pipeline: files the topic into the content calendar, writes ~2,000 words in brand voice with hero image, saves as a DRAFT (never published). Slow (2-3 min) — tell the user you're on it before calling. Use a specific, search-worthy title.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Article title" },
        target_keyword: { type: "string", description: "Primary SEO keyword" },
        keyword_cluster: { type: "string", description: "Cluster name, e.g. 'ai-strategy'" },
        notes: { type: "string", description: "Angle/context for the writer" },
      },
      required: ["title", "target_keyword"],
    },
  },
  {
    name: "list_workflows",
    description:
      "List email workflows (nurture sequences) in the CRM with their status, trigger, and enrollment counts. Check this before drafting a new one so you don't duplicate an existing sequence.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["draft", "active", "paused", "archived"] },
      },
    },
  },
  {
    name: "draft_workflow",
    description:
      "Create a new email workflow (nurture sequence) as a DRAFT: you brief the in-house sequence composer, it writes every email in brand voice, creates the templates, and assembles the workflow. It does NOT activate — no lead gets enrolled or emailed until the owner approves activation. Slow (~1 min). Write a rich brief: who it's for, what it should teach/shift, where it leads.",
    input_schema: {
      type: "object",
      properties: {
        brief: {
          type: "string",
          description:
            "The copywriter brief: purpose, audience, arc, destination (e.g. 'nurture cold imported contacts toward booking a discovery call over 2 weeks')",
        },
        num_emails: { type: "number", description: "How many emails (default 5, max 8)" },
        audience: { type: "string", description: "Extra audience context" },
        offer_slug: { type: "string", description: "Anchor the CTA to a specific offer slug" },
        trigger_type: {
          type: "string",
          enum: ["manual", "lead_created", "form_submitted", "tag_added", "status_changed"],
          description:
            "What enrolls leads once active (default 'manual' — owner enrolls by hand). Prefer 'tag_added' with a tag for targeted batches.",
        },
        trigger_config: {
          type: "object",
          description:
            "Trigger filter: {tag} for tag_added, {form} for form_submitted, {status} for status_changed. Empty = any event of that type.",
          properties: {
            tag: { type: "string" },
            form: { type: "string" },
            status: { type: "string" },
          },
        },
      },
      required: ["brief"],
    },
  },
  {
    name: "propose_workflow_activation",
    description:
      "Ask the owner to ACTIVATE a draft/paused workflow — activation is what starts enrolling and emailing leads, so it always goes through the approvals queue. Propose this only after the owner has seen the drafted sequence.",
    input_schema: {
      type: "object",
      properties: {
        workflow_id: { type: "string", description: "Workflow UUID" },
        reason: { type: "string", description: "One line: why activate this now, who it will touch" },
      },
      required: ["workflow_id", "reason"],
    },
  },
  {
    name: "draft_email",
    description:
      "Draft an email to ONE lead and put it in the owner's approvals queue. It is NOT sent until the owner approves (and in safe mode it previews to their inbox, not the lead). PREFERRED: pass a `brief` and let the in-house copywriter (Claude) write the copy in the owner's voice with full brand context — provide subject/body_md yourself only when the owner dictated exact copy. Body is markdown; merge tags like {{first_name|there}}; one CTA link on its own line; no signature/unsubscribe.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Lead's email address" },
        lead_id: { type: "string" },
        brief: {
          type: "string",
          description:
            "What this email should accomplish and any specifics to reference (their reply, their quiz answer, the offer to aim at). The in-house copywriter writes subject/preheader/body from this.",
        },
        subject: { type: "string", description: "Subject line, under 50 chars (optional with brief — a hint the copywriter may improve)" },
        preheader: { type: "string", description: "Inbox preview text, under 90 chars" },
        body_md: { type: "string", description: "Markdown email body (omit to let the copywriter write it from the brief)" },
        reason: { type: "string", description: "One line: why this email, why now" },
      },
      required: ["reason"],
    },
  },
  {
    name: "draft_personalized_batch",
    description:
      "Draft an INDIVIDUALLY personalized email for each lead matching a filter (cap 25) and queue them all for approval as one batch. Leads with quiz answers get copy anchored in their actual goal/blocker; others get light name/source personalization. Only subscribed leads; anyone emailed recently is skipped automatically. Slow (~1-2 min for a full batch) — tell the owner you're on it before calling. Nothing sends without approval.",
    input_schema: {
      type: "object",
      properties: {
        campaign_intent: {
          type: "string",
          description:
            "What this batch is trying to achieve, e.g. 'first touch for the conference list — introduce the owner, invite them to book a call'",
        },
        tag: { type: "string", description: "Match leads carrying this tag (e.g. 'conference-list')" },
        since_days: { type: "number", description: "Match leads created in the last N days" },
        emails: {
          type: "array",
          items: { type: "string" },
          description: "Explicit list of lead email addresses",
        },
        max_leads: { type: "number", description: "Batch cap (default and max 25)" },
        skip_emailed_days: {
          type: "number",
          description: "Skip leads emailed in the last N days (default 7)",
        },
      },
      required: ["campaign_intent"],
    },
  },
  {
    name: "list_engaged_leads",
    description:
      "Who opened or clicked emails recently: per-lead open/click counts over the last N days (default 7), most engaged first. Requires the Resend webhook to be feeding events; returns an empty list if nothing has been tracked yet.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Lookback window in days (default 7)" },
        limit: { type: "number", description: "Max leads returned (default 25)" },
      },
    },
  },
  {
    name: "list_pipeline",
    description:
      "The sales pipeline: every stage with its open opportunities (lead, value, days in stage). Stalled deals (open, untouched 7+ days) are flagged. Use stalled_only=true to see just the deals that need a nudge.",
    input_schema: {
      type: "object",
      properties: {
        stalled_only: { type: "boolean", description: "Only return stalled deals" },
        include_closed: { type: "boolean", description: "Include won/lost opportunities" },
      },
    },
  },
  {
    name: "create_opportunity",
    description:
      "Open a deal for a lead in the sales pipeline (defaults to the first stage). Internal CRM state — executes immediately, nothing reaches the lead. One open opportunity per lead.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Lead email" },
        lead_id: { type: "string" },
        name: { type: "string", description: "Deal name (defaults to the lead's name)" },
        value_dollars: { type: "number", description: "Expected deal value in dollars" },
        stage: { type: "string", description: "Stage name (default: first stage)" },
      },
    },
  },
  {
    name: "move_opportunity_stage",
    description:
      "Move a deal to another pipeline stage, or close it as won/lost. Internal CRM state — executes immediately. Identify the deal by opportunity_id or by the lead's email (their open deal).",
    input_schema: {
      type: "object",
      properties: {
        opportunity_id: { type: "string" },
        email: { type: "string", description: "Lead email (uses their open opportunity)" },
        stage: { type: "string", description: "Target stage name" },
        close_as: { type: "string", enum: ["won", "lost"], description: "Close the deal instead of moving it" },
        lost_reason: { type: "string", description: "Why it was lost (when close_as='lost')" },
      },
    },
  },
  {
    name: "sync_pipeline",
    description:
      "Backfill and reconcile the sales pipeline so every real inbound lead has an open deal: leads already in an email sequence land in 'Nurturing', the rest in 'New'. Bulk-imported list rows (source 'csv-import') are excluded unless you explicitly target them. Idempotent — leads that already have an open deal are left alone (a 'New' deal is advanced to 'Nurturing' if they're now in a sequence). Run with dry_run first to preview counts. Internal CRM state; nothing reaches any lead.",
    input_schema: {
      type: "object",
      properties: {
        dry_run: { type: "boolean", description: "Preview only — report what WOULD change without writing (default false)" },
        tag: { type: "string", description: "Only leads carrying this tag (e.g. 'newsletter')" },
        source: { type: "string", description: "Only leads with this source (e.g. 'contact-form')" },
        since_days: { type: "number", description: "Only leads created in the last N days" },
        include_imports: {
          type: "boolean",
          description: "Include bulk-imported list rows (source 'csv-import') — default false, keeps cold contacts off the sales board",
        },
        limit: { type: "number", description: "Max leads to process (default 200, max 500)" },
      },
    },
  },
  {
    name: "list_appointments",
    description:
      "the owner's calendar — booked calls from Cal.com (the appointments table). Defaults to upcoming calls, soonest first; use range='past' to review calls that have already happened. Past calls still marked 'scheduled' are flagged needs_outcome=true so you know to mark them completed or no_show. Each row carries the lead, the meeting link, the event type and the status. Read-only. Use it for \"what's on my calendar this week\" and to spot calls that need an outcome recorded.",
    input_schema: {
      type: "object",
      properties: {
        range: { type: "string", enum: ["upcoming", "past", "all"], description: "upcoming (default), past, or all" },
        days: { type: "number", description: "Window size in days from now (default 30)" },
        status: {
          type: "string",
          enum: ["scheduled", "completed", "cancelled", "no_show", "rescheduled"],
          description: "Only appointments with this status",
        },
        limit: { type: "number", description: "Max rows (default 50, max 100)" },
      },
    },
  },
  {
    name: "set_appointment_status",
    description:
      "Record how a booked call went — mark it completed, no_show, cancelled, rescheduled, or back to scheduled. Identify the call by appointment_id (from list_appointments) or by the lead's email (their most recent call). Marking no_show tags the lead 'no-show' and completed tags them 'call-completed', so a follow-up workflow can hang off that tag. Internal CRM state — executes immediately; it does NOT touch Cal.com or email the guest (Cal.com owns the actual reschedule/cancel).",
    input_schema: {
      type: "object",
      properties: {
        appointment_id: { type: "string", description: "Appointment id from list_appointments" },
        email: { type: "string", description: "Lead email (uses their most recent appointment)" },
        status: {
          type: "string",
          enum: ["completed", "no_show", "cancelled", "rescheduled", "scheduled"],
          description: "The outcome to record",
        },
        note: { type: "string", description: "Optional note added to the lead's timeline" },
      },
      required: ["status"],
    },
  },
  {
    name: "list_recent_replies",
    description:
      "Inbound email replies from leads in the last N days (default 7), newest first, with the reply text. When someone replied, that's the warmest signal in the house — read it with get_lead, then draft a response with draft_email.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Lookback window in days (default 7)" },
      },
    },
  },
  {
    name: "get_content_attribution",
    description:
      "Which site content actually attracts leads: pages ranked by how many visitors who read them later converted. Empty until visitor tracking links sessions to leads.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max pages returned (default 15)" },
      },
    },
  },
  {
    name: "set_subject_test",
    description:
      "Start an A/B subject-line test on an email template: sends alternate between the current subject (A) and your challenger (B); once both variants have 30+ real sends the engine auto-promotes the open-rate winner. Find template ids via list_workflows steps or list_subject_tests.",
    input_schema: {
      type: "object",
      properties: {
        template_id: { type: "string", description: "email_templates UUID" },
        subject_b: { type: "string", description: "Challenger subject line, under 50 chars" },
      },
      required: ["template_id", "subject_b"],
    },
  },
  {
    name: "list_subject_tests",
    description:
      "Active A/B subject-line tests with per-variant sends and open rates, so you can see what's winning before the engine auto-promotes.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "save_insight",
    description:
      "Write a learning to your persistent memory — it survives across runs and days. Save ONLY evidence-backed insights about what works: which subject styles get opens, which lead segments convert, which CTAs get clicks, what the owner corrected. One clear sentence + the evidence. Don't save raw numbers that the other tools already report.",
    input_schema: {
      type: "object",
      properties: {
        insight: { type: "string", description: "The learning, one or two sentences" },
        evidence: { type: "string", description: "What backs it: the numbers, the test, or the owner's words" },
      },
      required: ["insight"],
    },
  },
  {
    name: "list_insights",
    description:
      "Read your persistent memory: learnings you saved in past runs (what works, what the owner prefers, what converts). Check this at the start of reviews and before drafting campaigns so every run builds on the last.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max insights returned, newest first (default 25)" },
      },
    },
  },
  {
    name: "propose_publish",
    description:
      "Propose publishing a drafted article to the owner's live site. Goes to the approvals queue; the owner's approval is what actually publishes it. Requires a calendar entry that already has a written draft.",
    input_schema: {
      type: "object",
      properties: {
        calendar_entry_id: { type: "string", description: "content_calendar entry UUID" },
        reason: { type: "string", description: "One line: why publish this now" },
      },
      required: ["calendar_entry_id", "reason"],
    },
  },
  {
    name: "propose_action",
    description:
      "Propose any other action for the owner's approval that you can't do with your tools (e.g. 'flip safe mode off', 'record a YouTube video on X'). Lands in the approvals queue as a to-do.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short imperative title" },
        description: { type: "string", description: "What and why" },
      },
      required: ["title", "description"],
    },
  },
];

const executors: Record<string, Executor> = {
  async list_leads(input, { supabase }) {
    const limit = Math.min(100, Math.max(1, Number(input.limit) || 25));
    const byScore = str(input.order_by) === "score";
    let query = supabase
      .from("leads")
      .select("id, email, first_name, last_name, status, source, tags, score, email_status, created_at, last_activity_at")
      .limit(limit);
    query = byScore
      ? query.order("score", { ascending: false }).order("created_at", { ascending: false })
      : query.order("created_at", { ascending: false });
    if (str(input.status)) query = query.eq("status", str(input.status) as "new");
    const sinceDays = Number(input.since_days);
    if (Number.isFinite(sinceDays) && sinceDays > 0) {
      query = query.gte("created_at", new Date(Date.now() - sinceDays * 86_400_000).toISOString());
    }
    const minScore = Number(input.min_score);
    if (Number.isFinite(minScore) && minScore > 0) query = query.gte("score", minScore);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return {
      data: { count: data.length, leads: data },
      summary: `Listed ${data.length} lead${data.length === 1 ? "" : "s"}`,
    };
  },

  async get_lead(input, { supabase }) {
    const lead = await findLead(supabase, input);
    const [{ data: activities }, { data: events }, opens, clicks] = await Promise.all([
      supabase
        .from("lead_activities")
        .select("activity_type, title, body, actor, created_at")
        .eq("lead_id", lead.id)
        .order("created_at", { ascending: false })
        .limit(10),
      supabase
        .from("email_events")
        .select("event_type, created_at")
        .eq("lead_id", lead.id)
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("email_events")
        .select("id", { count: "exact", head: true })
        .eq("lead_id", lead.id)
        .eq("event_type", "opened"),
      supabase
        .from("email_events")
        .select("id", { count: "exact", head: true })
        .eq("lead_id", lead.id)
        .eq("event_type", "clicked"),
    ]);
    const recommendedOffer = await routeOfferForLead(supabase, lead);
    return {
      data: {
        lead,
        recent_activity: activities || [],
        engagement: {
          opens: opens.count ?? 0,
          clicks: clicks.count ?? 0,
          recent_email_events: events || [],
        },
        recommended_offer: recommendedOffer,
      },
      summary: `Read lead ${lead.email}`,
    };
  },

  async tag_lead(input, { supabase }) {
    const lead = await findLead(supabase, input);
    const tag = str(input.tag);
    if (!tag) throw new Error("tag is required");
    const tags = Array.from(new Set([...(lead.tags || []), tag]));
    const { error } = await supabase.from("leads").update({ tags }).eq("id", lead.id);
    if (error) throw new Error(error.message);
    await logActivity(supabase, {
      lead_id: lead.id,
      activity_type: "tag_added",
      title: `Tag added: ${tag}`,
      actor: "agent:operator",
    });
    return { data: { ok: true, tags }, summary: `Tagged ${lead.email} with '${tag}'` };
  },

  async add_note(input, { supabase }) {
    const lead = await findLead(supabase, input);
    const note = str(input.note);
    if (!note) throw new Error("note is required");
    await logActivity(supabase, {
      lead_id: lead.id,
      activity_type: "note",
      title: "Note from The Operator",
      body: note,
      actor: "agent:operator",
    });
    return { data: { ok: true }, summary: `Added a note to ${lead.email}` };
  },

  async get_crm_overview(_input, { supabase }) {
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const [total, newWeek, newDay, subscribed, emails7d, enrollments] = await Promise.all([
      supabase.from("leads").select("id", { count: "exact", head: true }),
      supabase.from("leads").select("id", { count: "exact", head: true }).gte("created_at", weekAgo),
      supabase.from("leads").select("id", { count: "exact", head: true }).gte("created_at", dayAgo),
      supabase.from("leads").select("id", { count: "exact", head: true }).eq("email_status", "subscribed"),
      supabase.from("email_sends").select("id", { count: "exact", head: true }).gte("created_at", weekAgo),
      supabase
        .from("workflow_enrollments")
        .select("id", { count: "exact", head: true })
        .eq("status", "active"),
    ]);
    const data = {
      total_leads: total.count ?? 0,
      new_leads_7d: newWeek.count ?? 0,
      new_leads_1d: newDay.count ?? 0,
      subscribed: subscribed.count ?? 0,
      emails_7d: emails7d.count ?? 0,
      active_enrollments: enrollments.count ?? 0,
    };
    return { data, summary: `CRM overview: ${data.total_leads} leads, ${data.new_leads_1d} new today` };
  },

  async get_funnel_stats(input, { supabase }) {
    const days = Number.isFinite(Number(input.days)) ? Math.max(0, Number(input.days)) : 7;
    const stats = await getFunnelStats(supabase, str(input.funnel) || "default", days);
    return {
      data: stats,
      summary: `Funnel (${days || "all"}d): ${stats.totals.starts} starts, ${stats.totals.optin_rate}% opt-in`,
    };
  },

  async get_content_calendar(input, { supabase }) {
    const limit = Math.min(50, Math.max(1, Number(input.limit) || 20));
    let query = supabase
      .from("content_calendar")
      .select("id, title, target_keyword, status, priority, pillar_topic, created_by, created_at, content_object_id")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (str(input.status)) query = query.eq("status", str(input.status) as "planned");
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const byStatus: Record<string, number> = {};
    for (const row of data) byStatus[row.status] = (byStatus[row.status] || 0) + 1;
    return {
      data: { count: data.length, by_status: byStatus, entries: data },
      summary: `Read content calendar (${data.length} entries)`,
    };
  },

  async trend_scan(input, { origin }) {
    const max = Math.min(10, Math.max(1, Number(input.max_new_entries) || 5));
    const targetStatus = input.target_status === "approved" ? "approved" : "planned";
    const result = (await callInternalApi(origin, "/api/trend-scan", {
      max_new_entries: max,
      target_status: targetStatus,
    })) as { trends_found?: number; new_entries?: number; entries?: unknown[] };
    return {
      data: result,
      summary: `Trend scan: ${result.trends_found ?? 0} trends found, ${result.new_entries ?? 0} added as ${targetStatus}`,
    };
  },

  async add_topics(input, { supabase }) {
    const status = input.status === "approved" ? ("approved" as const) : ("planned" as const);
    const raw = Array.isArray(input.topics) ? (input.topics as Record<string, unknown>[]) : [];
    const topics = raw
      .map((t) => ({
        title: str(t.title),
        target_keyword: str(t.target_keyword),
        keyword_cluster: str(t.keyword_cluster) || null,
        pillar_topic: str(t.pillar_topic) || null,
        priority: (["high", "medium", "low"].includes(str(t.priority))
          ? str(t.priority)
          : "medium") as "high" | "medium" | "low",
        notes: str(t.notes) || null,
      }))
      .filter((t) => t.title && t.target_keyword);
    if (topics.length === 0) throw new Error("Provide at least one topic with title and target_keyword");
    if (topics.length > 25) throw new Error("Max 25 topics per call");

    const filed: string[] = [];
    const skipped: string[] = [];
    for (const topic of topics) {
      const { error } = await supabase.from("content_calendar").insert({
        title: topic.title,
        target_keyword: topic.target_keyword,
        search_query: topic.target_keyword,
        keyword_cluster: topic.keyword_cluster,
        pillar_topic: topic.pillar_topic,
        priority: topic.priority,
        status,
        created_by: "content_agent",
        notes: topic.notes ? `[The Operator] ${topic.notes}` : "[The Operator] filed from agent chat",
      });
      if (error) {
        // 23505 = duplicate (search_query, target_keyword) — skip, don't fail the batch
        if (error.code === "23505") skipped.push(topic.title);
        else throw new Error(`Failed to file "${topic.title}": ${error.message}`);
      } else {
        filed.push(topic.title);
      }
    }
    return {
      data: { filed, skipped, status },
      summary: `Filed ${filed.length} topic${filed.length === 1 ? "" : "s"} as ${status}${skipped.length ? ` (${skipped.length} duplicate${skipped.length === 1 ? "" : "s"} skipped)` : ""}`,
    };
  },

  async draft_article(input, { supabase, origin }) {
    const title = str(input.title);
    const keyword = str(input.target_keyword);
    if (!title || !keyword) throw new Error("title and target_keyword are required");

    // Reuse an existing calendar entry for this exact topic rather than
    // inserting a duplicate — the table has a unique-topic index, so a second
    // insert would fail. This also makes a retry after a failed write below
    // pick up where it left off instead of dead-ending.
    const { data: existing } = await supabase
      .from("content_calendar")
      .select("id")
      .eq("title", title)
      .maybeSingle();

    let entryId = existing?.id ?? null;
    const reusedEntry = entryId !== null;

    if (!entryId) {
      const { data: entry, error } = await supabase
        .from("content_calendar")
        .insert({
          title,
          target_keyword: keyword,
          search_query: keyword,
          keyword_cluster: str(input.keyword_cluster) || null,
          status: "approved",
          priority: "high",
          created_by: "content_agent",
          notes: str(input.notes) ? `[The Operator] ${str(input.notes)}` : "[The Operator] drafted from agent chat",
        })
        .select("id")
        .single();
      if (error || !entry) throw new Error(`Calendar insert failed: ${error?.message}`);
      entryId = entry.id;
    }

    // Runs the full write-article pipeline; publish mode 'safe' → saved as DRAFT.
    // If it fails we must not strand the calendar row we just created: the
    // unique-topic index would make every retry fail on a duplicate key and
    // the topic could never be drafted again without manual cleanup.
    let result: { article?: { title: string; slug: string; status: string; word_count: number } };
    try {
      result = (await callInternalApi(origin, "/api/write-article", {
        calendar_entry_id: entryId,
        publish_mode: "safe",
      })) as { article?: { title: string; slug: string; status: string; word_count: number } };
    } catch (e) {
      if (!reusedEntry) {
        await supabase.from("content_calendar").delete().eq("id", entryId);
      }
      throw new Error(
        `${e instanceof Error ? e.message : "Article generation failed"} — the topic was not filed, so this is safe to retry`
      );
    }

    return {
      data: { calendar_entry_id: entryId, ...result },
      summary: `Drafted article "${result.article?.title || title}" (${result.article?.word_count || "?"} words, saved as draft)`,
    };
  },

  async list_workflows(input, { supabase }) {
    let query = supabase
      .from("workflows")
      .select("id, name, description, status, trigger_type, trigger_config, steps, enrolled_count, completed_count, created_at")
      .order("created_at", { ascending: false })
      .limit(30);
    if (str(input.status)) query = query.eq("status", str(input.status) as "draft");
    const { data, error } = await query;
    if (error) throw new Error(error.message);

    // Resolve template subjects so subject tests can target a step directly
    const templateIds = new Set<string>();
    for (const w of data || []) {
      if (!Array.isArray(w.steps)) continue;
      for (const s of w.steps as { type?: string; config?: { template_id?: string } }[]) {
        if (s?.type === "send_email" && s.config?.template_id) templateIds.add(s.config.template_id);
      }
    }
    const subjects = new Map<string, { subject: string; subject_b: string | null }>();
    if (templateIds.size > 0) {
      const { data: templates } = await supabase
        .from("email_templates")
        .select("id, subject, subject_b")
        .in("id", Array.from(templateIds));
      for (const t of templates || []) {
        subjects.set(t.id, { subject: t.subject, subject_b: (t as { subject_b?: string | null }).subject_b ?? null });
      }
    }

    const workflows = (data || []).map((w) => {
      const emailSteps = Array.isArray(w.steps)
        ? (w.steps as { type?: string; config?: { template_id?: string; subject?: string } }[])
            .filter((s) => s?.type === "send_email")
            .map((s, i) => ({
              position: i + 1,
              template_id: s.config?.template_id ?? null,
              subject: s.config?.template_id
                ? subjects.get(s.config.template_id)?.subject ?? null
                : s.config?.subject ?? null,
              subject_b: s.config?.template_id ? subjects.get(s.config.template_id)?.subject_b ?? null : null,
            }))
        : [];
      return {
        id: w.id,
        name: w.name,
        description: w.description,
        status: w.status,
        trigger_type: w.trigger_type,
        trigger_config: w.trigger_config,
        email_steps: emailSteps,
        enrolled_count: w.enrolled_count,
        completed_count: w.completed_count,
      };
    });
    return {
      data: { count: workflows.length, workflows },
      summary: `Listed ${workflows.length} workflow${workflows.length === 1 ? "" : "s"}`,
    };
  },

  async draft_workflow(input, { origin }) {
    const brief = str(input.brief);
    if (brief.length < 10) throw new Error("brief is required — tell the composer what this sequence is for");
    const triggerType = str(input.trigger_type);
    const result = (await callInternalApi(origin, "/api/crm/ai/draft-sequence", {
      brief,
      num_emails: Math.min(8, Math.max(1, Number(input.num_emails) || 5)),
      audience: str(input.audience) || undefined,
      offer_slug: str(input.offer_slug) || undefined,
      trigger_type: triggerType || "manual",
      trigger_config:
        input.trigger_config && typeof input.trigger_config === "object" ? input.trigger_config : {},
    })) as {
      workflow?: { id: string; name: string; status: string; trigger_type: string };
      draft?: { emails?: { subject: string; purpose: string }[]; goal?: string };
    };
    if (!result.workflow) throw new Error("Composer returned no workflow");
    return {
      data: {
        workflow_id: result.workflow.id,
        name: result.workflow.name,
        status: result.workflow.status,
        trigger_type: result.workflow.trigger_type,
        goal: result.draft?.goal,
        emails: (result.draft?.emails || []).map((e) => ({ subject: e.subject, purpose: e.purpose })),
      },
      summary: `Drafted workflow "${result.workflow.name}" (${result.draft?.emails?.length ?? 0} emails, saved as draft)`,
    };
  },

  async propose_workflow_activation(input, { supabase, runId }) {
    const workflowId = str(input.workflow_id);
    if (!workflowId) throw new Error("workflow_id is required");
    const { data: workflow, error } = await supabase
      .from("workflows")
      .select("id, name, status, trigger_type, trigger_config, steps")
      .eq("id", workflowId)
      .single();
    if (error || !workflow) throw new Error("Workflow not found");
    if (workflow.status === "active") throw new Error(`"${workflow.name}" is already active`);
    if (workflow.status === "archived") throw new Error(`"${workflow.name}" is archived — can't activate`);

    const emailSteps = Array.isArray(workflow.steps)
      ? (workflow.steps as { type?: string }[]).filter((s) => s?.type === "send_email").length
      : 0;

    const { data: action, error: insertError } = await supabase
      .from("agent_actions")
      .insert({
        run_id: runId,
        type: "workflow",
        title: `Activate workflow: ${workflow.name}`,
        summary: str(input.reason) || null,
        payload: {
          workflow_id: workflow.id,
          workflow_name: workflow.name,
          trigger_type: workflow.trigger_type,
          trigger_config: workflow.trigger_config,
          email_steps: emailSteps,
          reason: str(input.reason) || null,
        } as Json,
      })
      .select("id")
      .single();
    if (insertError || !action) throw new Error(`Failed to queue activation: ${insertError?.message}`);

    return {
      data: { action_id: action.id, status: "proposed" },
      summary: `Proposed activating "${workflow.name}" — waiting for approval`,
    };
  },

  async draft_email(input, { supabase, runId }) {
    const lead = await findLead(supabase, input);
    if (lead.email_status !== "subscribed") {
      throw new Error(`${lead.email} is ${lead.email_status} — cannot email them`);
    }
    let subject = str(input.subject);
    let bodyMd = str(input.body_md);
    let preheader = str(input.preheader) || null;
    const brief = str(input.brief);
    let writer: "caller" | "claude" = "caller";

    if (!bodyMd) {
      // Delegate the copy to the in-house copywriter (Claude) — the
      // orchestrator (Operator loop / Hermes) briefs, Claude writes.
      if (!brief) throw new Error("Provide body_md, or a brief for the in-house copywriter");
      const brand = await loadBrandContext(supabase);
      const offer = await routeOfferForLead(supabase, lead).catch(() => null);
      const { sender } = await getCrmSettings(supabase);
      const system =
        `You write emails as ${sender.from_name} — their voice, to a real person who trusts them.\n\n` +
        `${brand}\n${SEQUENCE_CRAFT_RULES}\n` +
        `- NEVER use the phrase "while you sleep" or any sleep-trope phrasing; say "around the clock" or similar.\n` +
        `- Write ONE email, not a sequence.`;
      const user =
        `Lead: ${[lead.first_name, lead.last_name].filter(Boolean).join(" ") || "unknown name"} <${lead.email}>, source: ${lead.source || "n/a"}, ` +
        `tags: ${(lead.tags || []).join(", ") || "none"}, score: ${lead.score ?? 0}\n` +
        (lead.custom ? `Custom fields (quiz answers etc.): ${JSON.stringify(lead.custom).slice(0, 1500)}\n` : "") +
        (offer ? `Recommended offer: ${JSON.stringify(offer).slice(0, 500)}\n` : "") +
        `\nBrief from the orchestrator: ${brief}\n` +
        (subject ? `Subject hint (improve it if you can do better): ${subject}\n` : "") +
        `\nReturn subject, preheader and body_md.`;
      const { result } = await callClaudeStructured<{
        subject: string;
        preheader?: string;
        body_md: string;
      }>(system, user, REWRITE_SCHEMA, 4096);
      subject = result.subject;
      preheader = result.preheader || null;
      bodyMd = result.body_md;
      writer = "claude";
    }
    if (!subject || !bodyMd) throw new Error("subject and body_md are required (or pass a brief)");

    const { data: action, error } = await supabase
      .from("agent_actions")
      .insert({
        run_id: runId,
        type: "email",
        title: `Email ${lead.email}: ${subject}`,
        summary: str(input.reason) || null,
        payload: {
          lead_id: lead.id,
          email: lead.email,
          subject,
          preheader,
          body_md: bodyMd,
          reason: str(input.reason) || null,
          writer,
        } as Json,
      })
      .select("id")
      .single();
    if (error || !action) throw new Error(`Failed to queue email: ${error?.message}`);

    return {
      data: { action_id: action.id, status: "proposed", to: lead.email, subject, writer },
      summary: `Drafted email to ${lead.email}${writer === "claude" ? " (Claude-written from brief)" : ""} — waiting for approval`,
    };
  },

  async draft_personalized_batch(input, { supabase, runId }) {
    const result = await draftPersonalizedBatch(supabase, runId, {
      campaign_intent: str(input.campaign_intent),
      tag: str(input.tag) || undefined,
      since_days: Number.isFinite(Number(input.since_days)) ? Number(input.since_days) : undefined,
      emails: Array.isArray(input.emails) ? (input.emails as string[]) : undefined,
      max_leads: Number.isFinite(Number(input.max_leads)) ? Number(input.max_leads) : undefined,
      skip_emailed_days: Number.isFinite(Number(input.skip_emailed_days))
        ? Number(input.skip_emailed_days)
        : undefined,
    });
    return {
      data: result,
      summary: `Drafted ${result.drafted.length} personalized email${result.drafted.length === 1 ? "" : "s"} (batch ${result.batch_id.slice(0, 8)}${result.skipped.length ? `, ${result.skipped.length} skipped` : ""}) — waiting for approval`,
    };
  },

  async list_engaged_leads(input, { supabase }) {
    const days = Number.isFinite(Number(input.days)) ? Math.max(1, Number(input.days)) : 7;
    const limit = Math.min(100, Math.max(1, Number(input.limit) || 25));
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const { data: events, error } = await supabase
      .from("email_events")
      .select("lead_id, event_type, created_at")
      .in("event_type", ["opened", "clicked"])
      .gte("created_at", since)
      .limit(5000);
    if (error) throw new Error(error.message);

    const byLead = new Map<string, { opens: number; clicks: number; last_event_at: string }>();
    for (const e of events || []) {
      const entry = byLead.get(e.lead_id) || { opens: 0, clicks: 0, last_event_at: e.created_at };
      if (e.event_type === "opened") entry.opens++;
      else entry.clicks++;
      if (e.created_at > entry.last_event_at) entry.last_event_at = e.created_at;
      byLead.set(e.lead_id, entry);
    }
    if (byLead.size === 0) {
      return {
        data: { count: 0, days, leads: [], note: "No opens/clicks tracked in this window (engagement tracking needs the Resend webhook feeding events)" },
        summary: `No email engagement tracked in the last ${days}d`,
      };
    }

    const ids = Array.from(byLead.keys());
    const { data: leads } = await supabase
      .from("leads")
      .select("id, email, first_name, last_name, status, score, tags")
      .in("id", ids);
    const enriched = (leads || [])
      .map((l) => ({ ...l, ...byLead.get(l.id)! }))
      .sort((a, b) => b.clicks - a.clicks || b.opens - a.opens)
      .slice(0, limit);
    return {
      data: { count: enriched.length, days, leads: enriched },
      summary: `${enriched.length} lead${enriched.length === 1 ? "" : "s"} engaged in the last ${days}d`,
    };
  },

  async list_pipeline(input, { supabase }) {
    const [{ data: stages, error }, { data: opps }] = await Promise.all([
      supabase.from("pipeline_stages").select("id, name, position").order("position"),
      supabase
        .from("opportunities")
        .select("id, name, status, value_cents, stage_id, updated_at, created_at, lost_reason, leads(email, first_name, last_name, score)")
        .order("updated_at", { ascending: false })
        .limit(200),
    ]);
    if (error) throw new Error(error.message);

    const includeClosed = input.include_closed === true;
    const now = Date.now();
    const enriched = (opps || [])
      .filter((o) => includeClosed || o.status === "open")
      .map((o) => {
        const lead = o.leads as unknown as { email: string; first_name: string | null; last_name: string | null; score: number } | null;
        const daysInStage = Math.floor((now - Date.parse(o.updated_at)) / 86_400_000);
        return {
          id: o.id,
          name: o.name,
          status: o.status,
          value_dollars: o.value_cents != null ? Math.round(Number(o.value_cents) / 100) : null,
          stage: (stages || []).find((s) => s.id === o.stage_id)?.name || "unknown",
          lead_email: lead?.email || null,
          lead_score: lead?.score ?? null,
          days_in_stage: daysInStage,
          stalled: o.status === "open" && daysInStage >= STALLED_AFTER_DAYS,
          lost_reason: o.lost_reason,
        };
      });

    const stalled = enriched.filter((o) => o.stalled);
    const rows = input.stalled_only === true ? stalled : enriched;
    const byStage = (stages || []).map((s) => ({
      stage: s.name,
      deals: enriched.filter((o) => o.stage === s.name && o.status === "open").length,
      value_dollars: enriched
        .filter((o) => o.stage === s.name && o.status === "open")
        .reduce((sum, o) => sum + (o.value_dollars || 0), 0),
    }));
    return {
      data: { stages: byStage, opportunities: rows, stalled_count: stalled.length },
      summary:
        input.stalled_only === true
          ? `${stalled.length} stalled deal${stalled.length === 1 ? "" : "s"}`
          : `Pipeline: ${enriched.filter((o) => o.status === "open").length} open deal${enriched.length === 1 ? "" : "s"}, ${stalled.length} stalled`,
    };
  },

  async create_opportunity(input, { supabase }) {
    const lead = await findLead(supabase, input);
    const { data: existing } = await supabase
      .from("opportunities")
      .select("id, name")
      .eq("lead_id", lead.id)
      .eq("status", "open")
      .limit(1);
    if (existing?.length) {
      throw new Error(`${lead.email} already has an open deal ("${existing[0].name}") — move it instead`);
    }

    const { data: stages } = await supabase.from("pipeline_stages").select("id, name, pipeline_id, position").order("position");
    if (!stages?.length) throw new Error("No pipeline stages configured");
    const stageName = str(input.stage).toLowerCase();
    const stage = stageName
      ? stages.find((s) => s.name.toLowerCase() === stageName)
      : stages[0];
    if (!stage) throw new Error(`No stage named "${str(input.stage)}" — stages: ${stages.map((s) => s.name).join(", ")}`);

    const name =
      str(input.name) || [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.email;
    const valueDollars = Number(input.value_dollars);
    const { data: opp, error } = await supabase
      .from("opportunities")
      .insert({
        lead_id: lead.id,
        pipeline_id: stage.pipeline_id,
        stage_id: stage.id,
        name,
        ...(Number.isFinite(valueDollars) && valueDollars > 0
          ? { value_cents: Math.round(valueDollars * 100) }
          : {}),
      })
      .select("id")
      .single();
    if (error || !opp) throw new Error(`Failed to create opportunity: ${error?.message}`);

    await logActivity(supabase, {
      lead_id: lead.id,
      activity_type: "stage_changed",
      title: `Opportunity created: ${name} (${stage.name})`,
      data: { opportunity_id: opp.id, stage_id: stage.id },
      actor: "agent:operator",
    });
    await fireTrigger(supabase, { type: "stage_changed", lead: lead as Tables<"leads">, data: { stage_id: stage.id } });
    return {
      data: { opportunity_id: opp.id, stage: stage.name, name },
      summary: `Opened deal "${name}" in ${stage.name}`,
    };
  },

  async move_opportunity_stage(input, { supabase }) {
    let query = supabase
      .from("opportunities")
      .select("id, name, lead_id, status, stage_id")
      .eq("status", "open");
    const oppId = str(input.opportunity_id);
    if (oppId) {
      query = query.eq("id", oppId);
    } else {
      const lead = await findLead(supabase, input);
      query = query.eq("lead_id", lead.id);
    }
    const { data: opps, error } = await query.limit(1);
    if (error) throw new Error(error.message);
    const opp = opps?.[0];
    if (!opp) throw new Error("No open opportunity found — create one first");

    const closeAs = str(input.close_as);
    if (closeAs === "won" || closeAs === "lost") {
      const patch =
        closeAs === "won"
          ? { status: "won" as const, won_at: new Date().toISOString() }
          : { status: "lost" as const, lost_at: new Date().toISOString(), lost_reason: str(input.lost_reason) || null };
      const { error: closeError } = await supabase.from("opportunities").update(patch).eq("id", opp.id);
      if (closeError) throw new Error(closeError.message);
      await logActivity(supabase, {
        lead_id: opp.lead_id,
        activity_type: "stage_changed",
        title: `Deal ${closeAs}: ${opp.name}${closeAs === "lost" && str(input.lost_reason) ? ` (${str(input.lost_reason)})` : ""}`,
        data: { opportunity_id: opp.id },
        actor: "agent:operator",
      });
      return { data: { opportunity_id: opp.id, status: closeAs }, summary: `Closed "${opp.name}" as ${closeAs}` };
    }

    const stageName = str(input.stage).toLowerCase();
    if (!stageName) throw new Error("Provide stage or close_as");
    const { data: stages } = await supabase.from("pipeline_stages").select("id, name, pipeline_id").order("position");
    const stage = (stages || []).find((s) => s.name.toLowerCase() === stageName);
    if (!stage) throw new Error(`No stage named "${str(input.stage)}" — stages: ${(stages || []).map((s) => s.name).join(", ")}`);

    const { error: moveError } = await supabase
      .from("opportunities")
      .update({ stage_id: stage.id, pipeline_id: stage.pipeline_id })
      .eq("id", opp.id);
    if (moveError) throw new Error(moveError.message);

    const { data: lead } = await supabase.from("leads").select("*").eq("id", opp.lead_id).single();
    await logActivity(supabase, {
      lead_id: opp.lead_id,
      activity_type: "stage_changed",
      title: `Moved to stage: ${stage.name}`,
      data: { opportunity_id: opp.id, stage_id: stage.id },
      actor: "agent:operator",
    });
    if (lead) await fireTrigger(supabase, { type: "stage_changed", lead, data: { stage_id: stage.id } });
    return { data: { opportunity_id: opp.id, stage: stage.name }, summary: `Moved "${opp.name}" to ${stage.name}` };
  },

  async list_appointments(input, { supabase }) {
    const limit = Math.min(100, Math.max(1, Number(input.limit) || 50));
    const range = str(input.range) || "upcoming";
    const days = Number.isFinite(Number(input.days)) && Number(input.days) > 0 ? Number(input.days) : 30;
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    let query = supabase
      .from("appointments")
      .select(
        "id, title, starts_at, ends_at, status, event_slug, meeting_url, timezone, lead_id, leads(email, first_name, last_name)"
      )
      .limit(limit);

    if (range === "past") {
      query = query
        .lt("starts_at", nowIso)
        .gte("starts_at", new Date(now - days * 86_400_000).toISOString())
        .order("starts_at", { ascending: false });
    } else if (range === "all") {
      query = query
        .gte("starts_at", new Date(now - days * 86_400_000).toISOString())
        .lte("starts_at", new Date(now + days * 86_400_000).toISOString())
        .order("starts_at", { ascending: true });
    } else {
      query = query
        .gte("starts_at", nowIso)
        .lte("starts_at", new Date(now + days * 86_400_000).toISOString())
        .order("starts_at", { ascending: true });
    }
    if (str(input.status)) query = query.eq("status", str(input.status) as "scheduled");

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const rows = (data || []).map((a) => {
      const lead = a.leads as unknown as { email: string; first_name: string | null; last_name: string | null } | null;
      return {
        appointment_id: a.id,
        title: a.title,
        starts_at: a.starts_at,
        status: a.status,
        event_type: a.event_slug,
        meeting_url: a.meeting_url,
        lead_email: lead?.email || null,
        lead_name: lead ? [lead.first_name, lead.last_name].filter(Boolean).join(" ") || null : null,
        // a call in the past still marked scheduled hasn't had its outcome recorded
        needs_outcome: a.status === "scheduled" && Date.parse(a.starts_at) < now,
      };
    });
    const needsOutcome = rows.filter((r) => r.needs_outcome).length;
    return {
      data: { count: rows.length, needs_outcome_count: needsOutcome, appointments: rows },
      summary: `${rows.length} ${range} appointment${rows.length === 1 ? "" : "s"}${needsOutcome ? `, ${needsOutcome} need an outcome` : ""}`,
    };
  },

  async set_appointment_status(input, { supabase }) {
    const status = str(input.status);
    const allowed = ["completed", "no_show", "cancelled", "rescheduled", "scheduled"];
    if (!allowed.includes(status)) throw new Error(`status must be one of ${allowed.join(", ")}`);

    const cols = "id, lead_id, title, starts_at, status";
    let appt: Pick<Tables<"appointments">, "id" | "lead_id" | "title" | "starts_at" | "status"> | null = null;
    const apptId = str(input.appointment_id);
    if (apptId) {
      const { data, error } = await supabase.from("appointments").select(cols).eq("id", apptId).maybeSingle();
      if (error) throw new Error(error.message);
      appt = data;
    } else {
      const lead = await findLead(supabase, input);
      const { data, error } = await supabase
        .from("appointments")
        .select(cols)
        .eq("lead_id", lead.id)
        .order("starts_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      appt = data?.[0] || null;
    }
    if (!appt) throw new Error("No appointment found — check the appointment_id or lead email");

    const { error: updateError } = await supabase
      .from("appointments")
      .update({ status: status as Tables<"appointments">["status"], updated_at: new Date().toISOString() })
      .eq("id", appt.id);
    if (updateError) throw new Error(updateError.message);

    // Marking the outcome tags the lead so a follow-up sequence can hang off it.
    const OUTCOME_TAG: Record<string, string> = { no_show: "no-show", completed: "call-completed" };
    const tag = OUTCOME_TAG[status];
    let tagged: string | null = null;
    if (appt.lead_id) {
      await logActivity(supabase, {
        lead_id: appt.lead_id,
        activity_type: "appointment",
        title: `Call marked ${status}: ${appt.title}`,
        body: str(input.note) || null,
        data: { appointment_id: appt.id, status },
        actor: "agent:operator",
      });
      if (tag) {
        const { data: lead } = await supabase.from("leads").select("*").eq("id", appt.lead_id).single();
        if (lead && !(lead.tags || []).includes(tag)) {
          const tags = Array.from(new Set([...(lead.tags || []), tag]));
          await supabase.from("leads").update({ tags }).eq("id", lead.id);
          await fireTrigger(supabase, { type: "tag_added", lead, data: { tag } });
          tagged = tag;
        }
      }
    }
    return {
      data: { appointment_id: appt.id, status, tagged },
      summary: `Marked "${appt.title}" ${status}${tagged ? ` (+tag ${tagged})` : ""}`,
    };
  },

  async sync_pipeline(input, { supabase }) {
    const dryRun = input.dry_run === true;
    const limit = Math.min(500, Math.max(1, Number(input.limit) || 200));

    // Pull the default pipeline's stages once (New = first, Nurturing = second).
    const { data: stages, error: stageErr } = await supabase
      .from("pipeline_stages")
      .select("id, name, position, pipeline_id")
      .order("position");
    if (stageErr) throw new Error(stageErr.message);
    if (!stages?.length) throw new Error("No pipeline stages configured");
    const stageNew = stages[0];
    const stageNurturing = stages.find((s) => s.name.toLowerCase() === "nurturing") || stages[1] || stages[0];

    // Candidate leads for the sales board.
    let query = supabase
      .from("leads")
      .select("id, email, first_name, last_name, tags, source, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (str(input.tag)) query = query.contains("tags", [str(input.tag)]);
    if (str(input.source)) query = query.eq("source", str(input.source));
    const sinceDays = Number(input.since_days);
    if (Number.isFinite(sinceDays) && sinceDays > 0) {
      query = query.gte("created_at", new Date(Date.now() - sinceDays * 86_400_000).toISOString());
    }
    // Keep bulk-imported list rows off the sales board unless explicitly asked
    // for — they're cold contacts, not inbound deals.
    const targetingImports = input.include_imports === true || str(input.source) === "csv-import";
    if (!targetingImports) {
      query = query.neq("source", "csv-import");
    }
    const { data: leads, error } = await query;
    if (error) throw new Error(error.message);

    const ids = (leads || []).map((l) => l.id);
    const chunk = <T,>(arr: T[], n: number) =>
      Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

    // Which candidates are in a sequence (any enrollment → Nurturing), and which
    // already have an open deal (idempotency).
    const enrolled = new Set<string>();
    const openOppByLead = new Map<string, { id: string; stage_id: string }>();
    for (const part of chunk(ids, 150)) {
      if (!part.length) break;
      const [{ data: en }, { data: opps }] = await Promise.all([
        supabase.from("workflow_enrollments").select("lead_id").in("lead_id", part),
        supabase.from("opportunities").select("id, lead_id, stage_id").eq("status", "open").in("lead_id", part),
      ]);
      (en || []).forEach((e) => enrolled.add(e.lead_id));
      (opps || []).forEach((o) => openOppByLead.set(o.lead_id, { id: o.id, stage_id: o.stage_id }));
    }
    const posById = new Map(stages.map((s) => [s.id, s.position]));

    const toCreate: { lead_id: string; pipeline_id: string; stage_id: string; name: string }[] = [];
    const toAdvance: string[] = []; // opportunity ids: New → Nurturing (already in a sequence)
    let existing = 0;
    for (const lead of leads || []) {
      const wantNurturing = enrolled.has(lead.id);
      const open = openOppByLead.get(lead.id);
      if (open) {
        const curPos = posById.get(open.stage_id) ?? 0;
        if (wantNurturing && stageNurturing.position > curPos) toAdvance.push(open.id);
        else existing++;
        continue;
      }
      const stage = wantNurturing ? stageNurturing : stageNew;
      toCreate.push({
        lead_id: lead.id,
        pipeline_id: stage.pipeline_id,
        stage_id: stage.id,
        name: [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.email,
      });
    }

    const intoNurturing =
      toCreate.filter((c) => c.stage_id === stageNurturing.id).length + toAdvance.length;
    const intoNew = toCreate.filter((c) => c.stage_id === stageNew.id).length;

    if (!dryRun) {
      // Bulk writes — one insert for all new deals, one update for all advances.
      if (toCreate.length) {
        const { error: insErr } = await supabase.from("opportunities").insert(toCreate);
        if (insErr) throw new Error(`Failed to create opportunities: ${insErr.message}`);
      }
      if (toAdvance.length) {
        const { error: updErr } = await supabase
          .from("opportunities")
          .update({ stage_id: stageNurturing.id, pipeline_id: stageNurturing.pipeline_id })
          .in("id", toAdvance);
        if (updErr) throw new Error(`Failed to advance opportunities: ${updErr.message}`);
      }
    }

    const data = {
      dry_run: dryRun,
      scanned: leads?.length || 0,
      created: dryRun ? 0 : toCreate.length,
      would_create: toCreate.length,
      advanced: dryRun ? 0 : toAdvance.length,
      would_advance: toAdvance.length,
      into_new: intoNew,
      into_nurturing: intoNurturing,
      already_had_deal: existing,
    };
    return {
      data,
      summary: dryRun
        ? `Dry run: ${toCreate.length} deal${toCreate.length === 1 ? "" : "s"} to open (${intoNew} New, ${intoNurturing} Nurturing), ${toAdvance.length} to advance across ${data.scanned} leads`
        : `Synced pipeline: opened ${toCreate.length} deal${toCreate.length === 1 ? "" : "s"} (${intoNew} New, ${intoNurturing} Nurturing), advanced ${toAdvance.length}`,
    };
  },

  async list_recent_replies(input, { supabase }) {
    const days = Number.isFinite(Number(input.days)) ? Math.max(1, Number(input.days)) : 7;
    const { data, error } = await supabase
      .from("lead_activities")
      .select("lead_id, title, body, created_at, leads(email, first_name, last_name, score)")
      .eq("activity_type", "email_reply")
      .gte("created_at", new Date(Date.now() - days * 86_400_000).toISOString())
      .order("created_at", { ascending: false })
      .limit(25);
    if (error) throw new Error(error.message);
    const replies = (data || []).map((r) => {
      const lead = r.leads as unknown as { email: string; first_name: string | null; last_name: string | null; score: number } | null;
      return {
        email: lead?.email || null,
        name: [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") || null,
        score: lead?.score ?? null,
        subject: r.title,
        text: r.body,
        at: r.created_at,
      };
    });
    return {
      data: { count: replies.length, days, replies },
      summary: `${replies.length} repl${replies.length === 1 ? "y" : "ies"} in the last ${days}d`,
    };
  },

  async get_content_attribution(input, { supabase }) {
    const limit = Math.min(50, Math.max(1, Number(input.limit) || 15));
    const result = await getContentAttribution(supabase, limit);
    return {
      data: result,
      summary: result.pages.length
        ? `Attribution: ${result.linked_visitors} converted visitors across ${result.pages.length} pages`
        : "No content attribution yet — visitor tracking hasn't linked any sessions to leads",
    };
  },

  async set_subject_test(input, { supabase }) {
    const templateId = str(input.template_id);
    const subjectB = str(input.subject_b);
    if (!templateId || !subjectB) throw new Error("template_id and subject_b are required");
    const { data: tpl, error } = await supabase
      .from("email_templates")
      .select("id, name, subject")
      .eq("id", templateId)
      .single();
    if (error || !tpl) throw new Error("Template not found");
    const { error: updateError } = await supabase
      .from("email_templates")
      .update({ subject_b: subjectB })
      .eq("id", tpl.id);
    if (updateError) {
      if (isMissingAbColumns(updateError.message)) {
        throw new Error("A/B testing isn't enabled yet — migration 018 hasn't been applied to the database");
      }
      throw new Error(updateError.message);
    }
    return {
      data: { template_id: tpl.id, name: tpl.name, subject_a: tpl.subject, subject_b: subjectB },
      summary: `A/B test live on "${tpl.name}" — winner auto-promotes at 30+ sends per variant`,
    };
  },

  async list_subject_tests(_input, { supabase }) {
    const { data: templates, error } = await supabase
      .from("email_templates")
      .select("id, name, subject, subject_b")
      .not("subject_b", "is", null);
    if (error) {
      if (isMissingAbColumns(error.message)) {
        throw new Error("A/B testing isn't enabled yet — migration 018 hasn't been applied to the database");
      }
      throw new Error(error.message);
    }
    const tests = [];
    for (const tpl of templates || []) {
      const { data: sends } = await supabase
        .from("email_sends")
        .select("variant, opened_at")
        .eq("email_template_id", tpl.id)
        .eq("status", "sent")
        .not("variant", "is", null)
        .limit(5000);
      const stats = { a: { sends: 0, opens: 0 }, b: { sends: 0, opens: 0 } };
      for (const s of sends || []) {
        const v = s.variant === "b" ? "b" : "a";
        stats[v].sends++;
        if (s.opened_at) stats[v].opens++;
      }
      tests.push({ template_id: tpl.id, name: tpl.name, subject_a: tpl.subject, subject_b: tpl.subject_b, stats });
    }
    return {
      data: { count: tests.length, tests, promotion_rule: "30+ real sends per variant and a 5+ point open-rate gap" },
      summary: `${tests.length} active subject test${tests.length === 1 ? "" : "s"}`,
    };
  },

  async save_insight(input, { supabase }) {
    const insight = str(input.insight);
    if (insight.length < 10) throw new Error("insight is required — one clear sentence");
    const entry = {
      at: new Date().toISOString(),
      insight,
      evidence: str(input.evidence) || null,
    };
    const { data: row } = await supabase
      .from("backend_settings")
      .select("value")
      .eq("key", "operator_insights")
      .maybeSingle();
    const existing = Array.isArray(row?.value) ? (row.value as unknown[]) : [];
    const insights = [...existing, entry].slice(-200); // keep the newest 200
    const { error } = await supabase
      .from("backend_settings")
      .upsert({ key: "operator_insights", value: insights as Json }, { onConflict: "key" });
    if (error) throw new Error(`Failed to save insight: ${error.message}`);
    return {
      data: { saved: true, total_insights: insights.length },
      summary: `Saved insight: ${insight.slice(0, 60)}${insight.length > 60 ? "…" : ""}`,
    };
  },

  async list_insights(input, { supabase }) {
    const limit = Math.min(100, Math.max(1, Number(input.limit) || 25));
    const { data: row } = await supabase
      .from("backend_settings")
      .select("value")
      .eq("key", "operator_insights")
      .maybeSingle();
    const all = Array.isArray(row?.value) ? (row.value as { at: string; insight: string; evidence: string | null }[]) : [];
    const insights = all.slice(-limit).reverse();
    return {
      data: { count: insights.length, total: all.length, insights },
      summary: insights.length
        ? `${insights.length} insight${insights.length === 1 ? "" : "s"} in memory`
        : "Memory is empty — no insights saved yet",
    };
  },

  async propose_publish(input, { supabase, runId }) {
    const entryId = str(input.calendar_entry_id);
    if (!entryId) throw new Error("calendar_entry_id is required");
    const { data: entry, error } = await supabase
      .from("content_calendar")
      .select("id, title, status, content_object_id")
      .eq("id", entryId)
      .single();
    if (error || !entry) throw new Error("Calendar entry not found");
    if (!entry.content_object_id) throw new Error("No draft written for this entry yet — draft_article first");

    const { data: action, error: insertError } = await supabase
      .from("agent_actions")
      .insert({
        run_id: runId,
        type: "publish",
        title: `Publish: ${entry.title}`,
        summary: str(input.reason) || null,
        payload: { calendar_entry_id: entry.id, article_title: entry.title, reason: str(input.reason) || null } as Json,
      })
      .select("id")
      .single();
    if (insertError || !action) throw new Error(`Failed to queue publish: ${insertError?.message}`);

    return {
      data: { action_id: action.id, status: "proposed" },
      summary: `Proposed publishing "${entry.title}" — waiting for approval`,
    };
  },

  async propose_action(input, { supabase, runId }) {
    const title = str(input.title);
    if (!title) throw new Error("title is required");
    const { data: action, error } = await supabase
      .from("agent_actions")
      .insert({
        run_id: runId,
        type: "other",
        title,
        summary: str(input.description) || null,
        payload: { description: str(input.description) || null } as Json,
      })
      .select("id")
      .single();
    if (error || !action) throw new Error(`Failed to queue action: ${error?.message}`);
    return { data: { action_id: action.id, status: "proposed" }, summary: `Proposed: ${title}` };
  },
};

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const executor = executors[name];
  if (!executor) throw new Error(`Unknown tool: ${name}`);
  return executor(input, ctx);
}
