-- Studio 1.6.7 — crash-safe HOUSE carousel execution and decisions
--
-- The local renderer may spend on one Anthropic structure pass before it
-- renders/uploads ten deterministic images.  A process crash must therefore
-- distinguish three states: definitely no spend, an ambiguous in-flight
-- spend, and a durable normalized checkpoint that can be resumed without a
-- second spend.  A unique lease token fences every runner mutation.
--
-- Human approve/reject remains a separate, session-authenticated API action.
-- Its database effects are performed by one row-locked RPC so two browsers
-- cannot both decide a carousel or split the post/job state.

-- Runner health is part of the 1.6.7 protocol cutover. A missing or broken
-- local Chrome installation is a safe blocked capability, not an opaque
-- launchd crash loop or permission for an older runner to report ready.
alter table public.studio_runner_health
  drop constraint if exists studio_runner_health_failure_code_check;
alter table public.studio_runner_health
  add constraint studio_runner_health_failure_code_check check (
    failure_code is null or failure_code in (
      'lock_config_invalid',
      'lock_unavailable',
      'lock_squatter',
      'carousel_toolchain_unavailable'
    )
  );

alter table public.carousel_jobs
  add column if not exists claim_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists model_spend_state text,
  add column if not exists structured_payload jsonb,
  add column if not exists materialization_receipt jsonb,
  add column if not exists decision_operation_id uuid,
  add column if not exists decision text,
  add column if not exists decision_scheduled_at timestamptz,
  add column if not exists cleanup_attempts integer not null default 0,
  add column if not exists cleanup_last_error text,
  add column if not exists cleanup_retry_at timestamptz;

update public.carousel_jobs
   set model_spend_state = 'not_started'
 where model_spend_state is null;

-- An active pre-1.6.7 HOUSE job has no durable evidence telling us whether
-- its model request was submitted.  Treat it as ambiguous and let the claim
-- door fail it closed instead of risking a second paid request.
update public.carousel_jobs
   set model_spend_state = 'in_flight',
       lease_expires_at = coalesce(lease_expires_at, now()),
       stage = 'A previous HOUSE run ended without a durable model checkpoint'
 where executor = 'employee'
   and status in ('running', 'writing', 'rendering', 'uploading', 'revising')
   and structured_payload is null;

alter table public.carousel_jobs
  alter column model_spend_state set default 'not_started',
  alter column model_spend_state set not null;

do $$ begin
  alter table public.carousel_jobs
    add constraint carousel_jobs_model_spend_state_check
    check (model_spend_state in ('not_started', 'in_flight', 'checkpointed'));
exception when duplicate_object then null; end $$;

alter table public.carousel_jobs
  drop constraint if exists carousel_jobs_materialization_receipt_check;
alter table public.carousel_jobs
  add constraint carousel_jobs_materialization_receipt_check
  check (
    materialization_receipt is null
    or (
      pg_catalog.jsonb_typeof(materialization_receipt) = 'object'
      and materialization_receipt ->> 'contract_revision' = 'studio_carousel_materialization_v1'
      and materialization_receipt ->> 'content_checksum' ~ '^[0-9a-f]{64}$'
      and pg_catalog.jsonb_typeof(materialization_receipt -> 'media_count') = 'number'
      and materialization_receipt ->> 'media_count' = '10'
    )
  );

do $$ begin
  alter table public.carousel_jobs
    add constraint carousel_jobs_structured_checkpoint_check
    check (
      (model_spend_state = 'checkpointed'
        and structured_payload is not null
        and jsonb_typeof(structured_payload) = 'object')
      or
      (model_spend_state <> 'checkpointed' and structured_payload is null)
    );
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.carousel_jobs
    add constraint carousel_jobs_decision_receipt_check
    check (
      (decision is null and decision_operation_id is null and decision_scheduled_at is null)
      or
      (decision = 'approve' and decision_operation_id is not null and decision_scheduled_at is not null)
      or
      (decision = 'reject' and decision_operation_id is not null and decision_scheduled_at is null)
    );
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.carousel_jobs
    add constraint carousel_jobs_cleanup_attempts_check
    check (cleanup_attempts >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.carousel_jobs
    add constraint carousel_jobs_cleanup_quarantine_check
    check (
      status <> 'cleanup_quarantined'
      or (
        claim_token is not null
        and cleanup_last_error is not null
        and nullif(pg_catalog.btrim(cleanup_last_error), '') is not null
        and completed_at is null
      )
    );
exception when duplicate_object then null; end $$;

-- Cleanup is a durable, unclaimable execution lane. It closes the non-
-- transactional boundary between database rows and object storage: a new
-- renderer cannot reclaim/upload deterministic paths while older cleanup
-- owns them.
alter table public.carousel_jobs drop constraint if exists carousel_jobs_status_check;
alter table public.carousel_jobs
  add constraint carousel_jobs_status_check
  check (status in (
    'queued', 'running', 'writing', 'rendering', 'uploading',
    'ready', 'revision_queued', 'revising', 'approved', 'rejected',
    'cleanup_pending', 'cleanup_quarantined', 'failed'
  ));

create index if not exists carousel_jobs_house_lease_idx
  on public.carousel_jobs (executor, status, lease_expires_at, created_at)
  where executor = 'employee';
create index if not exists carousel_jobs_cleanup_retry_idx
  on public.carousel_jobs (status, cleanup_retry_at, updated_at)
  where status = 'cleanup_pending';

create or replace function public.studio_decide_carousel_operation(
  p_job_id uuid,
  p_decision text,
  p_decision_operation_id uuid,
  p_scheduled_at timestamptz default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_job public.carousel_jobs%rowtype;
  v_post public.social_posts%rowtype;
  v_scheduled_at timestamptz;
begin
  if p_job_id is null
     or p_decision is null
     or p_decision not in ('approve', 'reject')
     or p_decision_operation_id is null then
    raise exception 'invalid Studio carousel decision';
  end if;

  -- One row lock is the decision election point.  Every contender observes
  -- the canonical receipt written by the winner before it can continue.
  select job.* into v_job
    from public.carousel_jobs job
   where job.id = p_job_id
   for update;

  if not found then
    return pg_catalog.jsonb_build_object(
      'state', 'not_found',
      'job_id', p_job_id,
      'decision', p_decision,
      'decision_operation_id', p_decision_operation_id
    );
  end if;

  if v_job.decision_operation_id is not null then
    if v_job.decision_operation_id = p_decision_operation_id
       and v_job.decision = p_decision then
      return pg_catalog.jsonb_build_object(
        'state', 'replayed',
        'job_id', p_job_id,
        'post_id', v_job.post_id,
        'decision', v_job.decision,
        'decision_operation_id', v_job.decision_operation_id,
        'scheduled_at', v_job.decision_scheduled_at
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'state', 'conflict',
      'job_id', p_job_id,
      'post_id', v_job.post_id,
      'decision', p_decision,
      'decision_operation_id', p_decision_operation_id,
      'existing_decision', v_job.decision,
      'scheduled_at', v_job.decision_scheduled_at,
      'reason', 'This carousel has already been decided in another request'
    );
  end if;

  -- Legacy terminal rows may predate the receipt columns.  They still stand.
  if v_job.status in ('approved', 'rejected') then
    return pg_catalog.jsonb_build_object(
      'state', 'conflict',
      'job_id', p_job_id,
      'post_id', v_job.post_id,
      'decision', p_decision,
      'decision_operation_id', p_decision_operation_id,
      'existing_decision', case when v_job.status = 'approved' then 'approve' else 'reject' end,
      'reason', 'This carousel already has a final human decision'
    );
  end if;

  if v_job.status <> 'ready' then
    return pg_catalog.jsonb_build_object(
      'state', 'conflict',
      'job_id', p_job_id,
      'post_id', v_job.post_id,
      'decision', p_decision,
      'decision_operation_id', p_decision_operation_id,
      'reason', 'This carousel is not waiting for human review'
    );
  end if;

  if v_job.post_id is null then
    raise exception 'ready Studio carousel has no draft post';
  end if;

  select post.* into v_post
    from public.social_posts post
   where post.id = v_job.post_id
   for update;
  if not found or v_post.post_type <> 'carousel' then
    raise exception 'ready Studio carousel draft is missing';
  end if;

  -- Both decisions are defined only against the same still-draft post the
  -- human reviewed. A publisher or another workflow may have moved the post
  -- after the board loaded; reject must not then stamp the job rejected while
  -- leaving a scheduled/published post behind.
  if v_post.status <> 'draft' then
    return pg_catalog.jsonb_build_object(
      'state', 'conflict',
      'job_id', p_job_id,
      'post_id', v_job.post_id,
      'decision', p_decision,
      'decision_operation_id', p_decision_operation_id,
      'reason', 'The attached post is no longer the draft reviewed by this decision'
    );
  end if;

  if p_decision = 'approve' then
    v_scheduled_at := p_scheduled_at;
    if v_scheduled_at is null and nullif(v_job.result ->> 'scheduled_at', '') is not null then
      begin
        v_scheduled_at := (v_job.result ->> 'scheduled_at')::timestamptz;
      exception when others then
        v_scheduled_at := null;
      end;
    end if;
    v_scheduled_at := coalesce(v_scheduled_at, now());

    update public.social_posts
       set status = 'scheduled', scheduled_at = v_scheduled_at, error = null
     where id = v_job.post_id;
  else
    -- Reject deliberately leaves the generated post as a draft.
    v_scheduled_at := null;
  end if;

  update public.carousel_jobs
     set status = case when p_decision = 'approve' then 'approved' else 'rejected' end,
         stage = case when p_decision = 'approve' then 'Approved and scheduled' else 'Rejected — kept as a draft' end,
         progress = 100,
         decision = p_decision,
         decision_operation_id = p_decision_operation_id,
         decision_scheduled_at = v_scheduled_at,
         claim_token = null,
         lease_expires_at = null,
         completed_at = now()
   where id = p_job_id;

  return pg_catalog.jsonb_build_object(
    'state', 'applied',
    'job_id', p_job_id,
    'post_id', v_job.post_id,
    'decision', p_decision,
    'decision_operation_id', p_decision_operation_id,
    'scheduled_at', v_scheduled_at
  );
end;
$$;

revoke execute on function public.studio_decide_carousel_operation(uuid,text,uuid,timestamptz)
  from public, anon, authenticated;
grant execute on function public.studio_decide_carousel_operation(uuid,text,uuid,timestamptz)
  to service_role;

drop function if exists public.studio_cleanup_carousel_draft(uuid,uuid);
create or replace function public.studio_cleanup_carousel_draft(
  p_job_id uuid,
  p_claim_token uuid,
  p_error text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_job public.carousel_jobs%rowtype;
  v_post public.social_posts%rowtype;
  v_current_media jsonb;
  v_current_checksum text;
  v_deleted integer;
begin
  if p_job_id is null or p_claim_token is null then
    raise exception 'invalid Studio carousel cleanup receipt';
  end if;

  select job.* into v_job
    from public.carousel_jobs job
   where job.id = p_job_id
   for update;
  if not found then
    return pg_catalog.jsonb_build_object('state', 'not_found', 'job_id', p_job_id);
  end if;
  if v_job.executor <> 'employee'
     or v_job.status in ('ready', 'approved', 'rejected', 'failed')
     or v_job.claim_token is distinct from p_claim_token
     or (
       v_job.status <> 'cleanup_pending'
       and (
         v_job.status not in ('running', 'writing', 'rendering', 'uploading', 'revising')
         or v_job.lease_expires_at is null
         or v_job.lease_expires_at <= now()
       )
     )
     or (v_job.post_id is not null and v_job.post_id <> p_job_id) then
    return pg_catalog.jsonb_build_object('state', 'refused', 'job_id', p_job_id);
  end if;

  select post.* into v_post
    from public.social_posts post
   where post.id = p_job_id
   for update;
  if v_post.id is not null and (
    v_post.status <> 'draft'
    or v_post.post_type <> 'carousel'
    or v_post.created_by <> 'studio-runner'
  ) then
    update public.carousel_jobs
       set status = 'failed',
           stage = 'Member-owned carousel state preserved; automatic cleanup stopped',
           progress = 100,
           error = 'The attached draft changed status, type, or owner after the renderer checkpoint. It was preserved for manual review.',
           claim_token = null,
           lease_expires_at = null,
           completed_at = now()
     where id = p_job_id
       and claim_token = p_claim_token;
    if not found then
      raise exception 'Studio carousel preservation ownership changed';
    end if;
    return pg_catalog.jsonb_build_object(
      'state', 'preserved_conflict',
      'job_id', p_job_id,
      'post_id', p_job_id
    );
  end if;

  if v_post.id is not null then
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'position', media.position,
          'kind', media.kind,
          'path', media.path,
          'url', media.url
        ) order by media.position
      ),
      '[]'::jsonb
    ) into v_current_media
      from public.social_post_media media
     where media.post_id = p_job_id;
    v_current_checksum := pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.jsonb_build_object(
            'title', v_post.title,
            'caption', coalesce(v_post.caption, ''),
            'media', v_current_media
          )::text,
          'UTF8'
        )
      ),
      'hex'
    );
    if v_job.materialization_receipt is null
       or v_job.materialization_receipt ->> 'contract_revision' <> 'studio_carousel_materialization_v1'
       or v_job.materialization_receipt ->> 'content_checksum' is distinct from v_current_checksum then
      update public.carousel_jobs
         set status = 'failed',
             stage = 'Member-edited carousel draft preserved; automatic cleanup stopped',
             progress = 100,
             error = 'The draft changed after the renderer checkpoint. Your edits were preserved; start a new carousel to replace it.',
             claim_token = null,
             lease_expires_at = null,
             completed_at = now()
       where id = p_job_id
         and claim_token = p_claim_token;
      if not found then
        raise exception 'Studio carousel preservation ownership changed';
      end if;
      return pg_catalog.jsonb_build_object(
        'state', 'preserved_conflict',
        'job_id', p_job_id,
        'post_id', p_job_id
      );
    end if;
  end if;

  delete from public.social_post_media where post_id = p_job_id;
  if v_post.id is not null then
    delete from public.social_posts
     where id = p_job_id
       and status = 'draft'
       and post_type = 'carousel'
       and created_by = 'studio-runner';
    get diagnostics v_deleted = row_count;
    if v_deleted <> 1 then
      raise exception 'Studio carousel draft changed during cleanup';
    end if;
  end if;

  update public.carousel_jobs
     set status = 'cleanup_pending',
         stage = 'Cleaning deterministic carousel artifacts before failure',
         error = pg_catalog.left(
           coalesce(nullif(pg_catalog.btrim(p_error), ''), error, 'The local HOUSE renderer could not finish this carousel'),
           400
         ),
         lease_expires_at = null,
         completed_at = null,
         cleanup_attempts = case
           when v_job.status = 'cleanup_pending' then v_job.cleanup_attempts
           else 0
         end,
         cleanup_last_error = case
           when v_job.status = 'cleanup_pending' then v_job.cleanup_last_error
           else null
         end,
         cleanup_retry_at = case
           when v_job.status = 'cleanup_pending' then v_job.cleanup_retry_at
           else null
         end
   where id = p_job_id
     and claim_token = p_claim_token;
  if not found then
    raise exception 'Studio carousel cleanup ownership changed';
  end if;

  return pg_catalog.jsonb_build_object(
    'state', 'cleanup_pending',
    'job_id', p_job_id,
    'post_removed', v_post.id is not null
  );
end;
$$;

revoke execute on function public.studio_cleanup_carousel_draft(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.studio_cleanup_carousel_draft(uuid,uuid,text)
  to service_role;

create or replace function public.studio_complete_carousel_cleanup(
  p_job_id uuid,
  p_claim_token uuid,
  p_error text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_job public.carousel_jobs%rowtype;
begin
  if p_job_id is null or p_claim_token is null then
    raise exception 'invalid Studio carousel cleanup completion receipt';
  end if;
  select job.* into v_job
    from public.carousel_jobs job
   where job.id = p_job_id
   for update;
  if not found then
    return pg_catalog.jsonb_build_object('state', 'not_found', 'job_id', p_job_id);
  end if;
  if v_job.status = 'failed' and v_job.claim_token is null then
    return pg_catalog.jsonb_build_object('state', 'failed', 'job_id', p_job_id);
  end if;
  if v_job.executor <> 'employee'
     or v_job.status <> 'cleanup_pending'
     or v_job.claim_token is distinct from p_claim_token
     or exists (select 1 from public.social_posts where id = p_job_id)
     or exists (select 1 from public.social_post_media where post_id = p_job_id) then
    return pg_catalog.jsonb_build_object('state', 'refused', 'job_id', p_job_id);
  end if;
  update public.carousel_jobs
     set status = 'failed',
         stage = 'Stopped safely after deterministic cleanup',
         progress = 100,
         error = pg_catalog.left(
           coalesce(nullif(pg_catalog.btrim(p_error), ''), 'The local HOUSE renderer could not finish this carousel'),
           400
         ),
         claim_token = null,
         lease_expires_at = null,
         materialization_receipt = null,
         completed_at = now()
   where id = p_job_id
     and status = 'cleanup_pending'
     and claim_token = p_claim_token;
  if not found then
    raise exception 'Studio carousel cleanup completion changed concurrently';
  end if;
  return pg_catalog.jsonb_build_object('state', 'failed', 'job_id', p_job_id);
end;
$$;

revoke execute on function public.studio_complete_carousel_cleanup(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.studio_complete_carousel_cleanup(uuid,uuid,text)
  to service_role;

-- The post and its ten media rows are one lease-fenced database operation.
-- Direct service-role writes from the runner would otherwise be able to
-- commit after lease expiry and interleave with a replacement claimant.
create or replace function public.studio_materialize_carousel_draft(
  p_job_id uuid,
  p_claim_token uuid,
  p_title text,
  p_caption text,
  p_slide_urls jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_job public.carousel_jobs%rowtype;
  v_post public.social_posts%rowtype;
  v_expected_media jsonb;
  v_current_media jsonb;
  v_current_checksum text;
  v_new_receipt jsonb;
  v_media_count integer;
begin
  if p_job_id is null
     or p_claim_token is null
     or nullif(pg_catalog.btrim(p_title), '') is null
     or pg_catalog.length(p_title) > 300
     or pg_catalog.length(coalesce(p_caption, '')) > 2000
     or pg_catalog.jsonb_typeof(p_slide_urls) <> 'array'
     or pg_catalog.jsonb_array_length(p_slide_urls) <> 10
     or exists (
       select 1
         from pg_catalog.jsonb_array_elements(p_slide_urls) item
        where pg_catalog.jsonb_typeof(item) <> 'string'
           or item #>> '{}' !~ '^https?://[^[:space:]]+$'
           or pg_catalog.length(item #>> '{}') > 2048
     )
     or (
       select pg_catalog.count(distinct item #>> '{}')
         from pg_catalog.jsonb_array_elements(p_slide_urls) item
     ) <> 10 then
    raise exception 'invalid Studio carousel materialization receipt';
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'position', item.ordinality - 1,
      'kind', 'image',
      'path', 'carousels/' || p_job_id::text || '/' || pg_catalog.lpad(item.ordinality::text, 2, '0') || '.png',
      'url', item.url
    ) order by item.ordinality
  ) into v_expected_media
    from pg_catalog.jsonb_array_elements_text(p_slide_urls) with ordinality as item(url, ordinality);
  v_new_receipt := pg_catalog.jsonb_build_object(
    'contract_revision', 'studio_carousel_materialization_v1',
    'content_checksum', pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.jsonb_build_object(
            'title', pg_catalog.btrim(p_title),
            'caption', coalesce(p_caption, ''),
            'media', v_expected_media
          )::text,
          'UTF8'
        )
      ),
      'hex'
    ),
    'media_count', 10
  );

  select job.* into v_job
    from public.carousel_jobs job
   where job.id = p_job_id
   for update;
  if not found then
    return pg_catalog.jsonb_build_object('state', 'not_found', 'job_id', p_job_id);
  end if;
  if v_job.executor <> 'employee'
     or v_job.status not in ('running', 'writing', 'rendering', 'uploading', 'revising')
     or v_job.claim_token is distinct from p_claim_token
     or v_job.lease_expires_at is null
     or v_job.lease_expires_at <= now()
     or v_job.model_spend_state <> 'checkpointed'
     or v_job.decision_operation_id is not null
     or (v_job.post_id is not null and v_job.post_id <> p_job_id) then
    return pg_catalog.jsonb_build_object('state', 'refused', 'job_id', p_job_id);
  end if;

  select post.* into v_post
    from public.social_posts post
   where post.id = p_job_id
   for update;
  if v_post.id is null and v_job.materialization_receipt is not null then
    -- The member deleted the visible draft after a committed materialization.
    -- Never resurrect it, but keep the exact token in the durable unclaimable
    -- cleanup lane so the ten deterministic slides/contact sheet are swept.
    update public.carousel_jobs
       set status = 'cleanup_pending',
           stage = 'Deleted carousel draft preserved; cleaning its deterministic storage',
           progress = 100,
           error = 'The materialized draft was removed after the renderer checkpoint. It was not recreated.',
           lease_expires_at = null,
           completed_at = null,
           cleanup_attempts = 0,
           cleanup_last_error = null,
           cleanup_retry_at = null
     where id = p_job_id
       and claim_token = p_claim_token;
    if not found then
      raise exception 'Studio carousel deleted-draft cleanup ownership changed';
    end if;
    return pg_catalog.jsonb_build_object(
      'state', 'cleanup_pending',
      'job_id', p_job_id,
      'post_id', p_job_id,
      'post_removed', true
    );
  end if;

  if v_post.id is not null and (
    v_post.status <> 'draft'
    or v_post.post_type <> 'carousel'
    or v_post.created_by <> 'studio-runner'
  ) then
    update public.carousel_jobs
       set status = 'failed',
           stage = 'Member-owned carousel state preserved; automatic replay stopped',
           progress = 100,
           error = 'The attached draft changed status, type, or owner after the renderer checkpoint. It was preserved for manual review.',
           claim_token = null,
           lease_expires_at = null,
           completed_at = now()
     where id = p_job_id
       and claim_token = p_claim_token;
    if not found then
      raise exception 'Studio carousel preservation ownership changed';
    end if;
    return pg_catalog.jsonb_build_object(
      'state', 'preserved_conflict',
      'job_id', p_job_id,
      'post_id', p_job_id
    );
  end if;

  -- A response-loss retry may encounter the already-visible draft from the
  -- prior materialization. It is safe to overwrite only while the exact
  -- title/caption/media receipt still matches. Any human change wins and is
  -- surfaced as a terminal preservation conflict, never silently replaced.
  if v_post.id is not null then
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'position', media.position,
          'kind', media.kind,
          'path', media.path,
          'url', media.url
        ) order by media.position
      ),
      '[]'::jsonb
    ) into v_current_media
      from public.social_post_media media
     where media.post_id = p_job_id;
    v_current_checksum := pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.jsonb_build_object(
            'title', v_post.title,
            'caption', coalesce(v_post.caption, ''),
            'media', v_current_media
          )::text,
          'UTF8'
        )
      ),
      'hex'
    );
    if v_job.materialization_receipt is null
       or v_job.materialization_receipt ->> 'contract_revision' <> 'studio_carousel_materialization_v1'
       or v_job.materialization_receipt ->> 'content_checksum' is distinct from v_current_checksum then
      update public.carousel_jobs
         set status = 'failed',
             stage = 'Member-edited carousel draft preserved; automatic replay stopped',
             progress = 100,
             error = 'The draft changed after the renderer checkpoint. Your edits were preserved; start a new carousel to replace it.',
             claim_token = null,
             lease_expires_at = null,
             completed_at = now()
       where id = p_job_id
         and claim_token = p_claim_token;
      if not found then
        raise exception 'Studio carousel preservation ownership changed';
      end if;
      return pg_catalog.jsonb_build_object(
        'state', 'preserved_conflict',
        'job_id', p_job_id,
        'post_id', p_job_id
      );
    end if;
  end if;

  if v_post.id is null then
    insert into public.social_posts(id, title, caption, status, post_type, created_by)
    values (
      p_job_id,
      pg_catalog.btrim(p_title),
      coalesce(p_caption, ''),
      'draft',
      'carousel',
      'studio-runner'
    );
  else
    update public.social_posts
       set title = pg_catalog.btrim(p_title),
           caption = coalesce(p_caption, ''),
           error = null
     where id = p_job_id
       and status = 'draft'
       and post_type = 'carousel'
       and created_by = 'studio-runner';
    if not found then
      raise exception 'Studio carousel draft changed during materialization';
    end if;
  end if;

  delete from public.social_post_media where post_id = p_job_id;
  insert into public.social_post_media(post_id, position, kind, path, url)
  select
    p_job_id,
    item.ordinality - 1,
    'image',
    'carousels/' || p_job_id::text || '/' || pg_catalog.lpad(item.ordinality::text, 2, '0') || '.png',
    item.url
    from pg_catalog.jsonb_array_elements_text(p_slide_urls) with ordinality as item(url, ordinality);
  get diagnostics v_media_count = row_count;
  if v_media_count <> 10 then
    raise exception 'Studio carousel materialization did not persist exactly ten media rows';
  end if;

  update public.carousel_jobs
     set post_id = p_job_id,
         materialization_receipt = v_new_receipt,
         stage = 'Draft post and ten media rows checkpointed',
         progress = greatest(progress, 94),
         lease_expires_at = now() + interval '120 seconds'
   where id = p_job_id
     and claim_token = p_claim_token;
  if not found then
    raise exception 'Studio carousel lease changed during materialization';
  end if;

  return pg_catalog.jsonb_build_object(
    'state', 'materialized',
    'job_id', p_job_id,
    'post_id', p_job_id,
    'media_count', v_media_count,
    'materialization_receipt', v_new_receipt
  );
end;
$$;

revoke execute on function public.studio_materialize_carousel_draft(uuid,uuid,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.studio_materialize_carousel_draft(uuid,uuid,text,text,jsonb)
  to service_role;

create or replace function public.studio_167_schema_contract()
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_previous jsonb;
  v_previous_ready boolean;
  v_columns boolean;
  v_constraints boolean;
  v_rpc boolean;
  v_acl boolean;
  v_cleanup_rpc boolean;
  v_cleanup_acl boolean;
  v_cleanup_liveness boolean;
  v_materialize_rpc boolean;
  v_materialize_acl boolean;
begin
  v_previous := public.studio_165_schema_contract();
  v_previous_ready := coalesce((v_previous ->> 'ready')::boolean, false)
    and v_previous ->> 'contract_revision' = 'studio_165_decision_v1';

  select count(*) = 11 into v_columns
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'carousel_jobs'
     and column_name in (
       'claim_token', 'lease_expires_at', 'model_spend_state',
       'structured_payload', 'materialization_receipt', 'decision_operation_id', 'decision',
       'decision_scheduled_at', 'cleanup_attempts', 'cleanup_last_error',
       'cleanup_retry_at'
     );

  select count(*) = 7 into v_constraints
    from pg_catalog.pg_constraint constraint_row
   where constraint_row.conrelid = 'public.carousel_jobs'::regclass
     and constraint_row.contype in ('c')
     and constraint_row.conname in (
       'carousel_jobs_model_spend_state_check',
       'carousel_jobs_materialization_receipt_check',
       'carousel_jobs_structured_checkpoint_check',
       'carousel_jobs_decision_receipt_check',
       'carousel_jobs_cleanup_attempts_check',
       'carousel_jobs_cleanup_quarantine_check',
       'carousel_jobs_status_check'
     );

  select
    exists (
      select 1
        from information_schema.columns column_row
       where column_row.table_schema = 'public'
         and column_row.table_name = 'carousel_jobs'
         and column_row.column_name = 'cleanup_attempts'
         and column_row.is_nullable = 'NO'
         and column_row.column_default is not null
         and position('0' in column_row.column_default) > 0
    )
    and exists (
      select 1
        from pg_catalog.pg_indexes index_row
       where index_row.schemaname = 'public'
         and index_row.tablename = 'carousel_jobs'
         and index_row.indexname = 'carousel_jobs_cleanup_retry_idx'
         and position('cleanup_retry_at' in index_row.indexdef) > 0
         and position('cleanup_pending' in index_row.indexdef) > 0
    )
    and exists (
      select 1
        from pg_catalog.pg_constraint constraint_row
       where constraint_row.conrelid = 'public.carousel_jobs'::regclass
         and constraint_row.conname = 'carousel_jobs_status_check'
         and position('cleanup_quarantined' in pg_catalog.pg_get_constraintdef(constraint_row.oid)) > 0
    )
    into v_cleanup_liveness;

  v_rpc := pg_catalog.to_regprocedure(
    'public.studio_decide_carousel_operation(uuid,text,uuid,timestamp with time zone)'
  ) is not null;
  v_acl := not pg_catalog.has_function_privilege(
      'anon',
      'public.studio_decide_carousel_operation(uuid,text,uuid,timestamp with time zone)',
      'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'authenticated',
      'public.studio_decide_carousel_operation(uuid,text,uuid,timestamp with time zone)',
      'EXECUTE'
    )
    and pg_catalog.has_function_privilege(
      'service_role',
      'public.studio_decide_carousel_operation(uuid,text,uuid,timestamp with time zone)',
      'EXECUTE'
    );
  v_cleanup_rpc := pg_catalog.to_regprocedure(
    'public.studio_cleanup_carousel_draft(uuid,uuid,text)'
  ) is not null
    and pg_catalog.to_regprocedure(
      'public.studio_complete_carousel_cleanup(uuid,uuid,text)'
    ) is not null;
  v_cleanup_acl := not pg_catalog.has_function_privilege(
      'anon', 'public.studio_cleanup_carousel_draft(uuid,uuid,text)', 'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'authenticated', 'public.studio_cleanup_carousel_draft(uuid,uuid,text)', 'EXECUTE'
    )
    and pg_catalog.has_function_privilege(
      'service_role', 'public.studio_cleanup_carousel_draft(uuid,uuid,text)', 'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'anon', 'public.studio_complete_carousel_cleanup(uuid,uuid,text)', 'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'authenticated', 'public.studio_complete_carousel_cleanup(uuid,uuid,text)', 'EXECUTE'
    )
    and pg_catalog.has_function_privilege(
      'service_role', 'public.studio_complete_carousel_cleanup(uuid,uuid,text)', 'EXECUTE'
    );
  v_materialize_rpc := pg_catalog.to_regprocedure(
    'public.studio_materialize_carousel_draft(uuid,uuid,text,text,jsonb)'
  ) is not null;
  v_materialize_acl := not pg_catalog.has_function_privilege(
      'anon', 'public.studio_materialize_carousel_draft(uuid,uuid,text,text,jsonb)', 'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'authenticated', 'public.studio_materialize_carousel_draft(uuid,uuid,text,text,jsonb)', 'EXECUTE'
    )
    and pg_catalog.has_function_privilege(
      'service_role', 'public.studio_materialize_carousel_draft(uuid,uuid,text,text,jsonb)', 'EXECUTE'
    );

  return pg_catalog.jsonb_build_object(
    'contract_revision', 'studio_167_carousel_execution_v1',
    'studio_165_ready', v_previous_ready,
    'carousel_execution_columns', v_columns,
    'carousel_execution_constraints', v_constraints,
    'carousel_decision_rpc', v_rpc,
    'carousel_decision_acl', v_acl,
    'carousel_cleanup_rpc', v_cleanup_rpc,
    'carousel_cleanup_acl', v_cleanup_acl,
    'carousel_cleanup_liveness', v_cleanup_liveness,
    'carousel_materialize_rpc', v_materialize_rpc,
    'carousel_materialize_acl', v_materialize_acl,
    'ready', v_previous_ready and v_columns and v_constraints and v_cleanup_liveness
      and v_rpc and v_acl and v_cleanup_rpc and v_cleanup_acl
      and v_materialize_rpc and v_materialize_acl
  );
end;
$$;

revoke execute on function public.studio_167_schema_contract() from public, anon, authenticated;
grant execute on function public.studio_167_schema_contract() to service_role;
