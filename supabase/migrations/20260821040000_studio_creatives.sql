-- Content Studio — creative generation lane (fal.ai).
--
-- A desk reply becomes a fal prompt; the runner claims the gen job, calls
-- fal (house model: GPT Image 2 edit, reference-faithful with on-image
-- text), and the results land back on the canvas as 'creative' nodes wired
-- from the desk. Same queue/claim shape as ingest + carousel jobs.

create table if not exists public.studio_gen_jobs (
  id             uuid primary key default gen_random_uuid(),
  board_id       uuid not null references public.studio_boards(id) on delete cascade,
  desk_node_id   uuid,
  prompt         text not null,
  model          text not null default 'openai/gpt-image-2/edit',
  reference_urls jsonb not null default '[]',
  count          integer not null default 1 check (count between 1 and 4),
  status         text not null default 'queued' check (status in
                   ('queued','claimed','generating','ready','failed')),
  stage          text not null default 'Queued for the studio runner',
  results        jsonb,
  error          text,
  runner_id      text,
  claimed_at     timestamptz,
  completed_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists studio_gen_jobs_board_idx on public.studio_gen_jobs (board_id, created_at);
create index if not exists studio_gen_jobs_status_idx on public.studio_gen_jobs (status, created_at);

alter table public.studio_gen_jobs enable row level security;
drop policy if exists "service role manages studio_gen_jobs" on public.studio_gen_jobs;
create policy "service role manages studio_gen_jobs" on public.studio_gen_jobs
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

drop trigger if exists studio_gen_jobs_touch on public.studio_gen_jobs;
create trigger studio_gen_jobs_touch before update on public.studio_gen_jobs
  for each row execute function public.touch_studio_updated_at();

-- Realtime pickup, same as ingest jobs.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'studio_gen_jobs'
  ) then
    alter publication supabase_realtime add table public.studio_gen_jobs;
  end if;
end $$;

-- Generated images live on the canvas as 'creative' nodes.
alter table public.studio_nodes drop constraint if exists studio_nodes_kind_check;
alter table public.studio_nodes add constraint studio_nodes_kind_check
  check (kind in ('source','desk','note','sop','group','output','creative'));
