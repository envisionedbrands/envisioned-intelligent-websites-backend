-- Creative jobs carry an explicit output contract so a thumbnail cannot
-- silently fall back to the image model's default aspect ratio.
alter table public.studio_gen_jobs
  add column if not exists asset_type text not null default 'match_reference';

alter table public.studio_gen_jobs
  add column if not exists image_size jsonb not null default '"auto"'::jsonb;
