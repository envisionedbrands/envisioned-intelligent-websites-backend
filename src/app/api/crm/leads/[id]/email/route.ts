/**
 * POST /api/crm/leads/[id]/email — send a one-off email to a lead via Resend
 *
 * Body: { subject: string, body: string, from_name?: string }
 *
 * Looks up the lead by ID, sends the email through Resend using the branded
 * email shell, and logs the send on the lead's activity timeline. This is for
 * manual/one-off sends only — it does NOT touch sequences or automations.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { logActivity } from "@/lib/crm/activity";
import { renderEmailHtml } from "@/lib/crm/markdown";
import { renderMergeTags, unsubscribeUrl, unsubscribeOneClickUrl } from "@/lib/crm/merge";
import { getCrmSettings } from "@/lib/crm/settings";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const bodyMd = typeof body.body === "string" ? body.body.trim() : "";
  if (!subject) return NextResponse.json({ error: "subject is required" }, { status: 400 });
  if (!bodyMd) return NextResponse.json({ error: "body is required" }, { status: 400 });

  const supabase = createAdminClient();
  const { data: lead, error: leadErr } = await supabase
    .from("leads")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (leadErr) return NextResponse.json({ error: leadErr.message }, { status: 500 });
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  if (!lead.email) return NextResponse.json({ error: "Lead has no email address" }, { status: 400 });

  const cfg = await getCrmSettings(supabase);
  const actor = auth.mode === "session" ? "human" : `agent:${auth.agent}`;

  // Render merge tags in subject and body
  const renderedSubject = renderMergeTags(subject, lead);
  const renderedBody = renderMergeTags(bodyMd, lead);

  // Build the branded HTML shell
  const unsub = unsubscribeUrl(lead);
  const unsubOneClick = unsubscribeOneClickUrl(lead);
  const fromName = body.from_name || cfg.sender.from_name;
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
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${fromName} <${cfg.sender.from_email}>`,
        to: [lead.email],
        subject: renderedSubject,
        html,
        reply_to: cfg.sender.reply_to || cfg.sender.from_email,
        headers: {
          "List-Unsubscribe": `<${unsubOneClick}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
    });

    const payload = (await res.json().catch(() => ({}))) as { id?: string; message?: string };

    if (!res.ok) {
      const errMsg = payload.message || `Resend responded ${res.status}`;

      // Log the failed attempt on the timeline so it's visible
      await logActivity(supabase, {
        lead_id: lead.id,
        activity_type: "email_failed",
        title: `Email failed: ${renderedSubject}`,
        body: errMsg,
        data: { subject: renderedSubject, error: errMsg },
        actor,
      });

      return NextResponse.json({ error: errMsg }, { status: 502 });
    }

    // Record the send in email_sends
    await supabase.from("email_sends").insert({
      lead_id: lead.id,
      email_address: lead.email,
      subject: renderedSubject,
      status: "sent",
      body_html: html,
      resend_id: payload.id ?? null,
      sent_at: new Date().toISOString(),
    });

    // Log on the lead timeline
    const bodyPreview = renderedBody.length > 200 ? renderedBody.slice(0, 200) + "…" : renderedBody;
    await logActivity(supabase, {
      lead_id: lead.id,
      activity_type: "email_sent",
      title: `Email sent: ${renderedSubject}`,
      body: bodyPreview,
      data: { resend_id: payload.id, one_off: true },
      actor,
    });

    return NextResponse.json({ sent: true, message_id: payload.id });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "Unknown send error";
    return NextResponse.json({ error: errMsg }, { status: 500 });
  }
}
