-- Studio 1.6.5 — idempotent, atomic broadcast approval drafts

create table if not exists public.studio_broadcast_operations (
  operation_id uuid primary key,
  payload_hash text not null check (char_length(payload_hash) between 32 and 128),
  state text not null default 'extracting' check (state in ('extracting', 'ready')),
  claim_token uuid,
  workflow_id uuid references public.workflows(id) on delete set null,
  template_id uuid references public.email_templates(id) on delete set null,
  subject text,
  estimated integer check (estimated is null or estimated > 0),
  campaign_tag text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (state = 'extracting' and claim_token is not null and workflow_id is null and template_id is null)
    or
    (state = 'ready' and claim_token is null and workflow_id is not null and template_id is not null
      and subject is not null and estimated is not null and campaign_tag is not null)
  )
);

alter table public.studio_broadcast_operations enable row level security;
revoke all on table public.studio_broadcast_operations from public, anon, authenticated;
grant select, insert, update, delete on table public.studio_broadcast_operations to service_role;

create or replace function public.studio_claim_broadcast_operation(
  p_operation_id uuid,
  p_payload_hash text,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_operation public.studio_broadcast_operations%rowtype;
begin
  if p_operation_id is null or p_claim_token is null or char_length(p_payload_hash) not between 32 and 128 then
    raise exception 'invalid Studio broadcast operation claim';
  end if;

  insert into public.studio_broadcast_operations(operation_id, payload_hash, claim_token)
  values (p_operation_id, p_payload_hash, p_claim_token)
  on conflict (operation_id) do nothing;

  select operation.* into v_operation
    from public.studio_broadcast_operations operation
   where operation.operation_id = p_operation_id
   for update;

  if v_operation.payload_hash <> p_payload_hash then
    return pg_catalog.jsonb_build_object('state', 'conflict');
  end if;

  if v_operation.state = 'ready' then
    return pg_catalog.jsonb_build_object(
      'state', 'ready',
      'workflow_id', v_operation.workflow_id,
      'template_id', v_operation.template_id,
      'subject', v_operation.subject,
      'estimated', v_operation.estimated,
      'campaign_tag', v_operation.campaign_tag
    );
  end if;

  if v_operation.claim_token = p_claim_token then
    return pg_catalog.jsonb_build_object('state', 'claimed');
  end if;

  if v_operation.updated_at < pg_catalog.clock_timestamp() - interval '2 minutes' then
    update public.studio_broadcast_operations
       set claim_token = p_claim_token,
           updated_at = pg_catalog.clock_timestamp()
     where operation_id = p_operation_id;
    return pg_catalog.jsonb_build_object('state', 'claimed');
  end if;

  return pg_catalog.jsonb_build_object('state', 'busy');
end;
$$;

create or replace function public.studio_release_broadcast_operation(
  p_operation_id uuid,
  p_payload_hash text,
  p_claim_token uuid
)
returns boolean
language sql
security invoker
set search_path = public, pg_catalog
as $$
  with removed as (
    delete from public.studio_broadcast_operations
     where operation_id = p_operation_id
       and payload_hash = p_payload_hash
       and state = 'extracting'
       and claim_token = p_claim_token
    returning operation_id
  )
  select exists(select 1 from removed);
$$;

create or replace function public.studio_finalize_broadcast_operation(
  p_operation_id uuid,
  p_payload_hash text,
  p_claim_token uuid,
  p_email jsonb,
  p_audience_mode text,
  p_tags text[],
  p_campaign_intent text,
  p_scheduled_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_operation public.studio_broadcast_operations%rowtype;
  v_subject text;
  v_preheader text;
  v_body_md text;
  v_estimated integer;
  v_template_id uuid;
  v_workflow_id uuid;
  v_campaign_tag text;
  v_tags text[] := coalesce(p_tags, array[]::text[]);
  v_config jsonb;
begin
  select operation.* into v_operation
    from public.studio_broadcast_operations operation
   where operation.operation_id = p_operation_id
   for update;

  if not found then raise exception 'Studio broadcast operation was not claimed'; end if;
  if v_operation.payload_hash <> p_payload_hash then raise exception 'Studio broadcast operation payload changed'; end if;
  if v_operation.state = 'ready' then
    return pg_catalog.jsonb_build_object(
      'state', 'ready',
      'workflow_id', v_operation.workflow_id,
      'template_id', v_operation.template_id,
      'subject', v_operation.subject,
      'estimated', v_operation.estimated,
      'campaign_tag', v_operation.campaign_tag
    );
  end if;
  if v_operation.claim_token <> p_claim_token then raise exception 'Studio broadcast operation is owned by another request'; end if;

  if p_audience_mode not in ('all', 'tags') then raise exception 'invalid Studio broadcast audience mode'; end if;
  if p_audience_mode = 'tags' and cardinality(v_tags) = 0 then raise exception 'tag audience requires at least one tag'; end if;
  if p_audience_mode = 'all' and cardinality(v_tags) <> 0 then raise exception 'all-subscriber audience cannot carry tags'; end if;

  v_subject := nullif(pg_catalog.btrim(p_email ->> 'subject'), '');
  v_preheader := nullif(pg_catalog.btrim(p_email ->> 'preheader'), '');
  v_body_md := nullif(pg_catalog.btrim(p_email ->> 'body_md'), '');
  if v_subject is null or v_body_md is null then raise exception 'extracted email is incomplete'; end if;

  select count(*)::integer into v_estimated
    from public.leads lead
   where lead.email_status = 'subscribed'
     and (
       p_audience_mode = 'all'
       or coalesce(lead.tags, array[]::text[]) && v_tags
     );
  if v_estimated = 0 then raise exception 'No subscribed leads match that audience'; end if;

  insert into public.email_templates(name, subject, preheader, body_md, category, ai_generated)
  values (
    left('Studio broadcast — ' || v_subject, 120),
    v_subject,
    v_preheader,
    v_body_md,
    'studio-broadcast',
    true
  )
  returning id into v_template_id;

  v_campaign_tag := 'bc-' || pg_catalog.to_char(pg_catalog.clock_timestamp(), 'YYYY-MM-DD') || '-' || left(gen_random_uuid()::text, 6);
  v_config := pg_catalog.jsonb_build_object(
    'source', 'studio',
    'campaign_tag', v_campaign_tag,
    'audience_mode', p_audience_mode,
    'tags', pg_catalog.to_jsonb(v_tags),
    'all', p_audience_mode = 'all',
    'estimated', v_estimated,
    'scheduled_at', p_scheduled_at
  );

  insert into public.workflows(
    name, description, status, trigger_type, trigger_config, steps, allow_reenrollment
  ) values (
    left('Broadcast: ' || v_subject, 120),
    coalesce(nullif(pg_catalog.btrim(p_campaign_intent), ''), 'Broadcast from the Content Studio email desk'),
    'draft',
    'tag_added',
    v_config,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'type', 'send_email',
        'config', pg_catalog.jsonb_build_object('template_id', v_template_id)
      )
    ),
    false
  )
  returning id into v_workflow_id;

  update public.studio_broadcast_operations
     set state = 'ready',
         claim_token = null,
         workflow_id = v_workflow_id,
         template_id = v_template_id,
         subject = v_subject,
         estimated = v_estimated,
         campaign_tag = v_campaign_tag,
         updated_at = pg_catalog.clock_timestamp()
   where operation_id = p_operation_id;

  return pg_catalog.jsonb_build_object(
    'state', 'ready',
    'workflow_id', v_workflow_id,
    'template_id', v_template_id,
    'subject', v_subject,
    'estimated', v_estimated,
    'campaign_tag', v_campaign_tag
  );
end;
$$;

revoke execute on function public.studio_claim_broadcast_operation(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.studio_release_broadcast_operation(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.studio_finalize_broadcast_operation(uuid, text, uuid, jsonb, text, text[], text, timestamptz) from public, anon, authenticated;
grant execute on function public.studio_claim_broadcast_operation(uuid, text, uuid) to service_role;
grant execute on function public.studio_release_broadcast_operation(uuid, text, uuid) to service_role;
grant execute on function public.studio_finalize_broadcast_operation(uuid, text, uuid, jsonb, text, text[], text, timestamptz) to service_role;

create or replace function public.studio_165_schema_contract()
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_previous jsonb;
  v_table_ready boolean;
  v_table_shape boolean;
  v_table_access boolean;
  v_rpc_ready boolean;
  v_rpc_access boolean;
begin
  v_previous := public.studio_164_schema_contract();

  select exists (
    select 1 from pg_catalog.pg_class table_row
     where table_row.oid = pg_catalog.to_regclass('public.studio_broadcast_operations')
       and table_row.relkind = 'r'
       and table_row.relrowsecurity
  ) into v_table_ready;

  select count(*) = 11
    and count(*) filter (where column_name = 'operation_id' and data_type = 'uuid' and is_nullable = 'NO') = 1
    and count(*) filter (where column_name = 'payload_hash' and data_type = 'text' and is_nullable = 'NO') = 1
    and count(*) filter (where column_name = 'state' and data_type = 'text' and is_nullable = 'NO') = 1
    and count(*) filter (where column_name = 'claim_token' and data_type = 'uuid') = 1
    and count(*) filter (where column_name = 'workflow_id' and data_type = 'uuid') = 1
    and count(*) filter (where column_name = 'template_id' and data_type = 'uuid') = 1
    and count(*) filter (where column_name = 'subject' and data_type = 'text') = 1
    and count(*) filter (where column_name = 'estimated' and data_type = 'integer') = 1
    and count(*) filter (where column_name = 'campaign_tag' and data_type = 'text') = 1
    and count(*) filter (where column_name = 'created_at' and data_type = 'timestamp with time zone' and is_nullable = 'NO') = 1
    and count(*) filter (where column_name = 'updated_at' and data_type = 'timestamp with time zone' and is_nullable = 'NO') = 1
    into v_table_shape
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'studio_broadcast_operations';

  select
    pg_catalog.has_table_privilege('service_role', 'public.studio_broadcast_operations', 'SELECT')
    and pg_catalog.has_table_privilege('service_role', 'public.studio_broadcast_operations', 'INSERT')
    and pg_catalog.has_table_privilege('service_role', 'public.studio_broadcast_operations', 'UPDATE')
    and pg_catalog.has_table_privilege('service_role', 'public.studio_broadcast_operations', 'DELETE')
    and not pg_catalog.has_table_privilege('anon', 'public.studio_broadcast_operations', 'SELECT')
    and not pg_catalog.has_table_privilege('anon', 'public.studio_broadcast_operations', 'INSERT')
    and not pg_catalog.has_table_privilege('authenticated', 'public.studio_broadcast_operations', 'SELECT')
    and not pg_catalog.has_table_privilege('authenticated', 'public.studio_broadcast_operations', 'INSERT')
    into v_table_access;

  select count(*) = 3 and bool_and(
    procedure_row.prokind = 'f'
    and procedure_row.prosecdef = false
    and procedure_row.provolatile = 'v'
  ) into v_rpc_ready
    from unnest(array[
      pg_catalog.to_regprocedure('public.studio_claim_broadcast_operation(uuid,text,uuid)'),
      pg_catalog.to_regprocedure('public.studio_release_broadcast_operation(uuid,text,uuid)'),
      pg_catalog.to_regprocedure('public.studio_finalize_broadcast_operation(uuid,text,uuid,jsonb,text,text[],text,timestamp with time zone)')
    ]) rpc(function_oid)
    join pg_catalog.pg_proc procedure_row on procedure_row.oid = rpc.function_oid
   where rpc.function_oid is not null;

  select count(*) = 4 and bool_and(
    pg_catalog.has_function_privilege('service_role', rpc.function_oid, 'EXECUTE')
    and not pg_catalog.has_function_privilege('anon', rpc.function_oid, 'EXECUTE')
    and not pg_catalog.has_function_privilege('authenticated', rpc.function_oid, 'EXECUTE')
  ) into v_rpc_access
    from unnest(array[
      pg_catalog.to_regprocedure('public.studio_claim_broadcast_operation(uuid,text,uuid)'),
      pg_catalog.to_regprocedure('public.studio_release_broadcast_operation(uuid,text,uuid)'),
      pg_catalog.to_regprocedure('public.studio_finalize_broadcast_operation(uuid,text,uuid,jsonb,text,text[],text,timestamp with time zone)'),
      pg_catalog.to_regprocedure('public.studio_165_schema_contract()')
    ]) rpc(function_oid)
   where rpc.function_oid is not null;

  return v_previous || pg_catalog.jsonb_build_object(
    'ready', coalesce((v_previous ->> 'ready')::boolean, false)
      and coalesce(v_table_ready, false)
      and coalesce(v_table_shape, false)
      and coalesce(v_table_access, false)
      and coalesce(v_rpc_ready, false)
      and coalesce(v_rpc_access, false),
    'studio_164_ready', coalesce((v_previous ->> 'ready')::boolean, false),
    'broadcast_operation_table', coalesce(v_table_ready, false),
    'broadcast_operation_shape', coalesce(v_table_shape, false),
    'broadcast_operation_access', coalesce(v_table_access, false),
    'broadcast_operation_rpcs', coalesce(v_rpc_ready, false),
    'rpc_access_165', coalesce(v_rpc_access, false)
  );
end;
$$;

revoke execute on function public.studio_165_schema_contract() from public, anon, authenticated;
grant execute on function public.studio_165_schema_contract() to service_role;

comment on table public.studio_broadcast_operations is
  'Idempotency receipts for Studio broadcast extraction and atomic approval-draft creation.';
