/**
 * GET /api/crm/booking/event-types — the bookable calendars (native).
 *   ?with_slots=1  attach the next few real openings for each
 *
 * This is the supply side: what can be booked, when, and under what rules.
 * Bookings themselves live in `appointments` (see /api/crm/calendar).
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { generateSlots, type AvailabilityRule, type EventType } from "@/lib/crm/slots";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function hhmm(mins: number) {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

export async function GET(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const supabase = createAdminClient();
  const withSlots = request.nextUrl.searchParams.get("with_slots") === "1";

  const { data: types, error } = await supabase
    .from("booking_event_types")
    .select("*")
    .order("sort_order");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: availability } = await supabase.from("booking_availability").select("*");
  const { data: tzRow } = await supabase
    .from("backend_settings")
    .select("value")
    .eq("key", "booking_timezone")
    .maybeSingle();
  const timeZone =
    (typeof tzRow?.value === "string" ? tzRow.value : null) || "Europe/Amsterdam";

  // One read of upcoming commitments; each event type filters what applies to it.
  const { data: busy } = await supabase
    .from("appointments")
    .select("starts_at, ends_at, event_type_id, status")
    .gte("starts_at", new Date().toISOString())
    .in("status", ["scheduled"]);

  const { data: blackouts } = await supabase
    .from("booking_blackouts")
    .select("starts_at, ends_at, event_type_id")
    .gte("ends_at", new Date().toISOString());

  const rows = (types || []).map((t) => {
    const rules = (availability || [])
      .filter((a) => a.event_type_id === t.id)
      .sort((a, b) => a.day_of_week - b.day_of_week) as AvailabilityRule[];

    const human = rules.map((r) => `${DAYS[r.day_of_week]} ${hhmm(r.start_minute)}–${hhmm(r.end_minute)}`);

    let next_slots: string[] = [];
    if (withSlots && t.is_active) {
      next_slots = generateSlots({
        eventType: t as unknown as EventType,
        availability: rules,
        // Everything on the owner's calendar blocks everything else.
        busy: (busy || []).map((b) => ({ starts_at: b.starts_at, ends_at: b.ends_at })),
        blackouts: (blackouts || [])
          .filter((b) => !b.event_type_id || b.event_type_id === t.id)
          .map((b) => ({ starts_at: b.starts_at, ends_at: b.ends_at })),
        timeZone,
        days: 28,
      }).slice(0, 5);
    }

    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      description: t.description,
      duration_minutes: t.duration_minutes,
      gap_minutes: t.gap_minutes,
      lead_time_hours: t.lead_time_hours,
      max_per_day: t.max_per_day,
      max_per_month: t.max_per_month,
      price_cents: t.price_cents,
      currency: t.currency,
      location_kind: t.location_kind,
      is_public: t.is_public,
      is_active: t.is_active,
      availability: human,
      booking_url: `/book/${t.slug}`,
      next_slots,
    };
  });

  return NextResponse.json({ timezone: timeZone, count: rows.length, event_types: rows });
}
