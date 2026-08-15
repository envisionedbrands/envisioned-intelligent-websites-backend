# Booking follow-up sequence — spec

Captured from MI 2026-08-15, **answers locked same day**. Copy must be staged
for her approval before anything sends (standing rule: no external send
without a go).

## The ladder

Steps are scheduled off `appointments.starts_at`; each fires on the engine
tick (~5 min) and only if its window is still valid.

| Step | When | Job | Yields to other email? |
|---|---|---|---|
| `confirmation` | immediately on booking | confirm + prepare + recording notice + prep form | **yes** |
| `reminder_24h` | 24h before | short nudge | yes |
| `reminder_12h` | 12h before | short nudge | yes |
| `reminder_1h` | 1h before | **carries the Zoom link** | **no** |
| `reminder_5min` | 5 min before | "starting now" + link | **no** |
| `thank_you` | ~24h after | thanks + summary is coming | yes |

**Conditional on lead time — never send a step whose window already passed.**
Book 3 hours out and you get: confirmation → 1h → 5min → thank-you. Book two
weeks out and you get the full ladder. A step is skipped, not delayed.

Per-step `*_sent_at` stamps on `appointments` (migration 103 already has the
24h and 1h ones) so a step can never double-send and a missed tick doesn't
replay history.

## Locked decisions (MI, 2026-08-15)

1. **Meeting link = her permanent Zoom room.** Stored as `meeting_url` on all
   three video event types; the 1h and 5min reminders carry it. (The reminders
   were only ever going to carry a link — the recording doesn't exist yet at
   that point.)
2. **Recording is announced, not consented.** No checkbox at booking — the
   checkbox that shipped has been **removed**. The emails state plainly that
   the call will be recorded. *Noted once and not relitigated: in the EU,
   announcement is disclosure rather than consent. Her call, her jurisdiction.*
3. **Never mention AI.** Do not describe the summary as AI-drafted, AI-generated
   or anything adjacent. She provides a summary. Full stop.
4. **Quiet window: 8 hours** for the collision guard.
5. **No AI notetakers allowed on her calls.** This is a stated policy, not a
   preference — guests should not bring Otter/Fathom/Read/Copilot-style bots.
   She records, and she provides the summary herself. This belongs in the
   confirmation and should be unambiguous but not sour.
6. **Every call gets a prep form** — they say what they want to talk about
   before the call. Note: the booking page *already* asks this
   ("What do you want to get out of this?"). See open question below.

## The intelligence layer

Before sending, check `email_sends` for that lead. If they've received **any**
email — manual, sequence, or workflow-triggered — inside the **8-hour** quiet
window, the booking email is suppressed and stamped as covered, so it doesn't
queue up and land later as a stale duplicate.

**Not a blanket rule, deliberately.** A blanket "stop everything" would also
kill the 1h and 5-minute reminders, which carry the Zoom link. Someone who
happens to receive a newsletter an hour before the call still needs to know
where to go. So:

- **Nurture-shaped steps** (confirmation, 24h, 12h, thank-you) yield.
- **Utility steps** (1h, 5min) always send. Logistics, not marketing — the
  difference between someone showing up and someone not.

Suppression is logged on the lead timeline with the reason and what beat it,
so it's visible rather than silent.

## Messaging notes

- The call **will be recorded**. Say it plainly, once, without apology.
- **A summary follows.** Never say who or what wrote it.
- **No AI notetakers.** Guests don't bring bots. Frame it as her keeping the
  room human, not as a rule being enforced at them.
- The confirmation is the one with room to be *beautiful*; reminders should be
  short enough to read on a lock screen.
- Her voice: story-first or straight to the diagnosis, no "Listen." / "Here's
  the truth.", em-dashes rationed, no hedging.

## Still open

- **Q6 got answered with something else** — the Map async **delivery-window
  duration** is still unanswered. Recommendation on record: **Mondays
  10:00–14:00**, her only protected non-call block.
- **Prep form: reuse or send a second one?** The booking page already captures
  "What do you want to get out of this?" and it lands on the appointment as
  `guest_notes`. Recommendation: don't build a second form — have the
  confirmation restate what they wrote and invite them to reply with more.
  Cheaper for them, and their answer stays on the booking instead of in a
  separate silo. Confirm before build.
