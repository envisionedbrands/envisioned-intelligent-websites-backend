/**
 * Booking follow-up sequence — confirmation, laddered reminders, thank-you.
 * Spec: docs/booking-sequence.md
 *
 * Two rules that shape everything here:
 *
 * 1. A step whose window has already passed is SKIPPED, never delayed. Book
 *    three hours out and you get the confirmation, the 1h, the 5min and the
 *    thank-you — not a "24 hours before" email sent 40 minutes before.
 *
 * 2. The collision guard is not blanket. Nurture-shaped steps stand down if
 *    the lead got any other email inside the quiet window; the 1h and 5min
 *    reminders always send, because they carry the link to the room. A
 *    newsletter landing an hour before a call must not be the reason someone
 *    turns up nowhere.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { notifyOwner, sendCrmEmail } from "./email";
import type { CrmSettings } from "./types";

type AdminClient = SupabaseClient<Database>;
type Appointment = Database["public"]["Tables"]["appointments"]["Row"];
type Lead = Database["public"]["Tables"]["leads"]["Row"];

const MIN = 60_000;
const HOUR = 60 * MIN;
/** How long after booking the confirmation may still go out. */
const CONFIRMATION_WINDOW = 6 * HOUR;

type StepKey = "confirmation" | "reminder_24h" | "reminder_12h" | "reminder_1h" | "reminder_5min" | "thank_you";

type Step = {
  key: StepKey;
  column: keyof Appointment;
  template: string;
  /** Utility steps carry the join link and never stand down. */
  yields: boolean;
  /** True when this step is due for an appointment starting in `msUntil`. */
  due: (msUntil: number, appt: Appointment) => boolean;
  /** Past its useful window — stamp as covered without sending. */
  missed: (msUntil: number, appt: Appointment) => boolean;
};

const STEPS: Step[] = [
  {
    key: "confirmation",
    column: "confirmation_sent_at",
    template: "Booking — confirmation",
    yields: true,
    // Only just after the booking was made. Without the created_at guard this
    // fires for ANY future booking the moment the sequence is switched on —
    // which sent a "you are penciled in" three days after the fact (2026-08-16).
    due: (ms, appt) => ms > 0 && ageMs(appt) <= CONFIRMATION_WINDOW,
    missed: (ms, appt) => ms < 0 || ageMs(appt) > CONFIRMATION_WINDOW,
  },
  {
    key: "reminder_24h",
    column: "reminder_24h_sent_at",
    template: "Booking reminder — 24 hours",
    yields: true,
    due: (ms) => ms <= 24 * HOUR && ms > 13 * HOUR,
    missed: (ms) => ms <= 13 * HOUR,
  },
  {
    key: "reminder_12h",
    column: "reminder_12h_sent_at",
    template: "Booking — 12 hours",
    yields: true,
    due: (ms) => ms <= 12 * HOUR && ms > 90 * MIN,
    missed: (ms) => ms <= 90 * MIN,
  },
  {
    key: "reminder_1h",
    column: "reminder_1h_sent_at",
    template: "Booking reminder — 1 hour",
    yields: false,
    due: (ms) => ms <= 75 * MIN && ms > 8 * MIN,
    missed: (ms) => ms <= 8 * MIN,
  },
  {
    key: "reminder_5min",
    column: "reminder_5min_sent_at",
    template: "Booking — 5 minutes",
    yields: false,
    due: (ms) => ms <= 8 * MIN && ms > -5 * MIN,
    missed: (ms) => ms <= -5 * MIN,
  },
  {
    key: "thank_you",
    column: "thank_you_sent_at",
    template: "Booking — thank you",
    yields: true,
    // ~24h after it ended, with a day's grace before we give up.
    due: (ms) => ms <= -24 * HOUR && ms > -48 * HOUR,
    missed: (ms) => ms <= -48 * HOUR,
  },
];

const FALLBACK: Record<string, { subject: string; body: string }> = {
  "Booking — confirmation": {
    subject: "You're in the diary",
    body: "{{booking_day}} at {{booking_time}}.\n\nThe link arrives closer to the time. The call is recorded — no notetaking bots; I write the summary myself.\n\nMaria-Ines",
  },
  "Booking — 12 hours": {
    subject: "Tomorrow: {{booking_title}}",
    body: "We are on for {{booking_day}} at {{booking_time}}. The link lands an hour before.\n\nMaria-Ines",
  },
  "Booking — 5 minutes": {
    subject: "Starting now",
    body: "[Join here]({{meeting_url}})\n\nMaria-Ines",
  },
  "Booking — thank you": {
    subject: "After today",
    body: "Thank you for today. I am writing up what we covered and will send it shortly.\n\nMaria-Ines",
  },
};

/** How long ago the booking was made. */
function ageMs(appt: Appointment): number {
  const created = appt.created_at ? new Date(appt.created_at).getTime() : 0;
  return created ? Date.now() - created : 0;
}

/**
 * "New booking" notice to her own inbox. Fires with the confirmation step, so
 * she hears about every booking even when the guest's email stands down.
 *
 * Safe mode does not hold this back: like the pipeline alerts (health.ts,
 * alerts.ts) it goes only to the owner address, never to a lead, so a real
 * booking still reaches her while guest emails are simulated.
 *
 * A refusal or throw comes back as an error string for the tick summary.
 * The step is not released for it: the guest's email is already settled and
 * must not repeat just to retry her notice.
 */
async function notifyNewBooking(
  notify: typeof notifyOwner,
  supabase: AdminClient,
  appt: Appointment,
  lead: Lead
): Promise<string | null> {
  try {
    const v = fmt(appt, lead, appt.timezone || "Europe/Amsterdam");
    const who = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.email;
    const result = await notify(
      supabase,
      `New booking: ${who}, ${v.booking_day} at ${v.booking_time}`,
      `**${appt.title || "A call"}**\n\n` +
        `**When:** ${v.booking_day} at ${v.booking_time} (${v.timezone})\n\n` +
        `**Who:** ${who} (${lead.email})\n\n` +
        `**Their note:** ${appt.guest_notes?.trim() || "none"}`
    );
    return result.sent ? null : `${lead.email} (owner notice): ${result.error || "not sent"}`;
  } catch (e) {
    // Never let the notice reach the send's catch: that would release a
    // settled step and repeat the guest's email.
    return `${lead.email} (owner notice): ${e instanceof Error ? e.message : "notify error"}`;
  }
}

/** Email senders, swappable so the sequence can be tested without a network. */
export type SequenceDeps = { sendCrmEmail: typeof sendCrmEmail; notifyOwner: typeof notifyOwner };

export type SequenceSummary = { sent: number; simulated: number; skipped: number; errors: string[] };

/** Guest-facing by default; pass the owner's zone for her own notices. */
function fmt(appt: Appointment, lead: Lead, zone?: string) {
  const tz = zone || appt.guest_timezone || appt.timezone || "Europe/Amsterdam";
  const start = new Date(appt.starts_at);
  return {
    timezone: tz,
    booking_title: appt.title || "our call",
    booking_day: start.toLocaleDateString("en-GB", {
      timeZone: tz,
      weekday: "long",
      day: "numeric",
      month: "long",
    }),
    // Just the day name, for sign-offs — "See you Wednesday."
    booking_weekday: start.toLocaleDateString("en-GB", {
      timeZone: tz,
      weekday: "long",
    }),
    booking_time: start.toLocaleTimeString("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
    }),
    meeting_url: appt.meeting_url || "",
    guest_notes: appt.guest_notes || "",
    first_name: lead.first_name || "",
  };
}

/** {{tag}} and {{tag|fallback}} */
function render(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/gi, (_m, key: string, alt?: string) => {
    const v = values[key];
    return v && v.trim() ? v : (alt ?? "");
  });
}

export async function runBookingSequence(
  supabase: AdminClient,
  settings: CrmSettings,
  deps: SequenceDeps = { sendCrmEmail, notifyOwner }
): Promise<SequenceSummary> {
  const summary: SequenceSummary = { sent: 0, simulated: 0, skipped: 0, errors: [] };

  const { data: flag } = await supabase
    .from("backend_settings")
    .select("value")
    .eq("key", "booking_sequence_enabled")
    .maybeSingle();
  if (flag?.value !== true) return summary; // ships off; she flips it after reading the copy

  const { data: qw } = await supabase
    .from("backend_settings")
    .select("value")
    .eq("key", "booking_quiet_window_hours")
    .maybeSingle();
  const quietMs = (typeof qw?.value === "number" ? qw.value : 8) * HOUR;

  const now = Date.now();
  // Everything from a day and a half ago (thank-yous) to a week ahead, plus
  // anything booked inside the confirmation window however far out it starts.
  // Without the second branch a booking more than a week away was never seen
  // while its confirmation was due, then got stamped "missed" once it came into
  // range — so nobody booking two weeks out was ever confirmed (2026-10-13).
  const { data: appts, error } = await supabase
    .from("appointments")
    .select("*")
    .eq("status", "scheduled")
    .or(
      `and(starts_at.gte.${new Date(now - 48 * HOUR).toISOString()},starts_at.lte.${new Date(now + 7 * 24 * HOUR).toISOString()}),` +
        `created_at.gte.${new Date(now - CONFIRMATION_WINDOW).toISOString()}`
    );
  if (error) {
    summary.errors.push(`fetch appointments: ${error.message}`);
    return summary;
  }
  if (!appts?.length) return summary;

  const leadIds = Array.from(new Set(appts.map((a) => a.lead_id).filter(Boolean))) as string[];
  const { data: leads } = await supabase.from("leads").select("*").in("id", leadIds);
  const leadById = new Map((leads || []).map((l) => [l.id, l]));

  const { data: templates } = await supabase
    .from("email_templates")
    .select("*")
    .in("name", STEPS.map((s) => s.template));
  const tplByName = new Map((templates || []).map((t) => [t.name, t]));

  for (const appt of appts as Appointment[]) {
    const lead = appt.lead_id ? leadById.get(appt.lead_id) : null;
    if (!lead) continue;

    const msUntil = new Date(appt.starts_at).getTime() - now;

    for (const step of STEPS) {
      if (appt[step.column]) continue; // already handled

      // Window gone: stamp as covered so it never fires late.
      if (step.missed(msUntil, appt)) {
        await supabase
          .from("appointments")
          .update({ [step.column]: new Date().toISOString() })
          .eq("id", appt.id);
        summary.skipped++;
        continue;
      }
      if (!step.due(msUntil, appt)) continue;

      // Claim the step atomically. The cron tick and a manual tick can overlap;
      // on 2026-08-16 that put a confirmation and a 1h reminder in the same
      // inbox one second apart. Whoever wins the conditional update sends.
      const { data: claimed } = await supabase
        .from("appointments")
        .update({ [step.column]: new Date().toISOString() })
        .eq("id", appt.id)
        .is(step.column, null)
        .select("id");
      if (!claimed?.length) continue; // another tick got there first

      // The collision guard — nurture steps stand down, utility steps don't.
      // The claim above already stamped the step, so standing down is final.
      if (step.yields) {
        const { count } = await supabase
          .from("email_sends")
          .select("id", { count: "exact", head: true })
          .eq("lead_id", lead.id)
          .gte("created_at", new Date(now - quietMs).toISOString());
        if ((count || 0) > 0) {
          if (step.key === "confirmation") {
            const notifyError = await notifyNewBooking(deps.notifyOwner, supabase, appt, lead);
            if (notifyError) summary.errors.push(notifyError);
          }
          summary.skipped++;
          continue;
        }
      }

      const tpl = tplByName.get(step.template);
      const fb = FALLBACK[step.template];
      const subject = tpl?.subject || fb?.subject || "About your booking";
      const bodyMd = tpl?.body_md || fb?.body || "";
      const values = fmt(appt, lead);

      try {
        const result = await deps.sendCrmEmail(
          supabase,
          {
            lead,
            subject: render(subject, values),
            bodyMd: render(bodyMd, values),
            preheader: tpl?.preheader ? render(tpl.preheader, values) : null,
            templateId: tpl?.id || null,
            actor: `booking-${step.key}`,
          },
          settings
        );
        if (result.status === "failed") {
          // Release the claim so the next tick retries.
          await supabase
            .from("appointments")
            .update({ [step.column]: null })
            .eq("id", appt.id);
          summary.errors.push(`${lead.email} (${step.key}): ${result.error}`);
          continue;
        }
        // Told once the guest's email is settled, never on a retried failure.
        if (step.key === "confirmation") {
          const notifyError = await notifyNewBooking(deps.notifyOwner, supabase, appt, lead);
          if (notifyError) summary.errors.push(notifyError);
        }
        if (result.status === "sent") summary.sent++;
        if (result.status === "simulated") summary.simulated++;
      } catch (e) {
        await supabase
          .from("appointments")
          .update({ [step.column]: null })
          .eq("id", appt.id);
        summary.errors.push(
          `${lead.email} (${step.key}): ${e instanceof Error ? e.message : "send error"}`
        );
      }

      // One email per appointment per tick — never stack.
      break;
    }
  }

  return summary;
}
