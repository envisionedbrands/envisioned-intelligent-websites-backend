-- Deleting a creative card is a decision: mark its job dismissed so the
-- canvas recovery logic never resurrects it.
alter table public.studio_gen_jobs add column if not exists dismissed boolean not null default false;
