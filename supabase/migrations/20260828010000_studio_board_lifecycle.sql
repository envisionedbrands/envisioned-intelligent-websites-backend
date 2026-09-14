-- Studio 1.6.3 — template board lifecycle
--
-- Template construction spans several service-role API writes. A board is
-- therefore hidden while it is being assembled and becomes listable/openable
-- only after the complete graph has landed. Existing boards are ready.

alter table public.studio_boards
  add column if not exists status text;

update public.studio_boards
set status = 'ready'
where status is null;

alter table public.studio_boards
  alter column status set default 'ready',
  alter column status set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'studio_boards_status_check'
      and conrelid = 'public.studio_boards'::regclass
  ) then
    alter table public.studio_boards
      add constraint studio_boards_status_check
      check (status in ('building', 'ready', 'failed'));
  end if;
end $$;

create index if not exists studio_boards_status_updated_idx
  on public.studio_boards (status, updated_at desc);

comment on column public.studio_boards.status is
  'Template lifecycle: building boards are hidden until their full graph is ready.';
