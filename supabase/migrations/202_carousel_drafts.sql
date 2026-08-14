-- Carousel factory: authenticated draft storage (blueprint v0.4.0-beta,
-- adapted). One row per carousel draft; revisions update the SAME row and
-- append to revision_history. Nothing here publishes anything.

create table if not exists carousel_drafts (
  id uuid primary key default gen_random_uuid(),
  article_id uuid references content_objects(id) on delete set null,
  article_slug text not null,
  source_revision text,                     -- hash of the article body at creation
  mode text not null check (mode in ('functional','archetypal')),
  template_id text not null,
  template_version text not null,
  spec jsonb not null,                      -- the full output-contract object
  caption text,
  status text not null default 'draft' check (status in ('draft','approved','archived')),
  revision integer not null default 1,
  revision_history jsonb not null default '[]'::jsonb,
  used_asset_ids text[] not null default '{}',
  errors jsonb,
  created_by text not null default 'agent',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotency: at most one live (non-archived) draft per article+mode, so a
-- retried creation run cannot produce duplicates.
create unique index if not exists idx_carousel_drafts_live
  on carousel_drafts(article_slug, mode) where status != 'archived';

create index if not exists idx_carousel_drafts_status on carousel_drafts(status);

alter table carousel_drafts enable row level security;
-- Service role only (all access goes through authenticated API routes).

-- Review-channel config: backend + Telegram, per MI 2026-08-14. Operator and
-- email are deferred-not-rejected; adding one later = append to channels.
insert into backend_settings (key, value)
values ('carousel_review_channels',
        '{"enabled": true, "primary": "backend", "channels": ["backend","telegram"]}'::jsonb)
on conflict (key) do nothing;
