-- Migration 305: External calendar feeds — the last gap in native booking.
--
-- Without this, the booking pages don't know about anything in her personal
-- calendar: accept a dentist appointment on Thursday at 11 and the site will
-- happily still offer it. This pulls busy times in as blackouts.
--
-- Deliberately iCal (.ics) rather than Google OAuth: read-only, no Google
-- Cloud project, no consent screen, no app review, and it works identically
-- for Google, Apple and Outlook. The trade-off is refresh lag — Google
-- regenerates a private .ics periodically rather than instantly — so the
-- sync also holds a safety margin (see calendar-sync.ts). If the lag ever
-- causes a real double-book, the upgrade path is the Google freebusy API.

create table if not exists calendar_feeds (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  ics_url text not null,
  is_active boolean not null default true,
  -- Treat every event as busy, or only those marked busy/opaque.
  busy_only boolean not null default true,
  last_synced_at timestamptz,
  last_status text,
  last_error text,
  last_event_count int,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table calendar_feeds enable row level security;

-- Blackouts learn where they came from, so a sync can replace its own rows
-- without touching the ones she created by hand.
alter table booking_blackouts
  add column if not exists source text not null default 'manual',
  add column if not exists feed_id uuid references calendar_feeds(id) on delete cascade,
  add column if not exists external_uid text;

create index if not exists idx_blackouts_feed on booking_blackouts(feed_id);

-- One row per external event per feed; re-syncs update in place.
create unique index if not exists idx_blackouts_external
  on booking_blackouts(feed_id, external_uid)
  where feed_id is not null and external_uid is not null;
