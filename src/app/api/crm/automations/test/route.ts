/**
 * POST /api/crm/automations/test — send a pretend DM to your own funnel.
 *
 * Instagram is the slowest possible way to test this. Every change to a word of
 * copy meant: open the app, find the account, send a message from a second
 * login, wait for Meta, then read three tables to find out what happened. Most
 * of an evening went into that loop without once proving the funnel replies.
 *
 * This runs the *real* state machine — `handleMessage`, same branching, same
 * rows — against a synthetic subscriber with sending forced off. What comes
 * back is the exact text the account would have said.
 *
 * Two deliberate choices:
 *
 *  - The test subscriber is stable (`TEST_CONSOLE`), not random, so consecutive
 *    calls continue one conversation. That is what lets you walk the whole
 *    flow: "behind" → it asks for an email → "me@example.com" → it delivers.
 *  - Starting over closes the open run instead of deleting rows. The transcript
 *    of what you tested is worth keeping, and nothing here is important enough
 *    to justify a destructive default.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { handleMessage } from "@/lib/social/dm-funnel";

/** Recognisable in every table, and impossible to confuse with a real IGSID. */
const TEST_IGSID = "TEST_CONSOLE";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const t = (c: ReturnType<typeof createAdminClient>) => c as any;

export async function POST(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const body = await request.json().catch(() => ({}));
  const supabase = createAdminClient();

  const { data: sub } = await t(supabase)
    .from("dm_subscribers")
    .select("id")
    .eq("igsid", TEST_IGSID)
    .maybeSingle();

  // ── Start over ────────────────────────────────────────────────────────────
  if (body.action === "reset") {
    if (sub) {
      await t(supabase)
        .from("dm_funnel_runs")
        .update({ state: "expired" })
        .eq("subscriber_id", sub.id)
        .in("state", ["opened", "awaiting_follow", "awaiting_email"]);
    }
    return NextResponse.json({ ok: true, reset: true });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 });

  const startedAt = new Date().toISOString();

  let result;
  try {
    result = await handleMessage(supabase, { igsid: TEST_IGSID, text }, { forceSafeMode: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "the funnel threw while handling that message" },
      { status: 500 }
    );
  }

  // Read back what the run produced. `handleMessage` returns a verdict, not a
  // transcript — and the transcript is the thing being reviewed here.
  const { data: subAfter } = await t(supabase)
    .from("dm_subscribers")
    .select("id")
    .eq("igsid", TEST_IGSID)
    .maybeSingle();

  let replies: { direction: string; body: string; simulated: boolean }[] = [];
  if (subAfter) {
    const { data } = await t(supabase)
      .from("dm_messages")
      .select("direction, body, simulated, created_at")
      .eq("subscriber_id", subAfter.id)
      .gte("created_at", startedAt)
      .order("created_at", { ascending: true });
    replies = data || [];
  }

  return NextResponse.json({
    result,
    replies,
    note: "Nothing was sent to Instagram. Sending is forced off for tests.",
  });
}
