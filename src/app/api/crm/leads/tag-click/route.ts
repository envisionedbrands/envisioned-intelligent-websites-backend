/**
 * GET /api/crm/leads/tag-click?email=X&tag=Y&redirect=Z
 *
 * Public endpoint designed to be clicked from email buttons. Looks up the lead
 * by email, adds the self-identifier tag, logs an activity, fires the
 * tag_added trigger (so downstream workflows can react), and 302-redirects the
 * browser to the `redirect` URL.
 *
 * No auth required — but validates that:
 *   1. email exists in the CRM
 *   2. tag is in the allowed list (prevents abuse)
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { logActivity } from "@/lib/crm/activity";
import { fireTrigger } from "@/lib/crm/engine";
import { normalizeEmail } from "@/lib/crm/leads";

const ALLOWED_TAGS = new Set([
  "ai-level-1",
  "ai-level-2",
  "ai-level-3",
  "used-free-trial",
]);

// Minimal fallback page shown when the redirect can't be performed.
function errorPage(message: string): Response {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Envisioned</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e5e5e5}
.card{max-width:420px;text-align:center;padding:2rem}.card h1{font-size:1.25rem;margin-bottom:.75rem}.card p{color:#999;font-size:.9rem}</style>
</head><body><div class="card"><h1>Something went wrong</h1><p>${message}</p></div></body></html>`;
  return new Response(html, {
    status: 400,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const rawEmail = params.get("email");
  const tag = params.get("tag");
  const redirect = params.get("redirect");

  // ── Validate inputs ───────────────────────────────────────────────────────

  if (!rawEmail || !tag || !redirect) {
    return errorPage("Missing required parameters.");
  }

  if (!ALLOWED_TAGS.has(tag)) {
    return errorPage("That tag is not recognised.");
  }

  // Basic redirect URL validation — must be https to prevent open-redirect abuse
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirect);
    if (redirectUrl.protocol !== "https:") {
      return errorPage("Redirect URL must use HTTPS.");
    }
  } catch {
    return errorPage("Invalid redirect URL.");
  }

  const email = normalizeEmail(rawEmail);

  // ── Look up lead ──────────────────────────────────────────────────────────

  const supabase = createAdminClient();

  const { data: lead, error: lookupError } = await supabase
    .from("leads")
    .select("*")
    .ilike("email", email.replace(/[%_]/g, "\\$&"))
    .limit(1)
    .maybeSingle();

  if (lookupError) {
    console.error("tag-click lookup error:", lookupError.message);
    return errorPage("Something went wrong. Please try again.");
  }

  if (!lead) {
    // Don't reveal whether an email is in the system — redirect anyway
    return NextResponse.redirect(redirectUrl.toString(), 302);
  }

  // ── Add the tag (if not already present) ──────────────────────────────────

  const existingTags: string[] = lead.tags || [];
  const alreadyTagged = existingTags.includes(tag);

  if (!alreadyTagged) {
    const newTags = [...existingTags, tag];

    const { error: updateError } = await supabase
      .from("leads")
      .update({
        tags: newTags,
        last_activity_at: new Date().toISOString(),
      })
      .eq("id", lead.id);

    if (updateError) {
      console.error("tag-click update error:", updateError.message);
      // Still redirect — partial failure is better than a dead link
      return NextResponse.redirect(redirectUrl.toString(), 302);
    }

    // Log activity
    await logActivity(supabase, {
      lead_id: lead.id,
      activity_type: "self_identified",
      title: `Self-identified as: ${tag}`,
      data: { tag, source: "email_click", redirect: redirect },
      actor: "system",
    });

    // Fire tag_added trigger so any downstream workflows can react
    const updatedLead = { ...lead, tags: newTags };
    await fireTrigger(supabase, {
      type: "tag_added",
      lead: updatedLead,
      data: { tag },
    });
  } else {
    // Already tagged — still log the click (useful for engagement tracking)
    await logActivity(supabase, {
      lead_id: lead.id,
      activity_type: "tag_click_repeat",
      title: `Clicked self-identifier again: ${tag}`,
      data: { tag, source: "email_click", redirect: redirect },
      actor: "system",
    });
  }

  // ── Redirect ──────────────────────────────────────────────────────────────

  return NextResponse.redirect(redirectUrl.toString(), 302);
}
