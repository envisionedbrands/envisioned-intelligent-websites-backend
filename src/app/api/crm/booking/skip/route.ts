/**
 * POST /api/crm/booking/skip — call off one sequence step for one booking.
 *
 *   { step: "thank_you", email: "someone@example.com" }
 *   { step: "thank_you", appointment_id: "uuid" }
 *   { step: "thank_you", email: "...", undo: true }
 *
 * Why this exists: MI asked whether she could tell me — or tell the Telegram
 * bot — not to send the thank-you to a particular person. She can. Every step
 * is gated on a `*_sent_at` stamp, so writing the stamp without sending marks
 * it covered and the engine skips it forever. Undo clears the stamp, which
 * re-arms the step if its window is still open.
 *
 * Deliberately NOT a "cancel the whole sequence" switch: the 1h and 5min
 * reminders carry the join link, and silently disabling those is how someone
 * ends up sitting in the wrong place at the right time.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";

const STEP_COLUMNS: Record<string, string> = {
  confirmation: "confirmation_sent_at",
  reminder_24h: "reminder_24h_sent_at",
  reminder_12h: "reminder_12h_sent_at",
  reminder_1h: "reminder_1h_sent_at",
  reminder_5min: "reminder_5min_sent_at",
  thank_you: "thank_you_sent_at",
};

export async function POST(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  let body: { step?: string; email?: string; appointment_id?: string; undo?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const step = (body.step || "").trim();
  const column = STEP_COLUMNS[step];
  if (!column) {
    return NextResponse.json(
      { error: `Unknown step. One of: ${Object.keys(STEP_COLUMNS).join(", ")}` },
      { status: 400 }
    );
  }

  const supabase = createAdminClient();

  // Resolve which bookings we're talking about.
  let query = supabase
    .from("appointments")
    .select("id, title, starts_at, lead_id, leads(email)")
    .eq("status", "scheduled")
    .gte("starts_at", new Date(Date.now() - 48 * 3600000).toISOString());

  if (body.appointment_id) {
    query = query.eq("id", body.appointment_id);
  } else if (body.email) {
    const { data: lead } = await supabase
      .from("leads")
      .select("id")
      .eq("email", body.email.trim().toLowerCase())
      .maybeSingle();
    if (!lead) return NextResponse.json({ error: "No lead with that email" }, { status: 404 });
    query = query.eq("lead_id", lead.id);
  } else {
    return NextResponse.json({ error: "email or appointment_id required" }, { status: 400 });
  }

  const { data: appts, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!appts?.length) {
    return NextResponse.json({ error: "No upcoming booking found for that person" }, { status: 404 });
  }

  const stamp = body.undo ? null : new Date().toISOString();
  const ids = appts.map((a) => a.id);
  const { error: updateError } = await supabase
    .from("appointments")
    .update({ [column]: stamp })
    .in("id", ids);
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    action: body.undo ? "re-armed" : "skipped",
    step,
    affected: appts.map((a) => ({
      id: a.id,
      title: a.title,
      starts_at: a.starts_at,
      email: (a.leads as { email?: string } | null)?.email ?? null,
    })),
  });
}
