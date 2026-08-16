-- Migration 306: the booking follow-up sequence.
--
-- Spec + her locked answers: docs/booking-sequence.md. Migration 103 already
-- gave us reminder_24h_sent_at / reminder_1h_sent_at; this adds the rest of
-- the ladder and seeds the copy.
--
-- Ships DISABLED (`booking_sequence_enabled = false`). Nothing sends until
-- she has read the copy and said go — standing rule, no external send
-- without approval.
--
-- House rules baked into the copy:
--   * the call is recorded — stated plainly, once, no apology
--   * she provides the summary — NEVER described as AI-anything
--   * no AI notetakers in the room — framed as keeping it human
--   * her voice: no hedging, em-dashes rationed, no "Listen." openers

alter table appointments
  add column if not exists confirmation_sent_at timestamptz,
  add column if not exists reminder_12h_sent_at timestamptz,
  add column if not exists reminder_5min_sent_at timestamptz,
  add column if not exists thank_you_sent_at timestamptz;

insert into backend_settings (key, value)
select 'booking_sequence_enabled', 'false'::jsonb
where not exists (select 1 from backend_settings where key = 'booking_sequence_enabled');

insert into backend_settings (key, value)
select 'booking_quiet_window_hours', '8'::jsonb
where not exists (select 1 from backend_settings where key = 'booking_quiet_window_hours');

-- ── Templates ────────────────────────────────────────────────────────────
-- Editable in the CRM templates UI; deleting one falls back to built-in copy.

insert into email_templates (name, subject, preheader, body_md, category)
select
  'Booking — confirmation',
  'You''re in the diary, {{first_name|there}}',
  'What to bring, and what happens next',
  E'{{booking_day}} at {{booking_time}}.\n\nHere is what makes these calls work: come with the actual problem, not the tidied-up version. The one you would describe to a friend at the end of a long day, not the one you would put in a proposal.\n\nYou said you wanted to get into this:\n\n> {{guest_notes|(nothing yet — reply and tell me)}}\n\nIf that has changed between now and then, reply and say so. I would rather know before we sit down.\n\nTwo practical things.\n\nThe link to where we meet arrives closer to the time, so you do not need to keep this email.\n\nAnd the call is recorded. I do not have notetaking bots in the room — I write the summary myself and send it to you afterwards. You get to be present instead of typing.\n\nSee you {{booking_day}}.\n\nMaria-Ines',
  'booking'
where not exists (select 1 from email_templates where name = 'Booking — confirmation');

insert into email_templates (name, subject, preheader, body_md, category)
select
  'Booking — 12 hours',
  'Tomorrow: {{booking_title}}',
  '{{booking_day}} at {{booking_time}}',
  E'We are on for {{booking_day}} at {{booking_time}}.\n\nThe link lands an hour before. Nothing to prepare — bring the thing you are stuck on.\n\nMaria-Ines',
  'booking'
where not exists (select 1 from email_templates where name = 'Booking — 12 hours');

insert into email_templates (name, subject, preheader, body_md, category)
select
  'Booking — 5 minutes',
  'Starting now',
  'The room is open',
  E'{{booking_title}}, now.\n\n[Join here]({{meeting_url}})\n\nI am already in the room.\n\nMaria-Ines',
  'booking'
where not exists (select 1 from email_templates where name = 'Booking — 5 minutes');

insert into email_templates (name, subject, preheader, body_md, category)
select
  'Booking — thank you',
  'After today',
  'A summary is coming',
  E'Thank you for today, {{first_name|there}}.\n\nI am writing up what we covered — the decisions, the things worth keeping, and the one or two I would push you on. It comes from me, so give me a day or so rather than an instant.\n\nIf something has already shifted since we spoke, reply and tell me. That is usually the most useful part.\n\nMaria-Ines',
  'booking'
where not exists (select 1 from email_templates where name = 'Booking — thank you');
