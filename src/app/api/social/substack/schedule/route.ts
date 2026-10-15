/**
 * POST /api/social/substack/schedule — schedule a Substack Note.
 * Body: { derivative_id?: string, text?: string, scheduled_at: ISO string }
 *
 * Owner-only (admin session, no API key): this click IS her approval to
 * publish these words under her name. Agents go through the approvals queue
 * instead (MCP tool propose_substack_note → agent_actions 'social_post').
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSession, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { scheduleSubstackNote, ScheduleError } from "@/lib/social/substack-ops";

export async function POST(request: NextRequest) {
  const auth = await authenticateSession(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const body = (await request.json().catch(() => null)) as {
    derivative_id?: string;
    text?: string;
    scheduled_at?: string;
  } | null;
  if (!body?.scheduled_at) return NextResponse.json({ error: "scheduled_at is required" }, { status: 400 });
  if (!body.derivative_id && !body.text?.trim()) {
    return NextResponse.json({ error: "Send a derivative_id or the Note text" }, { status: 400 });
  }

  try {
    const result = await scheduleSubstackNote(createAdminClient(), {
      derivativeId: body.derivative_id || null,
      text: body.text || null,
      scheduledAt: body.scheduled_at,
      createdBy: "human",
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const status = e instanceof ScheduleError ? 400 : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not schedule" }, { status });
  }
}
