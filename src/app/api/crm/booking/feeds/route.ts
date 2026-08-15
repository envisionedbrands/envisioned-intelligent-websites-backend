/**
 * GET    /api/crm/booking/feeds        — list calendar feeds + last sync state
 * POST   /api/crm/booking/feeds        — add a feed { name, ics_url } and sync it now
 * DELETE /api/crm/booking/feeds?id=    — remove a feed (its blackouts cascade)
 *
 * Feeds are how the native booking system learns she's busy elsewhere.
 * The ics_url is a secret (anyone holding it can read the calendar), so it
 * is never returned in full — only its host.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { syncCalendarFeeds } from "@/lib/crm/calendar-sync";

function redact(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "invalid url";
  }
}

export async function GET(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("calendar_feeds")
    .select("*")
    .order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    feeds: (data || []).map((f) => ({
      id: f.id,
      name: f.name,
      host: redact(f.ics_url),
      is_active: f.is_active,
      last_synced_at: f.last_synced_at,
      last_status: f.last_status,
      last_error: f.last_error,
      last_event_count: f.last_event_count,
    })),
  });
}

export async function POST(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  let body: { name?: string; ics_url?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const name = (body.name || "").trim();
  let url = (body.ics_url || "").trim();
  if (!name || !url) return NextResponse.json({ error: "name and ics_url required" }, { status: 400 });

  // Google hands out webcal:// links from the UI.
  if (url.startsWith("webcal://")) url = `https://${url.slice("webcal://".length)}`;
  if (!/^https?:\/\//.test(url)) {
    return NextResponse.json({ error: "ics_url must be an http(s) or webcal URL" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("calendar_feeds")
    .insert({ name, ics_url: url })
    .select("id, name")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Sync immediately so she finds out now if the URL is wrong, not in 5 minutes.
  const results = await syncCalendarFeeds(supabase);
  const mine = results.find((r) => r.feed === data.name);

  return NextResponse.json({ ok: true, feed: data, sync: mine ?? null });
}

export async function DELETE(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const supabase = createAdminClient();
  const { error } = await supabase.from("calendar_feeds").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
