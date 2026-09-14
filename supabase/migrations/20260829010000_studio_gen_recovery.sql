-- Studio 1.6.3 — durable generation recovery and safe runner health.

alter table public.studio_gen_jobs
  add column if not exists provider_request_id text,
  add column if not exists submission_started_at timestamptz,
  add column if not exists submitted_at timestamptz,
  add column if not exists materialized_at timestamptz;

alter table public.studio_gen_jobs
  drop constraint if exists studio_gen_jobs_status_check;
alter table public.studio_gen_jobs
  add constraint studio_gen_jobs_status_check check (status in
    ('queued','claimed','generating','ready','failed','submission_unknown','cancelled'));

-- One durable fal request may never be adopted by two local jobs. The partial
-- index keeps all pre-submit/null rows valid.
create unique index if not exists studio_gen_jobs_provider_request_idx
  on public.studio_gen_jobs (provider_request_id)
  where provider_request_id is not null;
create index if not exists studio_gen_jobs_recovery_idx
  on public.studio_gen_jobs (status, updated_at)
  where status in ('claimed','generating');
create index if not exists studio_gen_jobs_materialization_idx
  on public.studio_gen_jobs (board_id, created_at desc)
  where materialized_at is null
    and dismissed = false
    and status in ('ready','failed','submission_unknown');

create table if not exists public.studio_runner_health (
  instance_id    text primary key check (instance_id ~ '^[a-f0-9]{12}$'),
  status         text not null check (status in ('ready','blocked')),
  failure_code   text check (failure_code is null or failure_code in
                   ('lock_config_invalid','lock_unavailable','lock_squatter')),
  capabilities   jsonb not null default '{}'::jsonb,
  last_seen_at   timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint studio_runner_health_failure_shape check (
    (status = 'ready' and failure_code is null)
    or (status = 'blocked' and failure_code is not null)
  )
);

alter table public.studio_runner_health enable row level security;
drop policy if exists "service role manages studio_runner_health" on public.studio_runner_health;
create policy "service role manages studio_runner_health" on public.studio_runner_health
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

drop trigger if exists studio_runner_health_touch on public.studio_runner_health;
create trigger studio_runner_health_touch before update on public.studio_runner_health
  for each row execute function public.touch_studio_updated_at();
