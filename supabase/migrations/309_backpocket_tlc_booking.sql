-- Migration 309: Modern CEO Backpocket TLC — native booking type.
--
-- Request (Monica, 2026-10-06, relaying MI's voice note): move her mentor
-- calendar off GHL (id ARoBeaqBAE02Az6SiG6m) and into the native booking
-- system, same as migration 304 did for the rest. The GHL calendar stays
-- live and untouched until Monica deactivates it after this ships.
--
-- Rule this type needs that no other event type has: bookable only in the
-- first 7 and last 7 calendar days of each month. `week_of_month_rule` is a
-- new generic column on booking_event_types — 'first_last' or null (any
-- day) — enforced by the shared slot engine (slots.ts in both repos), not
-- hardcoded to this one type.
--
-- Wed/Wed start times: Monica proposed 10:30 to MI and is waiting on her
-- yes. Built with 10:30 as the configured start for both Wed and Thu below —
-- update the two `booking_availability` rows (not this migration) if MI
-- answers differently. End times (Wed hard stop 12:00, Thu hard stop 17:30 /
-- last start 17:00) were given as fixed.
--
-- Price left at 0 (free) — not specified in the request. Confirm before
-- treating this as a paid calendar.

alter table booking_event_types
  add column if not exists week_of_month_rule text
    check (week_of_month_rule is null or week_of_month_rule = 'first_last');

insert into booking_event_types
  (slug, name, description, duration_minutes, gap_minutes, lead_time_hours,
   booking_window_days, price_cents, location_kind, is_public, is_active,
   sort_order, week_of_month_rule, confirmation_note)
select
  'backpocket-tlc', 'Modern CEO Backpocket TLC',
  'A short mentor call — bookable only in the first and last week of the month.',
  30, 15, 24, 60, 0, 'video', false, true, 40, 'first_last',
  'See you then.'
where not exists (select 1 from booking_event_types where slug = 'backpocket-tlc');

-- Tue 10:30–12:00 (confirmed).
insert into booking_availability (event_type_id, day_of_week, start_minute, end_minute)
select t.id, 2, 630, 720 from booking_event_types t where t.slug = 'backpocket-tlc'
  and not exists (select 1 from booking_availability a where a.event_type_id = t.id and a.day_of_week = 2);

-- Wed 10:30 (proposed, pending MI's yes) – 12:00 (hard stop, confirmed).
insert into booking_availability (event_type_id, day_of_week, start_minute, end_minute)
select t.id, 3, 630, 720 from booking_event_types t where t.slug = 'backpocket-tlc'
  and not exists (select 1 from booking_availability a where a.event_type_id = t.id and a.day_of_week = 3);

-- Thu 10:30 (proposed, pending MI's yes) – 17:30 (hard stop, confirmed;
-- last bookable start falls out of the engine's step math at 17:00).
insert into booking_availability (event_type_id, day_of_week, start_minute, end_minute)
select t.id, 4, 630, 1050 from booking_event_types t where t.slug = 'backpocket-tlc'
  and not exists (select 1 from booking_availability a where a.event_type_id = t.id and a.day_of_week = 4);
