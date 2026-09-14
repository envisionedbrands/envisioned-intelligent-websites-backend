-- Content Studio — Phase 1 foundations
--
-- The Poppy-class content workspace inside the Digital Home. This migration
-- lays the full data model; Phase 1 uses sources + ingest jobs (the paste-any-
-- URL pipeline), Phase 2 the canvas tables, Phase 4 voice profiles. Edges ARE
-- context membership: a desk only "knows" what is wired to it.

-- ── Sources: every piece of ingested content, own or competitor ─────────────

create table if not exists public.studio_sources (
  id            uuid primary key default gen_random_uuid(),
  url           text not null,
  platform      text not null check (platform in
                  ('youtube','instagram','tiktok','facebook_ads','website','article','upload')),
  kind          text not null default 'inspiration' check (kind in
                  ('own','competitor','inspiration')),
  status        text not null default 'pending' check (status in
                  ('pending','ingesting','ready','failed')),
  title         text,
  author        text,
  seconds       integer,
  published_at  timestamptz,
  transcript    text,
  -- analysis: { hook, structure_beats[], why_it_worked, topics[], format, tone }
  analysis      jsonb,
  -- engagement at capture: { views, likes, comments, followers, engagement_rate }
  engagement    jsonb,
  -- the human annotation channel ("add notes for AI to use")
  notes         text,
  -- mirror provenance: 'video_transcripts' | 'content_calendar' | null (pasted)
  mirrored_from text,
  mirror_key    text,
  added_by      text not null default 'owner',
  added_at      timestamptz not null default now(),
  refreshed_at  timestamptz not null default now()
);

create unique index if not exists studio_sources_url_idx on public.studio_sources (url);
create unique index if not exists studio_sources_mirror_idx
  on public.studio_sources (mirrored_from, mirror_key) where mirrored_from is not null;
create index if not exists studio_sources_kind_idx on public.studio_sources (kind, platform);

-- ── Ingest jobs: the runner's queue (carousel_jobs pattern) ─────────────────

create table if not exists public.studio_ingest_jobs (
  id           uuid primary key default gen_random_uuid(),
  source_id    uuid not null references public.studio_sources(id) on delete cascade,
  status       text not null default 'queued' check (status in
                 ('queued','claimed','fetching','transcribing','analyzing','ready','failed')),
  stage        text not null default 'Queued for the studio runner',
  progress     integer not null default 0 check (progress between 0 and 100),
  runner_id    text,
  error        text,
  attempts     integer not null default 0,
  claimed_at   timestamptz,
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists studio_ingest_jobs_status_idx
  on public.studio_ingest_jobs (status, created_at);

-- ── Canvas (Phase 2 consumes these; inert until then) ───────────────────────

create table if not exists public.studio_boards (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  template_key text,
  viewport     jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.studio_nodes (
  id         uuid primary key default gen_random_uuid(),
  board_id   uuid not null references public.studio_boards(id) on delete cascade,
  kind       text not null check (kind in ('source','desk','note','sop','group','output')),
  parent_id  uuid references public.studio_nodes(id) on delete set null,
  position   jsonb not null default '{"x":0,"y":0}',
  data       jsonb not null default '{}',
  source_id  uuid references public.studio_sources(id) on delete set null,
  desk_id    uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists studio_nodes_board_idx on public.studio_nodes (board_id);

create table if not exists public.studio_edges (
  id         uuid primary key default gen_random_uuid(),
  board_id   uuid not null references public.studio_boards(id) on delete cascade,
  from_node  uuid not null references public.studio_nodes(id) on delete cascade,
  to_node    uuid not null references public.studio_nodes(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists studio_edges_board_idx on public.studio_edges (board_id);

create table if not exists public.studio_desks (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  persona            text not null default 'none' check (persona in
                       ('none','content-manager','beacon')),
  sop                text,
  model              text not null default 'claude-sonnet-4-6',
  max_context_tokens integer not null default 60000,
  settings           jsonb not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists public.studio_desk_messages (
  id         uuid primary key default gen_random_uuid(),
  desk_id    uuid not null references public.studio_desks(id) on delete cascade,
  role       text not null check (role in ('user','assistant')),
  content    text not null,
  meta       jsonb,
  created_at timestamptz not null default now()
);

create index if not exists studio_desk_messages_desk_idx
  on public.studio_desk_messages (desk_id, created_at);

-- ── Living memory: versioned generated voice profiles (Phase 4 fills) ───────

create table if not exists public.voice_profiles (
  id           uuid primary key default gen_random_uuid(),
  version      integer not null,
  profile      jsonb not null,
  source_count integer not null default 0,
  generated_at timestamptz not null default now()
);

create unique index if not exists voice_profiles_version_idx
  on public.voice_profiles (version);

-- ── RLS: service-role only, like video_transcripts — UI goes through the
--    worker's server routes with the admin client. ──────────────────────────

do $$
declare t text;
begin
  foreach t in array array[
    'studio_sources','studio_ingest_jobs','studio_boards','studio_nodes',
    'studio_edges','studio_desks','studio_desk_messages','voice_profiles'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "service role manages %s" on public.%I', t, t);
    execute format(
      'create policy "service role manages %s" on public.%I for all using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'')',
      t, t);
  end loop;
end $$;

-- updated_at touch triggers

create or replace function public.touch_studio_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'studio_ingest_jobs_touch:studio_ingest_jobs',
    'studio_boards_touch:studio_boards','studio_nodes_touch:studio_nodes',
    'studio_desks_touch:studio_desks'
  ] loop
    execute format('drop trigger if exists %s on public.%s',
      split_part(t, ':', 1), split_part(t, ':', 2));
    execute format(
      'create trigger %s before update on public.%s for each row execute function public.touch_studio_updated_at()',
      split_part(t, ':', 1), split_part(t, ':', 2));
  end loop;
end $$;
