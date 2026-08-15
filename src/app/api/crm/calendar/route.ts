/**
 * GET /api/crm/calendar — the owner's real calendar, read live from GHL.
 *   ?days=  window size (default 14, max 90)
 *   ?range= upcoming (default) | past
 *
 * Booking lives in GHL, not Cal.com (decided 2026-08-15): she already had 24
 * live calendars taking payment and intake answers, and the CRM/pipeline is
 * there too. This route reads, never writes — the Studio shows the week; GHL
 * stays the source of truth.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-04-15";

type GhlCalendar = { id: string; name: string; isActive?: boolean };
type GhlEvent = {
  id: string;
  title?: string;
  startTime?: string;
  endTime?: string;
  appointmentStatus?: string;
  contactId?: string;
  calendarId?: string;
  address?: string;
};

async function ghl(path: string, token: string) {
  const res = await fetch(`${GHL_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Version: GHL_VERSION,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`GHL ${path} → ${res.status}`);
  return res.json();
}

export async function GET(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const token = process.env.GHL_API_TOKEN;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!token || !locationId) {
    return NextResponse.json(
      { error: "GHL_API_TOKEN / GHL_LOCATION_ID not configured" },
      { status: 501 }
    );
  }

  const params = request.nextUrl.searchParams;
  const days = Math.min(90, Math.max(1, Number(params.get("days") || 14)));
  const past = params.get("range") === "past";

  const now = Date.now();
  const startTime = past ? now - days * 86400000 : now;
  const endTime = past ? now : now + days * 86400000;

  try {
    const calRes = await ghl(`/calendars/?locationId=${locationId}`, token);
    const calendars: GhlCalendar[] = calRes.calendars || [];
    const active = calendars.filter((c) => c.isActive !== false);
    const nameById = new Map(active.map((c) => [c.id, c.name]));

    // GHL has no cross-calendar event query — fan out, tolerate individual failures.
    const results = await Promise.all(
      active.map(async (c) => {
        try {
          const r = await ghl(
            `/calendars/events?locationId=${locationId}&calendarId=${c.id}&startTime=${startTime}&endTime=${endTime}`,
            token
          );
          return (r.events || []) as GhlEvent[];
        } catch {
          return [] as GhlEvent[];
        }
      })
    );

    const seen = new Set<string>();
    const events = results
      .flat()
      .filter((e) => {
        if (!e.id || seen.has(e.id)) return false;
        seen.add(e.id);
        return true;
      })
      .filter((e) => (e.appointmentStatus || "").toLowerCase() !== "cancelled")
      .map((e) => ({
        id: e.id,
        title: e.title || "(untitled)",
        starts_at: e.startTime || null,
        ends_at: e.endTime || null,
        status: e.appointmentStatus || "confirmed",
        calendar: nameById.get(e.calendarId || "") || "—",
        location: e.address || null,
        contact_id: e.contactId || null,
      }))
      .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));

    return NextResponse.json({
      count: events.length,
      range: past ? "past" : "upcoming",
      days,
      calendars_scanned: active.length,
      events,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "GHL request failed" },
      { status: 502 }
    );
  }
}
