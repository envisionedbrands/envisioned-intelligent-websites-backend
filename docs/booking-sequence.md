# Booking follow-up sequence — spec

Captured from MI 2026-08-15. **Not built yet.** Copy must be staged for her
approval before anything sends (standing rule: no external send without a go).

## What she asked for

1. A confirmation that the call is booked — beautiful, and it *prepares* them
   (mindset prep or practical prep, whatever the situation calls for). It also
   tells them the meeting link arrives later.
2. Reminders at **24h / 12h / 1h / 5min**, conditional on how far ahead they
   booked. Short and functional: we're meeting, here's the link.
3. Disclosure that the call is **recorded** and that they'll get an
   **AI-drafted summary** afterwards.
4. A **thank-you** roughly 24h after the call.
5. **An intelligence layer:** if another email goes to that person — sent
   manually or triggered by a workflow — the sequence email should be
   **stopped, not delivered.** No stacking.

## The ladder

Steps are scheduled off `appointments.starts_at`; each fires on the engine tick
(~5 min) and only if its window is still valid.

| Step | When | Job | Yields to other email? |
|---|---|---|---|
| `confirmation` | immediately on booking | confirm + prepare + "link comes later" + recording notice | **yes** |
| `reminder_24h` | 24h before | short nudge | yes |
| `reminder_12h` | 12h before | short nudge | yes |
| `reminder_1h` | 1h before | **carries the join link** | **no** |
| `reminder_5min` | 5 min before | "starting now" + link | **no** |
| `thank_you` | ~24h after | thanks + AI summary | yes |

**Conditional on lead time — never send a step whose window already passed.**
Book 3 hours out and you get: confirmation → 1h → 5min → thank-you. Book two
weeks out and you get the full ladder. A step is skipped, not delayed.

Reuses the existing pattern: per-step `*_sent_at` stamps on `appointments`
(migration 103 already has `reminder_24h_sent_at` / `reminder_1h_sent_at`), so
a step can never double-send and a missed tick doesn't replay history.

## The intelligence layer (the interesting part)

Before sending, check `email_sends` for that lead. If they've received **any**
email — manual, sequence, or workflow-triggered — inside the quiet window, the
booking email is **suppressed and stamped as covered**, so it doesn't queue up
and land later as a stale duplicate.

**Recommendation — not a blanket rule.** A blanket "stop everything" would also
kill the 1h and 5-minute reminders, which are the ones carrying the join link.
Someone who happens to receive a newsletter an hour before the call still needs
to know where to go. So:

- **Nurture-shaped steps** (confirmation, 24h, 12h, thank-you) yield to any
  other email in the quiet window. Default quiet window: **6 hours**.
- **Utility steps** (1h, 5min) always send. They're logistics, not marketing —
  and they're the difference between someone showing up and someone not.

This is the judgement call inside "carries an intelligence layer": the system
should know the difference between *another email* and *the email that gets
them in the room*.

Suppression is logged on the lead timeline with the reason and what beat it,
so it's visible rather than silent.

## Open questions for MI

1. **"Here is the recording"** — read as the *meeting link* in the reminders
   (the recording doesn't exist yet at that point). Confirm.
2. **Recording consent.** She's in the Netherlands, so participants are EU
   subjects. Announcing "this will be recorded" in a reminder is disclosure,
   not consent. Cleaner and safer: a consent line on the booking form itself,
   with the reminder repeating it. Recommend booking-form consent.
3. **Thank-you + AI summary** — one email or two? (Summary may not be ready at
   +24h if it needs her review.) Recommend: thank-you at +24h says the summary
   is coming; the summary sends when it exists.
4. **Quiet window length** — 6h proposed.
5. **Per-event-type copy?** A Client Session and an Envisioned Match probably
   want different prep. Recommend: shared skeleton, per-event-type prep block.

## Voice

Her voice, not template voice: story-first or straight to the diagnosis, no
"Listen." / "Here's the truth.", em-dashes rationed, no hedging. The
confirmation is the one with room to be *beautiful*; the reminders should be
short enough to read on a lock screen.
