/**
 * GET /api/crm/calendar — the owner's diary, native.
 *
 *   ?days= &range=upcoming|past     rolling window (list view)
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD  explicit window (week / month views)
 *
 * Returns two kinds of item, because either alone lies:
 *   booking — an appointment someone made through /book/:slug
 *   busy    — a block mirrored from her external calendar feeds
 * Her real week is mostly the second kind, so a view that only showed
 * bookings would read as an empty diary.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";

export type CalendarItem = {
  id: string;
  kind: "booking" | "busy";
  title: string;
  starts_at: string;
  ends_at: string | null;
  status?: string;
  calendar?: string;
  location?: string | null;
  all_day?: boolean;
};

export async function GET(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const supabase = createAdminClient();
  const params = request.nextUrl.searchParams;

  const from = params.get("from");
  const to = params.get("to");

  let start: Date;
  let end: Date;
  if (from && to) {
    start = new Date(`${from}T00:00:00Z`);
    end = new Date(`${to}T23:59:59Z`);
  } else {
    const days = Math.min(120, Math.max(1, Number(params.get("days") || 30)));
    const past = params.get("range") === "past";
    const now = Date.now();
    start = new Date(past ? now - days * 86400000 : now);
    end = new Date(past ? now : now + days * 86400000);
  }

  const includeBusy = params.get("busy") !== "0";

  const [{ data: appts, error }, { data: blocks }] = await Promise.all([
    supabase
      .from("appointments")
      .select("id, title, starts_at, ends_at, status, meeting_url, booking_event_types(name)")
      .gte("starts_at", start.toISOString())
      .lte("starts_at", end.toISOString())
      .neq("status", "cancelled")
      .order("starts_at"),
    includeBusy
      ? supabase
          .from("booking_blackouts")
          .select("id, starts_at, ends_at, reason, source")
          .lte("starts_at", end.toISOString())
          .gte("ends_at", start.toISOString())
          .order("starts_at")
      : Promise.resolve({ data: [] as never[] }),
  ]);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const items: CalendarItem[] = [];

  for (const a of appts || []) {
    const et = a.booking_event_types as { name?: string } | null;
    items.push({
      id: a.id,
      kind: "booking",
      title: a.title,
      starts_at: a.starts_at,
      ends_at: a.ends_at,
      status: a.status,
      calendar: et?.name || "Booking",
      location: a.meeting_url,
    });
  }

  for (const b of blocks || []) {
    // Blackouts carry a 15-min pad from the sync; strip it back off so the
    // overview shows the meeting she'll recognise, not the padded block.
    const PAD = 15 * 60000;
    const s = new Date(new Date(b.starts_at).getTime() + (b.source === "feed" ? PAD : 0));
    const e = new Date(new Date(b.ends_at).getTime() - (b.source === "feed" ? PAD : 0));
    const raw = b.reason || "Busy";
    // "Feed name: Event title" → keep just the title.
    const title = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1).trim() : raw;
    items.push({
      id: b.id,
      kind: "busy",
      title: title || "Busy",
      starts_at: s.toISOString(),
      ends_at: e.toISOString(),
      calendar: b.source === "feed" ? "External calendar" : "Blocked",
      all_day: e.getTime() - s.getTime() >= 23 * 3600000,
    });
  }

  items.sort((a, b) => a.starts_at.localeCompare(b.starts_at));

  return NextResponse.json({
    from: start.toISOString(),
    to: end.toISOString(),
    count: items.length,
    bookings: items.filter((i) => i.kind === "booking").length,
    busy: items.filter((i) => i.kind === "busy").length,
    items,
    // Kept for the existing list view.
    events: items.filter((i) => i.kind === "booking"),
  });
}
