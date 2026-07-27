/**
 * Execution side of the approvals queue. Approving an action hands it to the
 * existing send/publish paths. Safe mode (crm_safe_mode) is respected the
 * whole way down: an approved email routes to the OWNER's inbox as a preview
 * — never to the real lead — and is recorded in email_sends as 'simulated'.
 */
import { getCrmSettings } from "@/lib/crm/settings";
import { sendCrmEmail } from "@/lib/crm/email";
import { renderMergeTags, unsubscribeUrl } from "@/lib/crm/merge";
import { renderEmailHtml } from "@/lib/crm/markdown";
import { logActivity } from "@/lib/crm/activity";
import type { AdminClient } from "@/lib/crm/types";
import type { Json, Tables } from "@/types/database";

export type AgentAction = Tables<"agent_actions">;

interface EmailPayload {
  lead_id: string;
  email: string;
  subject: string;
  preheader: string | null;
  body_md: string;
  reason: string | null;
}

interface PublishPayload {
  calendar_entry_id: string;
  article_title: string;
}

interface WorkflowPayload {
  workflow_id: string;
  workflow_name: string;
}

export async function executeAgentAction(
  supabase: AdminClient,
  action: AgentAction
): Promise<Json> {
  if (action.type === "email") return executeEmail(supabase, action);
  if (action.type === "publish") return executePublish(supabase, action);
  if (action.type === "workflow") return executeWorkflowActivation(supabase, action);
  // 'other' actions are informational to-dos — approving acknowledges them.
  return { acknowledged: true };
}

async function executeEmail(supabase: AdminClient, action: AgentAction): Promise<Json> {
  const payload = action.payload as unknown as EmailPayload;
  const { data: lead, error } = await supabase
    .from("leads")
    .select("*")
    .eq("id", payload.lead_id)
    .single();
  if (error || !lead) throw new Error("Lead no longer exists");

  const cfg = await getCrmSettings(supabase);

  if (!cfg.safe_mode) {
    // Live mode: the normal CRM send path (suppression, logging, Resend)
    const result = await sendCrmEmail(supabase, {
      lead,
      subject: payload.subject,
      bodyMd: payload.body_md,
      preheader: payload.preheader,
      actor: "agent:operator",
    });
    if (result.status === "failed") throw new Error(result.error || "Send failed");
    return { mode: "live", ...result } as unknown as Json;
  }

  // Safe mode: render the real email but deliver it to the OWNER as a preview
  const subject = renderMergeTags(payload.subject, lead);
  const bodyMd =
    `> **Safe mode preview** — this approved email was routed to you instead of **${lead.email}**. Nothing was sent to them.\n\n---\n\n` +
    renderMergeTags(payload.body_md, lead);
  const html = renderEmailHtml({
    bodyMd,
    preheader: payload.preheader ? renderMergeTags(payload.preheader, lead) : null,
    sender: cfg.sender,
    unsubscribeUrl: unsubscribeUrl(lead),
  });

  const owner = cfg.sender.reply_to || cfg.sender.from_email;
  const apiKey = process.env.RESEND_API_KEY;
  let delivered = false;
  let deliveryError: string | null = null;

  if (apiKey) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${cfg.sender.from_name} <${cfg.sender.from_email}>`,
        to: [owner],
        subject: `[Preview → ${lead.email}] ${subject}`,
        html,
        reply_to: cfg.sender.reply_to || cfg.sender.from_email,
      }),
    });
    if (res.ok) {
      delivered = true;
    } else {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      deliveryError = body.message || `Resend responded ${res.status}`;
    }
  } else {
    deliveryError = "RESEND_API_KEY not configured — preview recorded only";
  }

  // Record against the lead as a simulated send, same as the engine does
  const { data: send } = await supabase
    .from("email_sends")
    .insert({
      lead_id: lead.id,
      email_address: lead.email,
      subject,
      status: "simulated",
      body_html: html,
      sent_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  await logActivity(supabase, {
    lead_id: lead.id,
    activity_type: "email_sent",
    title: `Simulated (safe mode, agent-drafted): ${subject}`,
    data: { send_id: send?.id, agent_action_id: action.id, preview_to: owner, simulated: true },
    actor: "agent:operator",
  });

  return {
    mode: "safe",
    status: "simulated",
    preview_sent_to: delivered ? owner : null,
    intended_recipient: lead.email,
    send_id: send?.id ?? null,
    error: deliveryError,
  };
}

async function executeWorkflowActivation(
  supabase: AdminClient,
  action: AgentAction
): Promise<Json> {
  const payload = action.payload as unknown as WorkflowPayload;
  const { data: workflow, error } = await supabase
    .from("workflows")
    .select("id, name, status, trigger_type")
    .eq("id", payload.workflow_id)
    .single();
  if (error || !workflow) throw new Error("Workflow no longer exists");
  if (workflow.status === "archived") throw new Error(`"${workflow.name}" is archived — can't activate`);
  if (workflow.status === "active") {
    return { activated: true, already_active: true, workflow_id: workflow.id, name: workflow.name };
  }

  const { error: updateError } = await supabase
    .from("workflows")
    .update({ status: "active" })
    .eq("id", workflow.id);
  if (updateError) throw new Error(`Activation failed: ${updateError.message}`);

  // Enrollment happens via triggers (or manual enrollment) from here on; the
  // engine tick sends the emails — simulated while crm_safe_mode is on.
  return {
    activated: true,
    workflow_id: workflow.id,
    name: workflow.name,
    trigger_type: workflow.trigger_type,
    activated_at: new Date().toISOString(),
  };
}

async function executePublish(supabase: AdminClient, action: AgentAction): Promise<Json> {
  const payload = action.payload as unknown as PublishPayload;
  const { data: entry, error } = await supabase
    .from("content_calendar")
    .select("id, title, content_object_id")
    .eq("id", payload.calendar_entry_id)
    .single();
  if (error || !entry) throw new Error("Calendar entry not found");
  if (!entry.content_object_id) throw new Error("No written draft linked to this entry");

  const publishedAt = new Date().toISOString();
  const { data: article, error: publishError } = await supabase
    .from("content_objects")
    .update({ status: "published", published_at: publishedAt })
    .eq("id", entry.content_object_id)
    .select("id, slug, title")
    .single();
  if (publishError || !article) {
    throw new Error(`Publish failed: ${publishError?.message || "article not found"}`);
  }

  await supabase.from("content_calendar").update({ status: "published" }).eq("id", entry.id);

  return { published: true, slug: article.slug, title: article.title, published_at: publishedAt };
}
