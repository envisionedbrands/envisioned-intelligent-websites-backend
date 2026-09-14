-- Studio desks pass (§13 house-look x Studio). Additive and idempotent.
--
-- Board-born carousel jobs need a queue. On homes with the content-factory
-- upgrade the carousel_jobs table already exists and only gains columns; on
-- factory-less homes this creates it, because §13 makes the queue useful
-- without any factory: when the content_house_look setting is set, the
-- member's Content Manager hire is the executor — it claims the job, renders
-- per its own law, and attaches the result back to the board node.
--
-- `executor`: 'factory' (a VPS factory worker — optional upgrade) or
-- 'employee' (the Content Manager hire). `result` carries what the hire
-- attaches for on-canvas review: { contact_sheet_url, slide_urls[],
-- scheduled_at } — files in the member's own media storage.
--
-- The content_house_look setting itself is a backend_settings row (starter
-- core) — no schema change needed for it.

create table if not exists public.carousel_jobs (
  id                uuid primary key default gen_random_uuid(),
  requested_by      text not null default 'operator',
  request            text,
  source_article_id  uuid,
  source_title       text,
  source_slug        text,
  status             text not null default 'queued'
    check (status in (
      'queued', 'running', 'writing', 'rendering', 'uploading',
      'ready', 'revision_queued', 'revising', 'approved', 'rejected', 'failed'
    )),
  stage              text not null default 'Queued',
  progress           integer not null default 0 check (progress between 0 and 100),
  run_dir            text,
  post_id            uuid,
  action_id          uuid,
  error              text,
  claimed_at         timestamptz,
  completed_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.carousel_jobs
  add column if not exists executor text not null default 'factory',
  add column if not exists result jsonb;

do $$ begin
  alter table public.carousel_jobs
    add constraint carousel_jobs_executor_check
    check (executor in ('factory', 'employee'));
exception when duplicate_object then null; end $$;

create index if not exists carousel_jobs_created_at_idx
  on public.carousel_jobs (created_at desc);
create index if not exists carousel_jobs_status_idx
  on public.carousel_jobs (status, created_at);
create index if not exists carousel_jobs_executor_status_idx
  on public.carousel_jobs (executor, status, created_at);

alter table public.carousel_jobs enable row level security;

drop policy if exists "service role manages carousel jobs" on public.carousel_jobs;
create policy "service role manages carousel jobs"
  on public.carousel_jobs
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- updated_at trigger: reuse the starter's helper if present, else create a
-- studio-local one (idempotent either way).
create or replace function public.studio_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists carousel_jobs_updated_at on public.carousel_jobs;
create trigger carousel_jobs_updated_at
  before update on public.carousel_jobs
  for each row execute function public.studio_touch_updated_at();
