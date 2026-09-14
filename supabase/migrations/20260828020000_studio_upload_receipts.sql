-- Studio direct-upload receipts
--
-- File bytes still move browser -> Supabase Storage. This migration adds the
-- server-side control record that binds a signed path to the file metadata the
-- member selected, plus one transaction for source/job finalisation.

-- `studio-uploads` is an owned bucket contract, but a customized Home may
-- already have used that generic name for something else. Never make an
-- existing private bucket public or rewrite its limits. An exact prior Studio
-- bucket is safe to reuse (including a partially applied 1.6.3 specimen); any
-- incompatible policy stops the migration before another Studio object/table
-- is touched.
do $studio_upload_bucket$
declare
  v_bucket storage.buckets%rowtype;
  v_required_mime_types constant text[] := array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'application/pdf'
  ]::text[];
begin
  select *
    into v_bucket
    from storage.buckets
   where id = 'studio-uploads'
   for update;

  if found then
    if v_bucket.name is distinct from 'studio-uploads'
       or v_bucket.public is distinct from true
       or v_bucket.file_size_limit is distinct from 20971520
       or not (coalesce(v_bucket.allowed_mime_types, '{}'::text[]) @> v_required_mime_types)
       or not (v_required_mime_types @> coalesce(v_bucket.allowed_mime_types, '{}'::text[])) then
      raise exception using
        errcode = '22023',
        message = 'Studio upload bucket conflict: existing "studio-uploads" bucket has an incompatible policy; no changes were applied.';
    end if;
  else
    insert into storage.buckets (
      id,
      name,
      public,
      file_size_limit,
      allowed_mime_types
    )
    values (
      'studio-uploads',
      'studio-uploads',
      true,
      20971520,
      v_required_mime_types
    );
  end if;
end
$studio_upload_bucket$;

create table if not exists public.studio_upload_receipts (
  id             uuid primary key default gen_random_uuid(),
  bucket         text not null default 'studio-uploads'
                   check (bucket = 'studio-uploads'),
  object_path    text not null unique,
  public_url     text not null,
  original_name  text not null check (char_length(original_name) between 1 and 255),
  media          text not null check (media in ('image', 'pdf')),
  content_type   text not null check (content_type in (
                   'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'
                 )),
  expected_size  bigint not null check (expected_size between 1 and 20971520),
  status         text not null default 'prepared' check (status in (
                   'prepared', 'completed', 'rejected', 'expired', 'cleanup_pending',
                   'purge_pending', 'purged'
                 )),
  source_id      uuid unique references public.studio_sources(id) on delete set null,
  job_id         uuid unique references public.studio_ingest_jobs(id) on delete set null,
  failure_code   text,
  expires_at     timestamptz not null,
  completed_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.studio_upload_receipts
  drop constraint if exists studio_upload_receipts_status_check;
alter table public.studio_upload_receipts
  add constraint studio_upload_receipts_status_check check (status in (
    'prepared', 'completed', 'rejected', 'expired', 'cleanup_pending',
    'purge_pending', 'purged'
  ));

alter table public.studio_upload_receipts
  drop constraint if exists studio_upload_receipts_media_metadata_check;
alter table public.studio_upload_receipts
  add constraint studio_upload_receipts_media_metadata_check check (
    (media = 'image'
      and content_type in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')
      and expected_size <= 15728640)
    or
    (media = 'pdf'
      and content_type = 'application/pdf'
      and expected_size <= 20971520)
  );

create index if not exists studio_upload_receipts_cleanup_idx
  on public.studio_upload_receipts (status, expires_at);

create index if not exists studio_upload_receipts_cleanup_pending_idx
  on public.studio_upload_receipts (status, updated_at)
  where status = 'cleanup_pending';

create index if not exists studio_upload_receipts_purge_pending_idx
  on public.studio_upload_receipts (status, updated_at)
  where status = 'purge_pending';

-- `purged` means an absence proof has completed, not that the receipt is
-- unsweepable. Keep a separate bounded audit index so a PUT that lands after
-- the absence listing is discovered and removed by a later pass.
create index if not exists studio_upload_receipts_purged_idx
  on public.studio_upload_receipts (status, updated_at)
  where status = 'purged';

alter table public.studio_upload_receipts enable row level security;
drop policy if exists "service role manages studio_upload_receipts"
  on public.studio_upload_receipts;
create policy "service role manages studio_upload_receipts"
  on public.studio_upload_receipts
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop trigger if exists studio_upload_receipts_touch
  on public.studio_upload_receipts;
create trigger studio_upload_receipts_touch
  before update on public.studio_upload_receipts
  for each row execute function public.touch_studio_updated_at();

-- The Storage object is verified by the API before this function is called.
-- Locking the receipt makes completion safe to retry and makes concurrent
-- completion requests converge on one source and one PDF job.
create or replace function public.studio_complete_upload_receipt(
  p_receipt_id uuid,
  p_kind text default 'inspiration',
  p_notes text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_receipt public.studio_upload_receipts%rowtype;
  v_source public.studio_sources%rowtype;
  v_job public.studio_ingest_jobs%rowtype;
  v_job_json jsonb := 'null'::jsonb;
begin
  if p_kind is null or p_kind not in ('own', 'competitor', 'inspiration') then
    return jsonb_build_object('state', 'invalid_kind');
  end if;
  if char_length(coalesce(p_notes, '')) > 64000 then
    return jsonb_build_object('state', 'invalid_notes');
  end if;

  select *
    into v_receipt
    from public.studio_upload_receipts
   where id = p_receipt_id
   for update;

  if not found then
    return jsonb_build_object('state', 'not_found');
  end if;

  if v_receipt.status = 'completed' then
    select * into v_source
      from public.studio_sources
     where id = v_receipt.source_id;
    if v_receipt.job_id is not null then
      select * into v_job
        from public.studio_ingest_jobs
       where id = v_receipt.job_id;
      v_job_json := to_jsonb(v_job);
    end if;
    if v_source.id is null then
      return jsonb_build_object('state', 'inconsistent');
    end if;
    return jsonb_build_object(
      'state', 'completed',
      'source', to_jsonb(v_source),
      'job', v_job_json
    );
  end if;

  if v_receipt.status <> 'prepared' then
    return jsonb_build_object('state', v_receipt.status);
  end if;

  if v_receipt.expires_at <= now() then
    return jsonb_build_object('state', 'expired');
  end if;

  insert into public.studio_sources (
    url,
    platform,
    kind,
    status,
    title,
    thumbnail,
    transcript,
    notes,
    refreshed_at
  )
  values (
    v_receipt.public_url,
    'upload',
    p_kind,
    case when v_receipt.media = 'image' then 'ready' else 'ingesting' end,
    v_receipt.original_name,
    case when v_receipt.media = 'image' then v_receipt.public_url else null end,
    case when v_receipt.media = 'image'
      then 'Uploaded reference image: ' || v_receipt.original_name
      else null
    end,
    nullif(p_notes, ''),
    now()
  )
  returning * into v_source;

  if v_receipt.media = 'pdf' then
    insert into public.studio_ingest_jobs (
      id,
      source_id,
      status,
      stage,
      progress
    )
    values (
      v_source.id,
      v_source.id,
      'queued',
      'Waiting for the Studio runner',
      5
    )
    returning * into v_job;
    v_job_json := to_jsonb(v_job);
  end if;

  update public.studio_upload_receipts
     set status = 'completed',
         source_id = v_source.id,
         job_id = case when v_receipt.media = 'pdf' then v_job.id else null end,
         failure_code = null,
         completed_at = now()
   where id = v_receipt.id;

  return jsonb_build_object(
    'state', 'completed',
    'source', to_jsonb(v_source),
    'job', v_job_json
  );
end;
$$;

revoke all on function public.studio_complete_upload_receipt(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.studio_complete_upload_receipt(uuid, text, text)
  to service_role;
