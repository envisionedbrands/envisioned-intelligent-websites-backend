/**
 * POST /api/email/send — send a one-off email by address via Resend
 *
 * Body: { to: string, subject: string, body: string, from_name?: string }
 *
 * If the recipient email matches a CRM lead, the send is logged on that lead's
 * activity timeline. Works even when the recipient is NOT in the CRM.
 * This is for manual/one-off sends only — no sequences, no automations.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { logActivity } from "@/lib/crm/activity";
import { renderEmailHtml } from "@/lib/crm/markdown";
import { renderMergeTags } from "@/lib/crm/merge";
import { getCrmSettings } from "@/lib/crm/settings";
import { unsubscribeUrl, unsubscribeOneClickUrl } from "@/lib/crm/merge";
import type { Lead } from "@/lib/crm/types";

export async function POST(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const body = await request.json().catch(() => ({}));

  const to = typeof body.to === "string" ? body.to.trim().toLowerCase() : "";
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const bodyMd = typeof body.body === "string" ? body.body.trim() : "";

  if (!to) return NextResponse.json({ error: "to is required" }, { status: 400 });
  if (!subject) return NextResponse.json({ error: "subject is required" }, { status: 400 });
  if (!bodyMd) return NextResponse.json({ error: "body is required" }, { status: 400 });

  const supabase = createAdminClient();
  const cfg = await getCrmSettings(supabase);
  const actor = auth.mode === "session" ? "human" : `agent:${auth.agent}`;

  // Try to find a matching lead for activity logging
  const { data: lead } = await supabase
    .from("leads")
    .select("*")
    .eq("email", to)
    .maybeSingle();

  // Render merge tags only if we have a lead, otherwise use raw text
  const renderedSubject = lead ? renderMergeTags(subject, lead as Lead) : subject;
  const renderedBody = lead ? renderMergeTags(bodyMd, lead as Lead) : bodyMd;
  const fromName = body.from_name || cfg.sender.from_name;

  // Build unsubscribe links only if lead exists (has a token)
  const unsub = lead ? unsubscribeUrl(lead as Lead) : "";
  const unsubOneClick = lead ? unsubscribeOneClickUrl(lead as Lead) : "";

  const html = renderEmailHtml({
    bodyMd: renderedBody,
    preheader: null,
    sender: { ...cfg.sender, from_name: fromName },
    unsubscribeUrl: unsub,
  });

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "RESEND_API_KEY not configured" }, { status: 500 });
  }

  try {
    const emailPayload: Record<string, unknown> = {
      from: `${fromName} <${cfg.sender.from_email}>`,
      to: [to],
      subject: renderedSubject,
      html,
      reply_to: cfg.sender.reply_to || cfg.sender.from_email,
    };

    // Only add unsubscribe headers when we have a lead (with a valid token)
    if (lead) {
      emailPayload.headers = {
        "List-Unsubscribe": `<${unsubOneClick}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      };
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(emailPayload),
    });

    const payload = (await res.json().catch(() => ({}))) as { id?: string; message?: string };

    if (!res.ok) {
      const errMsg = payload.message || `Resend responded ${res.status}`;

      // Log failure on lead timeline if lead exists
      if (lead) {
        await logActivity(supabase, {
          lead_id: lead.id,
          activity_type: "email_failed",
          title: `Email failed: ${renderedSubject}`,
          body: errMsg,
          data: { subject: renderedSubject, error: errMsg },
          actor,
        });
      }

      return NextResponse.json({ error: errMsg }, { status: 502 });
    }

    // Record in email_sends if we have a lead
    if (lead) {
      await supabase.from("email_sends").insert({
        lead_id: lead.id,
        email_address: to,
        subject: renderedSubject,
        status: "sent",
        body_html: html,
        resend_id: payload.id ?? null,
        sent_at: new Date().toISOString(),
      });

      const bodyPreview = renderedBody.length > 200 ? renderedBody.slice(0, 200) + "…" : renderedBody;
      await logActivity(supabase, {
        lead_id: lead.id,
        activity_type: "email_sent",
        title: `Email sent: ${renderedSubject}`,
        body: bodyPreview,
        data: { resend_id: payload.id, one_off: true },
        actor,
      });
    }

    return NextResponse.json({
      sent: true,
      message_id: payload.id,
      lead_found: !!lead,
      lead_id: lead?.id ?? null,
    });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "Unknown send error";
    return NextResponse.json({ error: errMsg }, { status: 500 });
  }
}
