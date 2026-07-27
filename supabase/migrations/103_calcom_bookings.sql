-- Migration 103: Cal.com booking integration (Digital Home Upgrade)
--
-- INSTALL TOKENS — replace before applying (the /upgrade skill does this):
--   Maria-Inés — the sender's first name, used in the reminder templates
--
-- Bookings made through Cal.com links land in the existing `appointments`
-- table (already surfaced on the CRM dashboard and lead timeline) via the
-- /api/crm/webhooks/calcom endpoint. This migration adds the columns that
-- external-booking sync needs, plus reminder-send tracking, and seeds the
-- two reminder email templates the engine tick sends from.

-- Reschedules keep history: the superseded appointment row is marked
-- 'rescheduled' rather than deleted.
alter type appointment_status add value if not exists 'rescheduled';

alter table appointments
  add column if not exists cal_uid text,
  add column if not exists event_slug text,
  add column if not exists timezone text,
  add column if not exists meeting_url text,
  add column if not exists reschedule_url text,
  add column if not exists cancel_url text,
  add column if not exists raw jsonb,
  add column if not exists reminder_24h_sent_at timestamptz,
  add column if not exists reminder_1h_sent_at timestamptz,
  add column if not exists updated_at timestamptz default now();

-- Webhook upserts are keyed on the Cal.com booking uid
create unique index if not exists idx_appts_cal_uid
  on appointments(cal_uid) where cal_uid is not null;

-- The reminder scan runs every engine tick: upcoming scheduled appointments only
create index if not exists idx_appts_upcoming
  on appointments(starts_at) where cal_uid is not null;

-- Reminder templates: looked up by exact name at send time; editable in the
-- CRM templates UI. If a template is deleted the engine falls back to
-- built-in copy, so these are safe to reword freely.
insert into email_templates (name, subject, preheader, body_md, category)
select
  'Booking reminder — 24 hours',
  'Tomorrow: {{booking_title}}',
  'Your call with Maria-Inés is coming up',
  E'Hey {{first_name|there}},\n\nJust a quick reminder that our call is booked for tomorrow:\n\n**{{booking_title}}**\n{{booking_day}} at {{booking_time}}\n\nJoin here when it''s time: {{meeting_url}}\n\nNeed to change it? You can [reschedule]({{reschedule_url}}) or [cancel]({{cancel_url}}) in one click — no hard feelings, just let the calendar know.\n\nSee you there,\nMaria-Inés',
  'booking'
where not exists (select 1 from email_templates where name = 'Booking reminder — 24 hours');

insert into email_templates (name, subject, preheader, body_md, category)
select
  'Booking reminder — 1 hour',
  'Starting soon: {{booking_title}} at {{booking_time}}',
  'We''re on in about an hour',
  E'Hey {{first_name|there}},\n\nWe''re on in about an hour — **{{booking_title}}** at {{booking_time}}.\n\nJoin link: {{meeting_url}}\n\nGrab a coffee, find a quiet spot, and I''ll see you soon.\n\nMaria-Inés',
  'booking'
where not exists (select 1 from email_templates where name = 'Booking reminder — 1 hour');
