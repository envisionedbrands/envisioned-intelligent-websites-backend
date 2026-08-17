-- Migration 308: the missing link between an article and everything made from it.
--
-- Audited 2026-08-16: content_objects and social_posts had NO relationship.
-- social_posts is video-shaped (video_path, thumbnail_url) and belongs to Clip
-- Studio; nothing tied an essay to a LinkedIn post, a caption or a newsletter.
-- So "one piece of content, repurposed everywhere" was true in conversation and
-- false in the system — MI could not see how it was possible because it wasn't.
--
-- carousel_drafts already got this right (it keys off article_slug). This
-- generalises that idea to every downstream format.

create table if not exists content_derivatives (
  id uuid primary key default uuid_generate_v4(),
  source_content_id uuid not null references content_objects(id) on delete cascade,
  -- linkedin | instagram | facebook | x | newsletter | substack_note | email
  kind text not null,
  title text,
  body text not null,
  -- Hook and CTA kept separate so a weak hook can be reworked without
  -- regenerating the whole piece.
  hook text,
  cta text,
  -- draft → approved → scheduled → published (nothing publishes itself)
  status text not null default 'draft' check (status in ('draft','approved','scheduled','published','archived')),
  scheduled_for timestamptz,
  published_at timestamptz,
  external_url text,
  -- Which generation run produced it, so a batch can be reviewed together.
  run_id uuid,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_derivatives_source on content_derivatives(source_content_id);
create index if not exists idx_derivatives_status on content_derivatives(status, kind);

alter table content_derivatives enable row level security;
