-- Studio upload replay hardening
--
-- Existing 1.6.3 specimens may already have applied the receipt migration.
-- Add the two-pass purge state separately so upgrades get the same contract as
-- a cold install without rewriting any receipt or Storage object.

alter table public.studio_upload_receipts
  drop constraint if exists studio_upload_receipts_status_check;
alter table public.studio_upload_receipts
  add constraint studio_upload_receipts_status_check check (status in (
    'prepared', 'completed', 'rejected', 'expired', 'cleanup_pending',
    'purge_pending', 'purged'
  ));

create index if not exists studio_upload_receipts_purge_pending_idx
  on public.studio_upload_receipts (status, updated_at)
  where status = 'purge_pending';

-- A verified-absent receipt remains periodically sweepable. Storage and the
-- receipt table cannot retire atomically, so the audit lane closes the narrow
-- list-absent -> state-update window for a still-in-flight signed PUT.
create index if not exists studio_upload_receipts_purged_idx
  on public.studio_upload_receipts (status, updated_at)
  where status = 'purged';
