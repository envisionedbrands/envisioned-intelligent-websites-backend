/**
 * Personalized first-touch batches. For each matched lead we make an
 * INDIVIDUAL AI copywriting call — using whatever your forms actually captured
 * about them (leads.custom) when there's enough to work with, light
 * name/source personalization when there isn't — and file each email as its
 * own agent_actions proposal stamped with a shared batch_id. Nothing here
 * sends anything; approval (safe-mode aware) does that.
 *
 * The richer your capture forms, the better these emails get: every extra
 * question you ask on an opt-in lands in `custom` and becomes material here.
 */
import { callClaudeStructured, loadOffers, SEQUENCE_CRAFT_RULES } from "@/lib/crm/ai";
import { getCrmSettings } from "@/lib/crm/settings";
import { routeOfferForLead } from "@/lib/crm/offers";
import { BRAND_DIGEST } from "./prompt";
import type { AdminClient } from "@/lib/crm/types";
import type { Json, Tables } from "@/types/database";

const MAX_BATCH = 25;
const PARALLEL_WAVE = 5; // concurrent copy calls (Workers cap simultaneous connections)
const DEFAULT_SKIP_EMAILED_DAYS = 7;

type Lead = Tables<"leads">;

export interface BatchInput {
  campaign_intent: string;
  tag?: string;
  since_days?: number;
  emails?: string[];
  max_leads?: number;
  skip_emailed_days?: number;
}

export interface BatchResult {
  batch_id: string;
  drafted: { email: string; subject: string; personalization: "detailed" | "light" }[];
  skipped: { email: string; reason: string }[];
  matched: number;
}

interface DraftedEmail {
  subject: string;
  preheader: string;
  body_md: string;
  why_this_lead: string;
}

const BATCH_EMAIL_SCHEMA = {
  type: "object",
  required: ["subject", "preheader", "body_md", "why_this_lead"],
  properties: {
    subject: { type: "string", description: "Subject line, under 50 chars, sentence case" },
    preheader: { type: "string", description: "Inbox preview text, under 90 chars" },
    body_md: {
      type: "string",
      description: "Markdown email body with merge tags like {{first_name|there}} and ONE CTA link on its own line",
    },
    why_this_lead: {
      type: "string",
      description: "One line for the owner's approval queue: why this email fits THIS lead specifically",
    },
  },
} as const;

/**
 * Bookkeeping keys the capture pipeline writes into `custom` — real answers
 * only, so the copywriter never "personalizes" off a UTM parameter.
 */
const NON_ANSWER_KEYS = new Set([
  "raw",
  "ip",
  "user_agent",
  "referrer",
  "session_id",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "form",
  "page",
  "consent",
]);

/**
 * Whatever your forms captured about this lead, rendered for the copywriter.
 * Needs at least three real answers before it counts as detailed — below that
 * the model starts inventing, and light-and-honest beats confident-and-wrong.
 */
function capturedProfile(custom: Record<string, unknown>): string | null {
  const nested = (custom.raw && typeof custom.raw === "object" ? custom.raw : {}) as Record<string, unknown>;
  const merged = { ...custom, ...nested };
  const lines = Object.entries(merged)
    .filter(([k, v]) => !NON_ANSWER_KEYS.has(k) && typeof v === "string" && v.trim().length > 0)
    .slice(0, 12)
    .map(([k, v]) => `- ${k.replace(/_/g, " ")}: ${String(v).slice(0, 300)}`);
  return lines.length >= 3 ? lines.join("\n") : null;
}

function leadProfile(lead: Lead): { block: string; personalization: "detailed" | "light" } {
  const custom = (lead.custom && typeof lead.custom === "object" ? lead.custom : {}) as Record<
    string,
    unknown
  >;
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || "(no name)";
  const captured = capturedProfile(custom);
  if (captured) {
    return {
      personalization: "detailed",
      block:
        `Name: ${name}\nSource: ${lead.source || "unknown"}\nTags: ${(lead.tags || []).join(", ") || "none"}\n\n` +
        `What they told us when they opted in — their ACTUAL words (use their situation, echo their language — this is the whole point):\n${captured}`,
    };
  }
  return {
    personalization: "light",
    block:
      `Name: ${name}\nCompany: ${lead.company || "unknown"}\nSource: ${lead.source || "unknown"}\n` +
      `Tags: ${(lead.tags || []).join(", ") || "none"}\n\n` +
      `Nothing captured beyond the basics — keep personalization light and honest (their name, how they connected). Do NOT invent details about their business or situation.`,
  };
}

function batchSystemPrompt(offers: string, senderName: string): string {
  return `You are ${senderName} writing a one-to-one first-touch email to a single lead in your CRM. You write in ${senderName}'s voice, to someone who gave you their email.

${BRAND_DIGEST}

## Active offers (real CTA destinations — pick ONE that fits the campaign)
${offers}
${SEQUENCE_CRAFT_RULES}
## This task
Write ONE email for ONE specific lead (profile in the user message). Where they told us about their situation, anchor the email in THEIR stated goal or blocker in their words — never generic merge-tag boilerplate. Where they didn't, keep it light and human. Never invent facts about them. Also return why_this_lead: one plain line for the owner's approvals queue saying why this email fits this lead.

CTA rule: use ONE call to action, and only a destination that exists — the recommended offer's CTA, a reply to this email, or a booking link. Never send someone back to the opt-in they already completed.`;
}

/** Matched leads for a batch: subscribed only, filtered, capped. */
async function matchLeads(supabase: AdminClient, input: BatchInput): Promise<Lead[]> {
  const cap = Math.min(MAX_BATCH, Math.max(1, Number(input.max_leads) || MAX_BATCH));
  let query = supabase
    .from("leads")
    .select("*")
    .eq("email_status", "subscribed")
    .order("created_at", { ascending: false })
    .limit(cap);
  if (input.tag) query = query.contains("tags", [input.tag]);
  if (Number.isFinite(Number(input.since_days)) && Number(input.since_days) > 0) {
    query = query.gte(
      "created_at",
      new Date(Date.now() - Number(input.since_days) * 86_400_000).toISOString()
    );
  }
  if (Array.isArray(input.emails) && input.emails.length > 0) {
    query = query.in(
      "email",
      input.emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean)
    );
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

/** Lead ids emailed (sent or simulated) in the last N days — skip these. */
async function recentlyEmailedIds(
  supabase: AdminClient,
  leadIds: string[],
  days: number
): Promise<Set<string>> {
  if (leadIds.length === 0 || days <= 0) return new Set();
  const { data } = await supabase
    .from("email_sends")
    .select("lead_id")
    .in("lead_id", leadIds)
    .in("status", ["sent", "simulated"])
    .gte("created_at", new Date(Date.now() - days * 86_400_000).toISOString());
  return new Set((data || []).map((r) => r.lead_id).filter((id): id is string => !!id));
}

export async function draftPersonalizedBatch(
  supabase: AdminClient,
  runId: string,
  input: BatchInput
): Promise<BatchResult> {
  const intent = String(input.campaign_intent || "").trim();
  if (intent.length < 10) {
    throw new Error("campaign_intent is required — what is this batch trying to achieve?");
  }
  if (!input.tag && !input.since_days && !(Array.isArray(input.emails) && input.emails.length)) {
    throw new Error("Provide a lead filter: tag, since_days, or an explicit emails list");
  }

  const leads = await matchLeads(supabase, input);
  if (leads.length === 0) throw new Error("No subscribed leads matched that filter");

  const skipDays = Number.isFinite(Number(input.skip_emailed_days))
    ? Math.max(0, Number(input.skip_emailed_days))
    : DEFAULT_SKIP_EMAILED_DAYS;
  const recentIds = await recentlyEmailedIds(
    supabase,
    leads.map((l) => l.id),
    skipDays
  );

  const skipped: BatchResult["skipped"] = [];
  const targets = leads.filter((lead) => {
    if (recentIds.has(lead.id)) {
      skipped.push({ email: lead.email, reason: `emailed in the last ${skipDays}d` });
      return false;
    }
    return true;
  });
  if (targets.length === 0) {
    throw new Error(`All ${leads.length} matched leads were emailed in the last ${skipDays} days`);
  }

  const batchId = crypto.randomUUID();
  const offers = await loadOffers(supabase);
  const { sender } = await getCrmSettings(supabase);
  const system = batchSystemPrompt(offers, sender.from_name);
  const drafted: BatchResult["drafted"] = [];

  // Waves of parallel copy calls — each lead gets an individual email
  for (let i = 0; i < targets.length; i += PARALLEL_WAVE) {
    const wave = targets.slice(i, i + PARALLEL_WAVE);
    const results = await Promise.allSettled(
      wave.map(async (lead) => {
        const profile = leadProfile(lead);
        const route = await routeOfferForLead(supabase, lead);
        const { result } = await callClaudeStructured<DraftedEmail>(
          system,
          `Campaign intent: ${intent}\n\n## The lead\n${profile.block}\n\n` +
            `Recommended tier for this lead: ${route.tier} — ${route.reason}. ` +
            `Only pitch a tier if the campaign intent calls for it; the safe CTA is ${route.cta_url}.`,
          BATCH_EMAIL_SCHEMA,
          2048
        );
        if (!result.subject || !result.body_md) throw new Error("empty copy returned");
        return { lead, profile, email: result };
      })
    );

    for (const [idx, settled] of results.entries()) {
      const lead = wave[idx];
      if (settled.status === "rejected") {
        const reason = settled.reason instanceof Error ? settled.reason.message : "copy generation failed";
        skipped.push({ email: lead.email, reason });
        continue;
      }
      const { profile, email } = settled.value;
      const { error } = await supabase.from("agent_actions").insert({
        run_id: runId,
        type: "email",
        title: `Email ${lead.email}: ${email.subject}`,
        summary: email.why_this_lead || null,
        payload: {
          batch_id: batchId,
          batch_label: intent,
          personalization: profile.personalization,
          lead_id: lead.id,
          email: lead.email,
          subject: email.subject,
          preheader: email.preheader || null,
          body_md: email.body_md,
          reason: email.why_this_lead || null,
        } as Json,
      });
      if (error) {
        skipped.push({ email: lead.email, reason: `queue insert failed: ${error.message}` });
      } else {
        drafted.push({
          email: lead.email,
          subject: email.subject,
          personalization: profile.personalization,
        });
      }
    }
  }

  if (drafted.length === 0) {
    throw new Error(`Drafted nothing — all ${targets.length} leads failed: ${skipped.map((s) => s.reason)[0]}`);
  }
  return { batch_id: batchId, drafted, skipped, matched: leads.length };
}
