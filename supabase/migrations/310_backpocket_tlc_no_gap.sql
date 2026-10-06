-- Migration 310: Modern CEO Backpocket TLC — drop the buffer.
--
-- Migration 309 added a 15-minute gap between calls that MI never asked
-- for. It changed the actual bookable times (Tue/Wed down to two slots,
-- Thu's last start at 16:30 instead of 17:00). MI confirmed 2026-10-06:
-- "no, remove the buffer it's ok". Applied live via the API first because
-- the build was time-sensitive; this migration brings the schema source
-- back in sync with what's actually live.

update booking_event_types
set gap_minutes = 0
where slug = 'backpocket-tlc';
