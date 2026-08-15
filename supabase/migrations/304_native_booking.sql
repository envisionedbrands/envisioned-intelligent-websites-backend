-- Migration 304: Native booking — replaces GHL/Cal.com as the booking layer.
--
-- Decision (MI, 2026-08-15): move off GHL entirely, build booking natively in
-- the backend. The `appointments` table, reminder engine and templates already
-- exist (migration 103); what was missing is the *supply* side — what can be
-- booked, when, and the rules that keep her week intact. That's this migration.
--
-- Design notes:
--   * Times are stored as minutes-from-midnight in the OWNER'S timezone, not
--     timestamps. Weekly availability is a recurring rule, not a set of dates.
--   * `gap_minutes` is enforced by the slot engine, never by a vendor setting.
--     (GHL's own buffer field silently failed to prevent back-to-back calls —
--     proved 2026-08-15 — so we generate the grid ourselves.)
--   * Blackouts with a null event_type_id apply to every event type.

create table if not exists booking_event_types (
  id uuid primary key default uuid_generate_v4(),
  slug text unique not null,
  name text not null,
  description text,
  duration_minutes int not null default 30,
  gap_minutes int not null default 15,
  lead_time_hours int not null default 24,
  booking_window_days int not null default 60,
  max_per_day int,
  max_per_month int,
  price_cents int not null default 0,
  currency text not null default 'EUR',
  -- 'video' = live call, 'async' = a delivery block she works in, no call,
  -- 'in_person' = travel/venue
  location_kind text not null default 'video',
  meeting_url text,
  confirmation_note text,
  -- listed on the public site vs private link only (the catch-all is private)
  is_public boolean not null default false,
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Recurring weekly availability. 0 = Sunday … 6 = Saturday.
create table if not exists booking_availability (
  id uuid primary key default uuid_generate_v4(),
  event_type_id uuid not null references booking_event_types(id) on delete cascade,
  day_of_week int not null check (day_of_week between 0 and 6),
  start_minute int not null check (start_minute between 0 and 1439),
  end_minute int not null check (end_minute between 1 and 1440),
  created_at timestamptz default now(),
  check (end_minute > start_minute)
);

create index if not exists idx_booking_avail_type
  on booking_availability(event_type_id, day_of_week);

-- Hard blocks: holidays, the standing client call, anything she closes off.
-- event_type_id null = blocks every event type.
create table if not exists booking_blackouts (
  id uuid primary key default uuid_generate_v4(),
  event_type_id uuid references booking_event_types(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text,
  created_at timestamptz default now(),
  check (ends_at > starts_at)
);

create index if not exists idx_booking_blackouts_window
  on booking_blackouts(starts_at, ends_at);

-- Link appointments back to what was booked (nullable: legacy rows predate this)
alter table appointments
  add column if not exists event_type_id uuid references booking_event_types(id),
  add column if not exists booking_token text,
  add column if not exists guest_timezone text,
  add column if not exists guest_notes text;

-- Self-serve reschedule/cancel links are keyed on this
create unique index if not exists idx_appts_booking_token
  on appointments(booking_token) where booking_token is not null;

create index if not exists idx_appts_event_type
  on appointments(event_type_id, starts_at);

alter table booking_event_types enable row level security;
alter table booking_availability enable row level security;
alter table booking_blackouts   enable row level security;

-- Owner timezone lives in settings so the slot engine and the UI agree.
insert into backend_settings (key, value)
select 'booking_timezone', '"Europe/Amsterdam"'::jsonb
where not exists (select 1 from backend_settings where key = 'booking_timezone');

-- ── Seed: her real operating hours (her words, 2026-08-15) ────────────────
-- Work starts 10:00 every day. Mon = deep work, no calls. Tue = primary call
-- day, 16:00 blocked by a standing client. Wed 10:00–12:00 only (half day).
-- Thu call day, hard stop 16:30 unless client. Fri: nothing.

insert into booking_event_types
  (slug, name, description, duration_minutes, gap_minutes, lead_time_hours,
   max_per_day, price_cents, location_kind, is_public, is_active, sort_order, confirmation_note)
select
  'client-session', 'Client Sessions — 1:1',
  'A session for clients already working with me. Free to book — your programme covers it. Bring the thing you''re stuck on.',
  60, 15, 24, 2, 0, 'video', false, true, 10,
  'See you then. Come with the actual problem, not the tidied-up version.'
where not exists (select 1 from booking_event_types where slug = 'client-session');

insert into booking_event_types
  (slug, name, description, duration_minutes, gap_minutes, lead_time_hours,
   max_per_day, max_per_month, price_cents, location_kind, is_public, is_active, sort_order)
select
  'envisioned-match', 'Envisioned Match',
  'A short conversation to see whether what I build is what you actually need.',
  30, 15, 72, 1, 2, 0, 'video', false, true, 20
where not exists (select 1 from booking_event_types where slug = 'envisioned-match');

insert into booking_event_types
  (slug, name, description, duration_minutes, gap_minutes, lead_time_hours,
   max_per_day, price_cents, location_kind, is_public, is_active, sort_order)
select
  'us-friendly', 'US-Friendly Hours',
  'Evening slots for people working across the Atlantic. Rare and deliberately limited.',
  45, 15, 48, 1, 0, 'video', false, true, 30
where not exists (select 1 from booking_event_types where slug = 'us-friendly');

-- Availability: Client Sessions — Tue 10:00–15:00, Thu 10:00–16:30.
-- Tuesday closes at 15:00 so a 60-min call ends by 14:45+gap, well clear of
-- the 16:00 standing call. Thursday's last call ends 16:00, inside her stop.
insert into booking_availability (event_type_id, day_of_week, start_minute, end_minute)
select t.id, 2, 600, 900 from booking_event_types t where t.slug = 'client-session'
  and not exists (select 1 from booking_availability a where a.event_type_id = t.id and a.day_of_week = 2);
insert into booking_availability (event_type_id, day_of_week, start_minute, end_minute)
select t.id, 4, 600, 990 from booking_event_types t where t.slug = 'client-session'
  and not exists (select 1 from booking_availability a where a.event_type_id = t.id and a.day_of_week = 4);

-- Envisioned Match — Wednesday mornings only, 10:00–12:00.
insert into booking_availability (event_type_id, day_of_week, start_minute, end_minute)
select t.id, 3, 600, 720 from booking_event_types t where t.slug = 'envisioned-match'
  and not exists (select 1 from booking_availability a where a.event_type_id = t.id and a.day_of_week = 3);

-- US-Friendly — Tuesday evenings 20:30–21:30.
insert into booking_availability (event_type_id, day_of_week, start_minute, end_minute)
select t.id, 2, 1230, 1290 from booking_event_types t where t.slug = 'us-friendly'
  and not exists (select 1 from booking_availability a where a.event_type_id = t.id and a.day_of_week = 2);
