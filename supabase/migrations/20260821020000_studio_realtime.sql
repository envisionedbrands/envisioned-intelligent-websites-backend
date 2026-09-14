-- Content Studio — realtime job pickup.
--
-- The runner daemon subscribes to INSERTs on studio_ingest_jobs over
-- Supabase Realtime (an outward websocket from the owner's machine — the
-- sovereignty doctrine holds). Paste → claimed in seconds instead of
-- waiting for a cron pass.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'studio_ingest_jobs'
  ) then
    alter publication supabase_realtime add table public.studio_ingest_jobs;
  end if;
end $$;
