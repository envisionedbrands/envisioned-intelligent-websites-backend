/**
 * Minimal iCalendar parser — enough to answer "when is she busy?".
 *
 * Scope is deliberate: we only need busy intervals, so we ignore almost
 * everything an .ics can carry. What we do NOT ignore is recurrence — her
 * standing Tuesday call is a repeating event, and a parser that skipped
 * RRULE would quietly leave that slot bookable.
 *
 * Supports: DTSTART/DTEND (date and date-time, UTC / floating / TZID),
 * DURATION, RRULE (DAILY/WEEKLY/MONTHLY, INTERVAL, COUNT, UNTIL, BYDAY),
 * EXDATE, RECURRENCE-ID overrides, STATUS:CANCELLED, TRANSP:TRANSPARENT.
 */

export type BusyEvent = {
  uid: string;
  summary: string | null;
  start: Date;
  end: Date;
  transparent: boolean;
};

/** RFC 5545 line unfolding: continuation lines begin with space or tab. */
function unfold(text: string): string[] {
  const raw = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

type Prop = { name: string; params: Record<string, string>; value: string };

function parseLine(line: string): Prop | null {
  const colon = line.indexOf(":");
  if (colon === -1) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = left.split(";");
  const params: Record<string, string> = {};
  for (const p of paramParts) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value };
}

/** Offset (ms) of `timeZone` at a given instant. */
function tzOffset(date: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour === "24" ? "0" : p.hour),
    Number(p.minute),
    Number(p.second)
  );
  return asUTC - date.getTime();
}

/** Interpret a wall-clock reading as an instant in `timeZone`. */
function fromWallClock(parts: number[], timeZone: string): Date {
  const naive = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
  let guess = new Date(naive);
  for (let i = 0; i < 3; i++) {
    const next = new Date(naive - tzOffset(guess, timeZone));
    if (next.getTime() === guess.getTime()) break;
    guess = next;
  }
  return guess;
}

export function parseDateValue(prop: Prop): { date: Date; allDay: boolean } | null {
  const v = prop.value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, z] = m;
  const nums = [Number(y), Number(mo), Number(d), Number(hh || 0), Number(mm || 0), Number(ss || 0)];

  if (!hh) {
    // DATE — all day, anchored to the calendar's timezone if we know it.
    const tz = prop.params.TZID;
    return {
      date: tz ? fromWallClock(nums, tz) : new Date(Date.UTC(nums[0], nums[1] - 1, nums[2])),
      allDay: true,
    };
  }
  if (z) return { date: new Date(Date.UTC(nums[0], nums[1] - 1, nums[2], nums[3], nums[4], nums[5])), allDay: false };
  const tz = prop.params.TZID;
  return {
    date: tz
      ? fromWallClock(nums, tz)
      : new Date(Date.UTC(nums[0], nums[1] - 1, nums[2], nums[3], nums[4], nums[5])),
    allDay: false,
  };
}

/** ISO-8601 durations as used by DURATION (e.g. PT1H30M, P1D). */
function parseDuration(v: string): number {
  const m = v.trim().match(/^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const [, neg, w, d, h, mi, s] = m;
  const ms =
    (Number(w || 0) * 604800 + Number(d || 0) * 86400 + Number(h || 0) * 3600 + Number(mi || 0) * 60 + Number(s || 0)) *
    1000;
  return neg ? -ms : ms;
}

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/**
 * Expand a recurrence rule within [windowStart, windowEnd].
 * Bounded hard — a malformed UNTIL can't spin forever.
 */
function expandRrule(
  rule: string,
  start: Date,
  durationMs: number,
  windowStart: Date,
  windowEnd: Date,
  exdates: Set<number>
): { start: Date; end: Date }[] {
  const parts = Object.fromEntries(
    rule.split(";").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).toUpperCase(), kv.slice(i + 1)];
    })
  ) as Record<string, string>;

  const freq = (parts.FREQ || "").toUpperCase();
  if (!["DAILY", "WEEKLY", "MONTHLY"].includes(freq)) return [];

  const interval = Math.max(1, Number(parts.INTERVAL || 1));
  const count = parts.COUNT ? Number(parts.COUNT) : null;
  const until = parts.UNTIL
    ? parseDateValue({ name: "UNTIL", params: {}, value: parts.UNTIL })?.date ?? null
    : null;
  const byDay = parts.BYDAY
    ? parts.BYDAY.split(",").map((d) => DAY_CODES.indexOf(d.trim().slice(-2).toUpperCase())).filter((i) => i >= 0)
    : null;

  const out: { start: Date; end: Date }[] = [];
  const hardCap = 3000;
  let emitted = 0;

  const push = (s: Date) => {
    if (until && s.getTime() > until.getTime()) return false;
    if (count != null && emitted >= count) return false;
    emitted++;
    if (exdates.has(s.getTime())) return true;
    const e = new Date(s.getTime() + durationMs);
    if (e > windowStart && s < windowEnd) out.push({ start: s, end: e });
    return true;
  };

  const stepMs = freq === "DAILY" ? 86400000 * interval : 86400000 * 7 * interval;

  if (freq === "DAILY" || freq === "WEEKLY") {
    if (freq === "WEEKLY" && byDay?.length) {
      // Walk week by week, emitting each selected weekday.
      const weekStart = new Date(start.getTime());
      weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 7) % 7));
      for (let i = 0; i < hardCap; i++) {
        const base = new Date(weekStart.getTime() + i * stepMs);
        if (base.getTime() > windowEnd.getTime() + stepMs) break;
        for (const dow of byDay.slice().sort()) {
          const s = new Date(base.getTime() + dow * 86400000);
          if (s.getTime() < start.getTime()) continue;
          if (!push(s)) return out;
        }
        if (count != null && emitted >= count) break;
      }
      return out;
    }
    for (let i = 0; i < hardCap; i++) {
      const s = new Date(start.getTime() + i * stepMs);
      if (s.getTime() > windowEnd.getTime()) break;
      if (!push(s)) break;
    }
    return out;
  }

  // MONTHLY — same day-of-month each interval.
  for (let i = 0; i < hardCap; i++) {
    const s = new Date(start.getTime());
    s.setUTCMonth(s.getUTCMonth() + i * interval);
    if (s.getTime() > windowEnd.getTime()) break;
    if (!push(s)) break;
  }
  return out;
}

/**
 * Parse an .ics body into busy intervals overlapping the window.
 * Cancelled events are dropped; transparent ones are flagged so the caller
 * can decide (a "free" event shouldn't block a slot).
 */
export function parseIcs(text: string, windowStart: Date, windowEnd: Date): BusyEvent[] {
  const lines = unfold(text);
  const out: BusyEvent[] = [];

  let cur: Record<string, Prop> | null = null;
  let exdates: Set<number> = new Set();
  const overrides = new Set<string>();

  for (const line of lines) {
    if (line.startsWith("BEGIN:VEVENT")) {
      cur = {};
      exdates = new Set();
      continue;
    }
    if (line.startsWith("END:VEVENT")) {
      if (cur) emit(cur, exdates);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "EXDATE") {
      for (const v of p.value.split(",")) {
        const d = parseDateValue({ ...p, value: v });
        if (d) exdates.add(d.date.getTime());
      }
      continue;
    }
    cur[p.name] = p;
  }

  function emit(ev: Record<string, Prop>, ex: Set<number>) {
    const uid = ev.UID?.value?.trim();
    if (!uid) return;
    if ((ev.STATUS?.value || "").toUpperCase() === "CANCELLED") return;

    const dtstart = ev.DTSTART ? parseDateValue(ev.DTSTART) : null;
    if (!dtstart) return;

    let durationMs: number;
    if (ev.DTEND) {
      const dtend = parseDateValue(ev.DTEND);
      durationMs = dtend ? dtend.date.getTime() - dtstart.date.getTime() : 0;
    } else if (ev.DURATION) {
      durationMs = parseDuration(ev.DURATION.value);
    } else {
      durationMs = dtstart.allDay ? 86400000 : 0;
    }
    if (durationMs <= 0) durationMs = dtstart.allDay ? 86400000 : 30 * 60000;

    const transparent = (ev.TRANSP?.value || "").toUpperCase() === "TRANSPARENT";
    const summary = ev.SUMMARY?.value?.trim() || null;

    // A RECURRENCE-ID event replaces one instance; keep it and let the
    // series' own EXDATE handling avoid the duplicate where present.
    if (ev["RECURRENCE-ID"]) overrides.add(uid);

    if (ev.RRULE) {
      const occurrences = expandRrule(
        ev.RRULE.value,
        dtstart.date,
        durationMs,
        windowStart,
        windowEnd,
        ex
      );
      occurrences.forEach((o, i) =>
        out.push({ uid: `${uid}::${o.start.toISOString()}`, summary, start: o.start, end: o.end, transparent })
      );
      return;
    }

    const start = dtstart.date;
    const end = new Date(start.getTime() + durationMs);
    if (end > windowStart && start < windowEnd) {
      out.push({
        uid: ev["RECURRENCE-ID"] ? `${uid}::${start.toISOString()}` : uid,
        summary,
        start,
        end,
        transparent,
      });
    }
  }

  return out;
}
