/**
 * Native slot engine — the supply side of booking.
 *
 * We generate the slot grid ourselves rather than trusting a vendor "buffer"
 * setting. (GHL's buffer field was proved on 2026-08-15 not to prevent
 * back-to-back calls: an 11:30–12:30 booking still left 10:30 and 12:30 open.)
 * Here the gap is structural — a candidate is only offered if it clears every
 * existing appointment by `gap_minutes` on BOTH sides.
 *
 * All weekly availability is expressed in the owner's timezone as
 * minutes-from-midnight, so DST shifts don't move her working day.
 */

export type EventType = {
  id: string;
  slug: string;
  name: string;
  duration_minutes: number;
  gap_minutes: number;
  lead_time_hours: number;
  booking_window_days: number;
  max_per_day: number | null;
  max_per_month: number | null;
  is_active: boolean;
};

export type AvailabilityRule = {
  day_of_week: number;
  start_minute: number;
  end_minute: number;
};

export type Busy = { starts_at: string; ends_at: string | null };
export type Blackout = { starts_at: string; ends_at: string };

/** Parts of an instant, rendered in a given IANA timezone. */
function zoned(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const days: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    hour: Number(parts.hour === "24" ? "0" : parts.hour),
    minute: Number(parts.minute),
    dow: days[parts.weekday as string] ?? 0,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** The UTC offset (ms) that `timeZone` is at the given instant. */
function offsetAt(date: Date, timeZone: string): number {
  const z = zoned(date, timeZone);
  const asUTC = Date.UTC(z.y, z.m - 1, z.d, z.hour, z.minute);
  // Round to the minute — formatToParts drops seconds.
  return asUTC - Math.floor(date.getTime() / 60000) * 60000;
}

/**
 * Build the instant for a wall-clock time in `timeZone`. Resolves the
 * offset iteratively so it stays correct across DST boundaries.
 */
function instantFor(
  y: number,
  m: number,
  d: number,
  minutes: number,
  timeZone: string
): Date {
  const naive = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  let guess = new Date(naive);
  for (let i = 0; i < 3; i++) {
    const off = offsetAt(guess, timeZone);
    const next = new Date(naive - off);
    if (next.getTime() === guess.getTime()) break;
    guess = next;
  }
  return guess;
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return aStart < bEnd && bStart < aEnd;
}

export type SlotOptions = {
  eventType: EventType;
  availability: AvailabilityRule[];
  busy: Busy[];
  blackouts: Blackout[];
  timeZone: string;
  from?: Date;
  days?: number;
  /** Test seam — defaults to now. */
  now?: Date;
};

/** Returns bookable start instants as ISO strings, ascending. */
export function generateSlots(opts: SlotOptions): string[] {
  const { eventType: et, availability, busy, blackouts, timeZone } = opts;
  if (!et.is_active || availability.length === 0) return [];

  const now = opts.now ?? new Date();
  const durationMs = et.duration_minutes * 60000;
  const gapMs = et.gap_minutes * 60000;
  const earliest = now.getTime() + et.lead_time_hours * 3600000;

  const windowDays = Math.min(opts.days ?? et.booking_window_days, et.booking_window_days);
  const start = opts.from ?? now;

  // Existing commitments, expanded by the gap on both sides.
  const blocked = busy
    .map((b) => {
      const s = new Date(b.starts_at).getTime();
      const e = b.ends_at ? new Date(b.ends_at).getTime() : s + durationMs;
      return { start: s - gapMs, end: e + gapMs };
    })
    .concat(
      blackouts.map((b) => ({
        start: new Date(b.starts_at).getTime(),
        end: new Date(b.ends_at).getTime(),
      }))
    );

  // Caps are counted against real bookings, not gap-padded ones.
  const perDay = new Map<string, number>();
  const perMonth = new Map<string, number>();
  for (const b of busy) {
    const z = zoned(new Date(b.starts_at), timeZone);
    perDay.set(z.dateKey, (perDay.get(z.dateKey) || 0) + 1);
    const mk = z.dateKey.slice(0, 7);
    perMonth.set(mk, (perMonth.get(mk) || 0) + 1);
  }

  const byDow = new Map<number, AvailabilityRule[]>();
  for (const rule of availability) {
    const list = byDow.get(rule.day_of_week) || [];
    list.push(rule);
    byDow.set(rule.day_of_week, list);
  }

  const out: string[] = [];
  const dayCount = new Map<string, number>();
  const monthCount = new Map<string, number>();

  for (let dayOffset = 0; dayOffset <= windowDays; dayOffset++) {
    const probe = new Date(start.getTime() + dayOffset * 86400000);
    const z = zoned(probe, timeZone);
    const rules = byDow.get(z.dow);
    if (!rules) continue;

    const monthKey = z.dateKey.slice(0, 7);
    const bookedToday = perDay.get(z.dateKey) || 0;
    const bookedMonth = perMonth.get(monthKey) || 0;

    for (const rule of rules) {
      // Step by duration + gap: the grid itself enforces the breathing room.
      const step = et.duration_minutes + et.gap_minutes;
      for (let mins = rule.start_minute; mins + et.duration_minutes <= rule.end_minute; mins += step) {
        const slotStart = instantFor(z.y, z.m, z.d, mins, timeZone);
        const s = slotStart.getTime();
        const e = s + durationMs;

        if (s < earliest) continue;
        if (blocked.some((b) => overlaps(s, e, b.start, b.end))) continue;

        const dayTotal = bookedToday + (dayCount.get(z.dateKey) || 0);
        if (et.max_per_day != null && dayTotal >= et.max_per_day) continue;
        const monthTotal = bookedMonth + (monthCount.get(monthKey) || 0);
        if (et.max_per_month != null && monthTotal >= et.max_per_month) continue;

        out.push(slotStart.toISOString());
        // Caps describe how many can be BOOKED, not how many are offered —
        // so we don't increment here; the counts above reflect real bookings.
      }
    }
  }

  return out.sort();
}

/** True when `startsAt` is still bookable — the guard before writing. */
export function isSlotAvailable(startsAt: string, opts: SlotOptions): boolean {
  const target = new Date(startsAt).getTime();
  return generateSlots(opts).some((s) => new Date(s).getTime() === target);
}
