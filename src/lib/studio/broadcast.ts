/**
 * Studio broadcasts — the weekly-newsletter lane, built on the CRM engine's
 * own rails rather than new sending machinery.
 *
 * Queue:    email template + a DRAFT one-step workflow triggered by a unique
 *           campaign tag. Inert — nothing enrolls, nothing sends.
 * Test:     render the exact email (merge tags, HTML template, unsubscribe
 *           footer) and deliver it to the OWNER's inbox only.
 * Approve:  one database RPC snapshots the audience, applies the campaign
 *           tag, creates the workflow enrollments, and activates the optional
 *           schedule. The engine then delivers over ticks under its send
 *           window, daily budget, reputation guard, and suppression rules.
 */
import type { createAdminClient } from "@/lib/supabase/server";
import { getCrmSettings } from "@/lib/crm/settings";
import { renderEmailHtml } from "@/lib/crm/markdown";
import { renderMergeTags } from "@/lib/crm/merge";
import { extractEmailWithClaude, type ExtractedEmail } from "@/lib/studio/email-extraction";
import type { BroadcastAudienceMode } from "@/lib/studio/broadcast-operation";
import { sendResendRequest } from "@/lib/studio/resend-transport";

export { EmailExtractionError } from "@/lib/studio/email-extraction";
export type { ExtractedEmail } from "@/lib/studio/email-extraction";

type AdminClient = ReturnType<typeof createAdminClient>;

/** Deterministic link audit: bracketed placeholders with no URL, or a body
 *  with a CTA-looking line but zero real links. */
export function linkWarnings(bodyMd: string): string[] {
  const warnings: string[] = [];
  const placeholders = [...bodyMd.matchAll(/\[([^\]\n]+)\](?!\()/g)].map((m) => m[1]);
  for (const p of placeholders) warnings.push(`"[${p}]" has no URL attached — it will render as plain text`);
  if (!/https?:\/\//.test(bodyMd) && /watch|click|link|read more|→/i.test(bodyMd)) {
    warnings.push("The email references a link but contains no URL at all");
  }
  return warnings;
}

/** Real CTA links from brand_context (cta/links) — fed to extraction so
 *  placeholders get resolved to actual URLs. */
export async function ctaLinks(supabase: AdminClient): Promise<string | null> {
  const { data } = await supabase.from("brand_context").select("content").eq("category", "cta").eq("key", "links").maybeSingle();
  return data?.content ?? null;
}

/** Claude pass: pull the final email out of a conversational desk reply. */
export async function extractEmail(raw: string, subjectOverride?: string, cta?: string | null): Promise<ExtractedEmail> {
  return extractEmailWithClaude({
    raw,
    subjectOverride,
    cta,
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
}

/** Count subscribed leads for an explicit audience (tags = OR-overlap). */
export async function audienceCount(
  supabase: AdminClient,
  audienceMode: BroadcastAudienceMode,
  tags: string[],
): Promise<number> {
  let q = supabase.from("leads").select("id", { count: "exact", head: true }).eq("email_status", "subscribed");
  if (audienceMode === "tags") q = q.overlaps("tags", tags);
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** All matching subscribed lead ids, paged past the row cap. */
export async function audienceIds(
  supabase: AdminClient,
  audienceMode: BroadcastAudienceMode,
  tags: string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase
      .from("leads")
      .select("id")
      .eq("email_status", "subscribed")
      .order("id")
      .range(from, from + 999);
    if (audienceMode === "tags") q = q.overlaps("tags", tags);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    ids.push(...data.map((l) => l.id));
    if (data.length < 1000) break;
  }
  return ids;
}

export type BroadcastConfig = {
  source: "studio";
  campaign_tag: string;
  audience_mode: BroadcastAudienceMode;
  tags: string[];
  all: boolean;
  estimated: number;
  scheduled_at: string | null;
};

type RpcResult = { data: unknown; error: { message: string } | null };
type BroadcastRpcClient = { rpc: (name: string, args: Record<string, unknown>) => Promise<RpcResult> };
const broadcastRpc = (supabase: AdminClient) => supabase as unknown as BroadcastRpcClient;

export type BroadcastOperationResult = {
  state: "ready";
  workflow_id: string;
  template_id: string;
  subject: string;
  estimated: number;
  campaign_tag: string;
};

export type BroadcastClaimResult =
  | BroadcastOperationResult
  | { state: "claimed" | "busy" | "conflict" };

export async function claimBroadcastOperation(
  supabase: AdminClient,
  operationId: string,
  payloadHash: string,
  claimToken: string,
): Promise<BroadcastClaimResult> {
  const { data, error } = await broadcastRpc(supabase).rpc("studio_claim_broadcast_operation", {
    p_operation_id: operationId,
    p_payload_hash: payloadHash,
    p_claim_token: claimToken,
  });
  if (error) throw new Error(error.message);
  return data as BroadcastClaimResult;
}

export async function releaseBroadcastOperation(
  supabase: AdminClient,
  operationId: string,
  payloadHash: string,
  claimToken: string,
) {
  await broadcastRpc(supabase).rpc("studio_release_broadcast_operation", {
    p_operation_id: operationId,
    p_payload_hash: payloadHash,
    p_claim_token: claimToken,
  });
}

export async function finalizeBroadcastOperation(
  supabase: AdminClient,
  input: {
    operationId: string;
    payloadHash: string;
    claimToken: string;
    email: ExtractedEmail;
    audienceMode: BroadcastAudienceMode;
    tags: string[];
    campaignIntent: string;
    scheduledAt: string | null;
  },
): Promise<BroadcastOperationResult> {
  const { data, error } = await broadcastRpc(supabase).rpc("studio_finalize_broadcast_operation", {
    p_operation_id: input.operationId,
    p_payload_hash: input.payloadHash,
    p_claim_token: input.claimToken,
    p_email: input.email,
    p_audience_mode: input.audienceMode,
    p_tags: input.tags,
    p_campaign_intent: input.campaignIntent,
    p_scheduled_at: input.scheduledAt,
  });
  if (error) throw new Error(error.message);
  return data as BroadcastOperationResult;
}

type BroadcastDecisionRpcResult = {
  state?: "applied" | "replayed" | "conflict" | "not_found";
  decision?: "approve" | "reject";
  decision_operation_id?: string;
  enrolled?: number;
  reason?: string;
};

/** Approve/reject through one transactional, idempotent database boundary.
 *  A retry with the same decision operation returns its canonical receipt;
 *  every independent decision conflicts after the first one commits. */
export async function decideBroadcast(
  supabase: AdminClient,
  workflowId: string,
  decision: "approve" | "reject",
  decisionOperationId: string,
): Promise<{ ok: true; state: "applied" | "replayed"; decision: "approve" | "reject"; enrolled: number } | { error: string; status?: number }> {
  const { data, error } = await broadcastRpc(supabase).rpc("studio_decide_broadcast_operation", {
    p_workflow_id: workflowId,
    p_decision: decision,
    p_decision_operation_id: decisionOperationId,
  });
  if (error) return { error: error.message, status: 500 };

  const result = data as BroadcastDecisionRpcResult | null;
  if (!result || typeof result !== "object") {
    return { error: "The broadcast decision did not return a valid database receipt", status: 500 };
  }
  if (result.state === "not_found") return { error: "Broadcast not found", status: 404 };
  if (result.state === "conflict") {
    return {
      error: typeof result.reason === "string" && result.reason.trim()
        ? result.reason
        : "This broadcast has already been decided in another request",
      status: 409,
    };
  }
  if (
    (result.state !== "applied" && result.state !== "replayed")
    || result.decision !== decision
    || result.decision_operation_id !== decisionOperationId
    || typeof result.enrolled !== "number"
    || !Number.isInteger(result.enrolled)
    || result.enrolled < 0
  ) {
    return { error: "The broadcast decision returned an incomplete database receipt", status: 500 };
  }
  return {
    ok: true,
    state: result.state,
    decision: result.decision,
    enrolled: result.enrolled,
  };
}

/** Test send: the exact email, rendered for real, to the OWNER's inbox only. */
export async function sendTestEmail(
  supabase: AdminClient,
  email: ExtractedEmail
): Promise<{ ok: true; to: string } | { error: string }> {
  const cfg = await getCrmSettings(supabase);
  const owner = cfg.sender.reply_to || cfg.sender.from_email;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { error: "RESEND_API_KEY not configured" };

  // Merge tags render against the owner as a stand-in lead.
  const standIn = { first_name: cfg.sender.from_name?.split(" ")[0] || "there", email: owner } as Parameters<
    typeof renderMergeTags
  >[1];
  const html = renderEmailHtml({
    bodyMd:
      `> **Test send** — how this lands in an inbox. Links are live; nothing has gone to any lead.\n\n---\n\n` +
      renderMergeTags(email.body_md, standIn),
    preheader: email.preheader ? renderMergeTags(email.preheader, standIn) : null,
    sender: cfg.sender,
    unsubscribeUrl: "#test-send-no-unsubscribe",
  });
  const res = await sendResendRequest(apiKey, {
    from: `${cfg.sender.from_name} <${cfg.sender.from_email}>`,
    to: [owner],
    subject: `[Test] ${renderMergeTags(email.subject, standIn)}`,
    html,
    reply_to: owner,
  });
  return res.ok ? { ok: true, to: owner } : { error: res.error };
}
