-- Studio 1.6.5 — transactional, idempotent broadcast decisions
--
-- Approval used to be split between a workflow status update and browser-side
-- audience tagging. A lost response could therefore leave an active workflow
-- with only part of its audience enrolled. Keep the generic CRM tables and
-- engine intact, but make each Studio decision one database transaction.
--
-- INSTALL CONTRACT: this is a bounded forward-only hardening migration, not
-- create-only SQL. Apply the complete signed file inside one transaction. It
-- replaces two Studio-owned FK definitions, recreates one Studio-only trigger,
-- and manualizes only rows identified by source=studio plus campaign_tag.
-- Never apply or retry individual statements from this file.

-- A workflow owns its queue receipt. The referenced template must remain until
-- that workflow (and therefore its queue receipt) has been removed.
alter table public.studio_broadcast_operations
  drop constraint if exists studio_broadcast_operations_workflow_id_fkey;
alter table public.studio_broadcast_operations
  add constraint studio_broadcast_operations_workflow_id_fkey
  foreign key (workflow_id) references public.workflows(id) on delete cascade;

alter table public.studio_broadcast_operations
  drop constraint if exists studio_broadcast_operations_template_id_fkey;
alter table public.studio_broadcast_operations
  add constraint studio_broadcast_operations_template_id_fkey
  foreign key (template_id) references public.email_templates(id) on delete restrict;

create unique index if not exists studio_broadcast_operations_workflow_id_key
  on public.studio_broadcast_operations(workflow_id)
  where workflow_id is not null;

-- Own the active-enrollment uniqueness invariant used by the decision RPC.
-- If an adopted Home already contains duplicates, migration must stop instead
-- of reporting ready and failing later during a live approval.
create unique index if not exists studio_broadcast_active_enrollment_key
  on public.workflow_enrollments(workflow_id, lead_id)
  where status = 'active';

-- Decisions need their own receipt because a pre-1.6.5 workflow may not have a
-- queue-operation row. The browser keeps one operation id across response-loss
-- retries; another browser necessarily presents a different id and conflicts.
create table if not exists public.studio_broadcast_decisions (
  workflow_id uuid primary key references public.workflows(id) on delete cascade,
  decision_operation_id uuid not null,
  decision text not null,
  campaign_tag text,
  enrolled integer not null,
  decided_at timestamptz not null default now(),
  constraint studio_broadcast_decisions_decision_check check (
    (decision = 'approve' and campaign_tag is not null and enrolled > 0)
    or (decision = 'reject' and enrolled = 0)
  )
);

-- An unreleased review build briefly declared this ID globally unique. The
-- idempotency key is scoped by workflow, whose primary key is already unique.
alter table public.studio_broadcast_decisions
  drop constraint if exists studio_broadcast_decisions_decision_operation_id_key;

alter table public.studio_broadcast_decisions enable row level security;
revoke all on table public.studio_broadcast_decisions from public, anon, authenticated;
grant select, insert, update, delete on table public.studio_broadcast_decisions to service_role;

-- A Studio broadcast is manually enrolled by the decision RPC. Match both the
-- current config and the real pre-1.6.5 shape, which had no audience_mode. If a
-- legacy tag-driven workflow were left active, its missing `tag` key would be a
-- wildcard in the generic CRM trigger engine.
create or replace function public.studio_force_manual_broadcast_trigger()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
begin
  if new.trigger_config ->> 'source' = 'studio'
     and nullif(new.trigger_config ->> 'campaign_tag', '') is not null then
    new.trigger_type := 'manual';
  end if;
  return new;
end;
$$;

revoke execute on function public.studio_force_manual_broadcast_trigger() from public, anon, authenticated;
grant execute on function public.studio_force_manual_broadcast_trigger() to service_role;

drop trigger if exists studio_force_manual_broadcast on public.workflows;
create trigger studio_force_manual_broadcast
  before insert or update of trigger_type, trigger_config on public.workflows
  for each row execute function public.studio_force_manual_broadcast_trigger();

update public.workflows workflow
   set trigger_type = 'manual'
 where workflow.trigger_config ->> 'source' = 'studio'
   and nullif(workflow.trigger_config ->> 'campaign_tag', '') is not null
   and workflow.trigger_type <> 'manual';

create or replace function public.studio_decide_broadcast_operation(
  p_workflow_id uuid,
  p_decision text,
  p_decision_operation_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_workflow public.workflows%rowtype;
  v_operation public.studio_broadcast_operations%rowtype;
  v_receipt public.studio_broadcast_decisions%rowtype;
  v_has_operation boolean := false;
  v_has_receipt boolean := false;
  v_config jsonb;
  v_steps jsonb;
  v_audience_mode text;
  v_audience_tags text[] := array[]::text[];
  v_audience_ids uuid[] := array[]::uuid[];
  v_campaign_tag text;
  v_scheduled_at timestamptz;
  v_wait_minutes integer;
  v_template_id uuid;
  v_subject text;
  v_enrolled integer := 0;
  v_existing_enrollments integer := 0;
  v_activity_at timestamptz;
begin
  if p_workflow_id is null
     or p_decision is null
     or p_decision not in ('approve', 'reject')
     or p_decision_operation_id is null then
    raise exception 'invalid Studio broadcast decision';
  end if;

  -- The workflow lock is the election point for current and legacy broadcasts.
  -- Every decision contender takes locks in this same order.
  select workflow.* into v_workflow
    from public.workflows workflow
   where workflow.id = p_workflow_id
   for update;

  if not found or v_workflow.trigger_config ->> 'source' is distinct from 'studio' then
    return pg_catalog.jsonb_build_object(
      'state', 'not_found',
      'decision', p_decision,
      'decision_operation_id', p_decision_operation_id,
      'workflow_id', p_workflow_id,
      'enrolled', 0
    );
  end if;

  select receipt.* into v_receipt
    from public.studio_broadcast_decisions receipt
   where receipt.workflow_id = p_workflow_id
   for update;
  v_has_receipt := found;

  if v_has_receipt then
    if v_receipt.decision_operation_id = p_decision_operation_id
       and v_receipt.decision = p_decision then
      return pg_catalog.jsonb_build_object(
        'state', 'replayed',
        'decision', v_receipt.decision,
        'decision_operation_id', v_receipt.decision_operation_id,
        'workflow_id', p_workflow_id,
        'campaign_tag', v_receipt.campaign_tag,
        'enrolled', v_receipt.enrolled
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'state', 'conflict',
      'decision', p_decision,
      'decision_operation_id', p_decision_operation_id,
      'workflow_id', p_workflow_id,
      'campaign_tag', v_receipt.campaign_tag,
      'enrolled', v_receipt.enrolled,
      'existing_decision', v_receipt.decision,
      'reason', 'This broadcast has already been decided in another request'
    );
  end if;

  select operation.* into v_operation
    from public.studio_broadcast_operations operation
   where operation.workflow_id = p_workflow_id
   for update;
  v_has_operation := found;

  if v_has_operation and v_operation.state <> 'ready' then
    return pg_catalog.jsonb_build_object(
      'state', 'conflict',
      'decision', p_decision,
      'decision_operation_id', p_decision_operation_id,
      'workflow_id', p_workflow_id,
      'campaign_tag', v_operation.campaign_tag,
      'enrolled', 0,
      'reason', 'The broadcast queue operation is not ready'
    );
  end if;

  v_config := coalesce(v_workflow.trigger_config, '{}'::jsonb);
  v_steps := coalesce(v_workflow.steps, '[]'::jsonb);
  v_campaign_tag := coalesce(
    nullif(v_operation.campaign_tag, ''),
    nullif(v_config ->> 'campaign_tag', '')
  );

  -- Rejection is a safe archive operation and deliberately does not depend on
  -- a valid audience, schedule, or template in a legacy draft.
  if p_decision = 'reject' then
    select count(*)::integer into v_existing_enrollments
      from public.workflow_enrollments enrollment
     where enrollment.workflow_id = p_workflow_id;

    if v_existing_enrollments <> 0 then
      return pg_catalog.jsonb_build_object(
        'state', 'conflict',
        'decision', p_decision,
        'decision_operation_id', p_decision_operation_id,
        'workflow_id', p_workflow_id,
        'campaign_tag', v_campaign_tag,
        'enrolled', v_existing_enrollments,
        'reason', 'An enrolled broadcast cannot be rejected'
      );
    end if;

    if v_workflow.status not in ('draft', 'active', 'archived') then
      return pg_catalog.jsonb_build_object(
        'state', 'conflict',
        'decision', p_decision,
        'decision_operation_id', p_decision_operation_id,
        'workflow_id', p_workflow_id,
        'campaign_tag', v_campaign_tag,
        'enrolled', 0,
        'reason', 'This broadcast status cannot be rejected'
      );
    end if;

    update public.workflows
       set status = 'archived',
           trigger_type = 'manual',
           trigger_config = v_config
             || case when v_campaign_tag is null then '{}'::jsonb
                     else pg_catalog.jsonb_build_object('campaign_tag', v_campaign_tag) end
     where id = p_workflow_id;

    insert into public.studio_broadcast_decisions(
      workflow_id, decision_operation_id, decision, campaign_tag, enrolled
    ) values (
      p_workflow_id, p_decision_operation_id, 'reject', v_campaign_tag, 0
    );

    return pg_catalog.jsonb_build_object(
      'state', 'applied',
      'decision', 'reject',
      'decision_operation_id', p_decision_operation_id,
      'workflow_id', p_workflow_id,
      'campaign_tag', v_campaign_tag,
      'enrolled', 0
    );
  end if;

  if v_workflow.status not in ('draft', 'active') then
    return pg_catalog.jsonb_build_object(
      'state', 'conflict',
      'decision', p_decision,
      'decision_operation_id', p_decision_operation_id,
      'workflow_id', p_workflow_id,
      'campaign_tag', v_campaign_tag,
      'enrolled', 0,
      'reason', 'This broadcast status cannot be approved'
    );
  end if;

  v_audience_mode := coalesce(
    nullif(v_config ->> 'audience_mode', ''),
    case when v_config ->> 'all' = 'true' then 'all' else 'tags' end
  );
  if pg_catalog.jsonb_typeof(v_config -> 'tags') = 'array' then
    select coalesce(
      pg_catalog.array_agg(tag.value order by tag.ordinality)
        filter (where nullif(pg_catalog.btrim(tag.value), '') is not null),
      array[]::text[]
    )
      into v_audience_tags
      from pg_catalog.jsonb_array_elements_text(v_config -> 'tags')
        with ordinality as tag(value, ordinality);
  end if;

  if v_audience_mode not in ('all', 'tags')
     or (v_audience_mode = 'tags' and cardinality(v_audience_tags) = 0) then
    return pg_catalog.jsonb_build_object(
      'state', 'conflict',
      'decision', p_decision,
      'decision_operation_id', p_decision_operation_id,
      'workflow_id', p_workflow_id,
      'campaign_tag', v_campaign_tag,
      'enrolled', 0,
      'reason', 'The broadcast audience is invalid'
    );
  end if;

  v_campaign_tag := coalesce(
    v_campaign_tag,
    'bc-' || pg_catalog.to_char(pg_catalog.clock_timestamp(), 'YYYY-MM-DD')
      || '-' || left(gen_random_uuid()::text, 6)
  );

  begin
    v_scheduled_at := nullif(v_config ->> 'scheduled_at', '')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    return pg_catalog.jsonb_build_object(
      'state', 'conflict',
      'decision', p_decision,
      'decision_operation_id', p_decision_operation_id,
      'workflow_id', p_workflow_id,
      'campaign_tag', v_campaign_tag,
      'enrolled', 0,
      'reason', 'The broadcast schedule is invalid'
    );
  end;

  if pg_catalog.jsonb_typeof(v_steps) <> 'array' then
    return pg_catalog.jsonb_build_object(
      'state', 'conflict',
      'decision', p_decision,
      'decision_operation_id', p_decision_operation_id,
      'workflow_id', p_workflow_id,
      'campaign_tag', v_campaign_tag,
      'enrolled', 0,
      'reason', 'The broadcast email template is missing'
    );
  end if;

  v_template_id := v_operation.template_id;
  if v_template_id is null then
    begin
      select nullif(step.value #>> '{config,template_id}', '')::uuid
        into v_template_id
        from pg_catalog.jsonb_array_elements(v_steps) with ordinality as step(value, ordinality)
       where step.value ->> 'type' = 'send_email'
       order by step.ordinality
       limit 1;
    exception when invalid_text_representation then
      v_template_id := null;
    end;
  end if;

  if v_template_id is null then
    return pg_catalog.jsonb_build_object(
      'state', 'conflict',
      'decision', p_decision,
      'decision_operation_id', p_decision_operation_id,
      'workflow_id', p_workflow_id,
      'campaign_tag', v_campaign_tag,
      'enrolled', 0,
      'reason', 'The broadcast email template is missing'
    );
  end if;

  select template.subject into v_subject
    from public.email_templates template
   where template.id = v_template_id;
  if not found or nullif(pg_catalog.btrim(v_subject), '') is null then
    return pg_catalog.jsonb_build_object(
      'state', 'conflict',
      'decision', p_decision,
      'decision_operation_id', p_decision_operation_id,
      'workflow_id', p_workflow_id,
      'campaign_tag', v_campaign_tag,
      'enrolled', 0,
      'reason', 'The broadcast email template is missing'
    );
  end if;

  -- Lock the exact subscriber set selected by this decision. A legacy active
  -- broadcast may already contain some rows; only missing side effects are
  -- inserted below.
  select coalesce(pg_catalog.array_agg(audience.id order by audience.id), array[]::uuid[])
    into v_audience_ids
    from (
      select lead.id
        from public.leads lead
       where lead.email_status = 'subscribed'
         and (
           v_audience_mode = 'all'
           or coalesce(lead.tags, array[]::text[]) && v_audience_tags
         )
       order by lead.id
       for update
    ) audience;
  v_enrolled := cardinality(v_audience_ids);

  if v_enrolled = 0 then
    return pg_catalog.jsonb_build_object(
      'state', 'conflict',
      'decision', p_decision,
      'decision_operation_id', p_decision_operation_id,
      'workflow_id', p_workflow_id,
      'campaign_tag', v_campaign_tag,
      'enrolled', 0,
      'reason', 'No subscribed leads match the broadcast audience'
    );
  end if;

  v_config := v_config || pg_catalog.jsonb_build_object(
    'campaign_tag', v_campaign_tag,
    'audience_mode', v_audience_mode,
    'tags', pg_catalog.to_jsonb(v_audience_tags),
    'all', v_audience_mode = 'all',
    'estimated', v_enrolled
  );

  if v_scheduled_at is not null
     and v_scheduled_at > pg_catalog.clock_timestamp() + interval '1 minute'
     and (
       pg_catalog.jsonb_array_length(v_steps) = 0
       or v_steps -> 0 ->> 'type' <> 'wait'
     ) then
    v_wait_minutes := greatest(
      1,
      ceiling(extract(epoch from (v_scheduled_at - pg_catalog.clock_timestamp())) / 60.0)::integer
    );
    v_steps := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'type', 'wait',
        'config', pg_catalog.jsonb_build_object('minutes', v_wait_minutes)
      )
    ) || v_steps;
  end if;

  insert into public.crm_tags(name)
  values (v_campaign_tag)
  on conflict (name) do nothing;

  v_activity_at := pg_catalog.clock_timestamp();
  with tagged as (
    update public.leads lead
       set tags = pg_catalog.array_append(coalesce(lead.tags, array[]::text[]), v_campaign_tag),
           last_activity_at = v_activity_at
     where lead.id = any(v_audience_ids)
       and not (v_campaign_tag = any(coalesce(lead.tags, array[]::text[])))
    returning lead.id
  )
  insert into public.lead_activities(lead_id, activity_type, title, body, data, actor)
  select tagged.id,
         'tag_added',
         'Tag added: ' || v_campaign_tag,
         null,
         pg_catalog.jsonb_build_object(
           'tag', v_campaign_tag,
           'source', 'studio:broadcast',
           'workflow_id', p_workflow_id
         ),
         'studio'
    from tagged;

  with enrolled as (
    insert into public.workflow_enrollments(
      workflow_id, lead_id, status, current_step, next_run_at, context
    )
    select p_workflow_id,
           audience_id,
           'active',
           0,
           v_activity_at,
           pg_catalog.jsonb_build_object(
             'source', 'studio:broadcast',
             'campaign_tag', v_campaign_tag
           )
      from unnest(v_audience_ids) as audience(audience_id)
     where not exists (
       select 1
         from public.workflow_enrollments existing
        where existing.workflow_id = p_workflow_id
          and existing.lead_id = audience.audience_id
     )
    on conflict (workflow_id, lead_id) where status = 'active' do nothing
    returning lead_id
  )
  insert into public.lead_activities(lead_id, activity_type, title, body, data, actor)
  select enrolled.lead_id,
         'enrolled',
         'Enrolled in workflow: ' || v_workflow.name,
         null,
         pg_catalog.jsonb_build_object(
           'workflow_id', p_workflow_id,
           'source', 'studio:broadcast'
         ),
         'studio'
    from enrolled;

  update public.leads
     set last_activity_at = v_activity_at
   where id = any(v_audience_ids);

  select count(*)::integer into v_enrolled
    from public.workflow_enrollments enrollment
   where enrollment.workflow_id = p_workflow_id;

  update public.workflows
     set status = 'active',
         trigger_type = 'manual',
         trigger_config = v_config,
         steps = v_steps,
         enrolled_count = v_enrolled
   where id = p_workflow_id;

  insert into public.studio_broadcast_decisions(
    workflow_id, decision_operation_id, decision, campaign_tag, enrolled
  ) values (
    p_workflow_id, p_decision_operation_id, 'approve', v_campaign_tag, v_enrolled
  );

  return pg_catalog.jsonb_build_object(
    'state', 'applied',
    'decision', 'approve',
    'decision_operation_id', p_decision_operation_id,
    'workflow_id', p_workflow_id,
    'campaign_tag', v_campaign_tag,
    'enrolled', v_enrolled
  );
end;
$$;

revoke execute on function public.studio_decide_broadcast_operation(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.studio_decide_broadcast_operation(uuid, text, uuid) to service_role;

create or replace function public.studio_165_schema_contract()
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_previous jsonb;
  v_operation_table boolean;
  v_operation_shape boolean;
  v_operation_access boolean;
  v_decision_table boolean;
  v_decision_shape boolean;
  v_decision_access boolean;
  v_decision_constraints boolean;
  v_queue_rpcs boolean;
  v_decision_rpc boolean;
  v_rpc_access boolean;
  v_parent_fks boolean;
  v_receipt_indexes boolean;
  v_enrollment_index boolean;
  v_manual_trigger boolean;
  v_manual_trigger_acl boolean;
begin
  v_previous := public.studio_164_schema_contract();

  select exists (
    select 1 from pg_catalog.pg_class table_row
     where table_row.oid = pg_catalog.to_regclass('public.studio_broadcast_operations')
       and table_row.relkind = 'r'
       and table_row.relrowsecurity
  ) into v_operation_table;

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
    into v_operation_shape
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
    and not pg_catalog.has_table_privilege('anon', 'public.studio_broadcast_operations', 'UPDATE')
    and not pg_catalog.has_table_privilege('anon', 'public.studio_broadcast_operations', 'DELETE')
    and not pg_catalog.has_table_privilege('authenticated', 'public.studio_broadcast_operations', 'SELECT')
    and not pg_catalog.has_table_privilege('authenticated', 'public.studio_broadcast_operations', 'INSERT')
    and not pg_catalog.has_table_privilege('authenticated', 'public.studio_broadcast_operations', 'UPDATE')
    and not pg_catalog.has_table_privilege('authenticated', 'public.studio_broadcast_operations', 'DELETE')
    into v_operation_access;

  select exists (
    select 1 from pg_catalog.pg_class table_row
     where table_row.oid = pg_catalog.to_regclass('public.studio_broadcast_decisions')
       and table_row.relkind = 'r'
       and table_row.relrowsecurity
  ) into v_decision_table;

  select count(*) = 6
    and count(*) filter (where column_name = 'workflow_id' and data_type = 'uuid' and is_nullable = 'NO') = 1
    and count(*) filter (where column_name = 'decision_operation_id' and data_type = 'uuid' and is_nullable = 'NO') = 1
    and count(*) filter (where column_name = 'decision' and data_type = 'text' and is_nullable = 'NO') = 1
    and count(*) filter (where column_name = 'campaign_tag' and data_type = 'text') = 1
    and count(*) filter (where column_name = 'enrolled' and data_type = 'integer' and is_nullable = 'NO') = 1
    and count(*) filter (where column_name = 'decided_at' and data_type = 'timestamp with time zone' and is_nullable = 'NO') = 1
    into v_decision_shape
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'studio_broadcast_decisions';

  select
    pg_catalog.has_table_privilege('service_role', 'public.studio_broadcast_decisions', 'SELECT')
    and pg_catalog.has_table_privilege('service_role', 'public.studio_broadcast_decisions', 'INSERT')
    and pg_catalog.has_table_privilege('service_role', 'public.studio_broadcast_decisions', 'UPDATE')
    and pg_catalog.has_table_privilege('service_role', 'public.studio_broadcast_decisions', 'DELETE')
    and not pg_catalog.has_table_privilege('anon', 'public.studio_broadcast_decisions', 'SELECT')
    and not pg_catalog.has_table_privilege('anon', 'public.studio_broadcast_decisions', 'INSERT')
    and not pg_catalog.has_table_privilege('anon', 'public.studio_broadcast_decisions', 'UPDATE')
    and not pg_catalog.has_table_privilege('anon', 'public.studio_broadcast_decisions', 'DELETE')
    and not pg_catalog.has_table_privilege('authenticated', 'public.studio_broadcast_decisions', 'SELECT')
    and not pg_catalog.has_table_privilege('authenticated', 'public.studio_broadcast_decisions', 'INSERT')
    and not pg_catalog.has_table_privilege('authenticated', 'public.studio_broadcast_decisions', 'UPDATE')
    and not pg_catalog.has_table_privilege('authenticated', 'public.studio_broadcast_decisions', 'DELETE')
    into v_decision_access;

  select count(*) = 3
    and count(*) filter (
      where constraint_row.conname = 'studio_broadcast_decisions_pkey'
        and constraint_row.contype = 'p'
        and constraint_row.convalidated
    ) = 1
    and count(*) filter (
      where constraint_row.conname = 'studio_broadcast_decisions_decision_check'
        and constraint_row.contype = 'c'
        and constraint_row.convalidated
        and pg_catalog.pg_get_constraintdef(constraint_row.oid) like '%approve%'
        and pg_catalog.pg_get_constraintdef(constraint_row.oid) like '%reject%'
    ) = 1
    and count(*) filter (
      where constraint_row.contype = 'f'
        and constraint_row.confrelid = pg_catalog.to_regclass('public.workflows')
        and constraint_row.confdeltype = 'c'
    ) = 1
    into v_decision_constraints
    from pg_catalog.pg_constraint constraint_row
   where constraint_row.conrelid = pg_catalog.to_regclass('public.studio_broadcast_decisions')
     and constraint_row.contype in ('p', 'c', 'f');

  select count(*) = 3 and bool_and(
    procedure_row.prokind = 'f'
    and procedure_row.prosecdef = false
    and procedure_row.provolatile = 'v'
  ) into v_queue_rpcs
    from unnest(array[
      pg_catalog.to_regprocedure('public.studio_claim_broadcast_operation(uuid,text,uuid)'),
      pg_catalog.to_regprocedure('public.studio_release_broadcast_operation(uuid,text,uuid)'),
      pg_catalog.to_regprocedure('public.studio_finalize_broadcast_operation(uuid,text,uuid,jsonb,text,text[],text,timestamp with time zone)')
    ]) rpc(function_oid)
    join pg_catalog.pg_proc procedure_row on procedure_row.oid = rpc.function_oid
   where rpc.function_oid is not null;

  select exists (
    select 1
      from pg_catalog.pg_proc procedure_row
     where procedure_row.oid = pg_catalog.to_regprocedure('public.studio_decide_broadcast_operation(uuid,text,uuid)')
       and procedure_row.prokind = 'f'
       and procedure_row.prosecdef = false
       and procedure_row.provolatile = 'v'
  ) into v_decision_rpc;

  select count(*) = 5 and bool_and(
    pg_catalog.has_function_privilege('service_role', rpc.function_oid, 'EXECUTE')
    and not pg_catalog.has_function_privilege('anon', rpc.function_oid, 'EXECUTE')
    and not pg_catalog.has_function_privilege('authenticated', rpc.function_oid, 'EXECUTE')
  ) into v_rpc_access
    from unnest(array[
      pg_catalog.to_regprocedure('public.studio_claim_broadcast_operation(uuid,text,uuid)'),
      pg_catalog.to_regprocedure('public.studio_release_broadcast_operation(uuid,text,uuid)'),
      pg_catalog.to_regprocedure('public.studio_finalize_broadcast_operation(uuid,text,uuid,jsonb,text,text[],text,timestamp with time zone)'),
      pg_catalog.to_regprocedure('public.studio_decide_broadcast_operation(uuid,text,uuid)'),
      pg_catalog.to_regprocedure('public.studio_165_schema_contract()')
    ]) rpc(function_oid)
   where rpc.function_oid is not null;

  select count(*) = 2
    and count(*) filter (
      where constraint_row.conname = 'studio_broadcast_operations_workflow_id_fkey'
        and constraint_row.confrelid = pg_catalog.to_regclass('public.workflows')
        and constraint_row.confdeltype = 'c'
    ) = 1
    and count(*) filter (
      where constraint_row.conname = 'studio_broadcast_operations_template_id_fkey'
        and constraint_row.confrelid = pg_catalog.to_regclass('public.email_templates')
        and constraint_row.confdeltype = 'r'
    ) = 1
    into v_parent_fks
    from pg_catalog.pg_constraint constraint_row
   where constraint_row.conrelid = pg_catalog.to_regclass('public.studio_broadcast_operations')
     and constraint_row.contype = 'f';

  select exists (
    select 1 from pg_catalog.pg_index index_row
     where index_row.indexrelid = pg_catalog.to_regclass('public.studio_broadcast_operations_workflow_id_key')
       and index_row.indrelid = pg_catalog.to_regclass('public.studio_broadcast_operations')
       and index_row.indisunique
       and index_row.indisvalid
       and index_row.indpred is not null
       and pg_catalog.pg_get_indexdef(index_row.indexrelid) like '%(workflow_id)%'
       and pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid) like '%workflow_id IS NOT NULL%'
  ) into v_receipt_indexes;

  select exists (
    select 1 from pg_catalog.pg_index index_row
     where index_row.indexrelid = pg_catalog.to_regclass('public.studio_broadcast_active_enrollment_key')
       and index_row.indrelid = pg_catalog.to_regclass('public.workflow_enrollments')
       and index_row.indisunique
       and index_row.indisvalid
       and index_row.indpred is not null
       and pg_catalog.pg_get_indexdef(index_row.indexrelid) like '%(workflow_id, lead_id)%'
       and pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid) like '%status%active%'
  ) into v_enrollment_index;

  select exists (
    select 1
      from pg_catalog.pg_trigger trigger_row
      join pg_catalog.pg_proc procedure_row on procedure_row.oid = trigger_row.tgfoid
     where trigger_row.tgrelid = pg_catalog.to_regclass('public.workflows')
       and trigger_row.tgname = 'studio_force_manual_broadcast'
       and trigger_row.tgfoid = pg_catalog.to_regprocedure('public.studio_force_manual_broadcast_trigger()')
       and not trigger_row.tgisinternal
       and trigger_row.tgenabled <> 'D'
       and (trigger_row.tgtype & 1) = 1
       and (trigger_row.tgtype & 2) = 2
       and (trigger_row.tgtype & 4) = 4
       and (trigger_row.tgtype & 16) = 16
       and procedure_row.prosecdef = false
       and procedure_row.provolatile = 'v'
       and coalesce(pg_catalog.array_to_string(procedure_row.proconfig, ','), '')
         like '%search_path=public, pg_catalog%'
  ) into v_manual_trigger;

  select
    pg_catalog.has_function_privilege('service_role', 'public.studio_force_manual_broadcast_trigger()', 'EXECUTE')
    and not pg_catalog.has_function_privilege('anon', 'public.studio_force_manual_broadcast_trigger()', 'EXECUTE')
    and not pg_catalog.has_function_privilege('authenticated', 'public.studio_force_manual_broadcast_trigger()', 'EXECUTE')
    into v_manual_trigger_acl;

  return v_previous || pg_catalog.jsonb_build_object(
    'contract_revision', 'studio_165_decision_v1',
    'ready', coalesce((v_previous ->> 'ready')::boolean, false)
      and coalesce(v_operation_table, false)
      and coalesce(v_operation_shape, false)
      and coalesce(v_operation_access, false)
      and coalesce(v_decision_table, false)
      and coalesce(v_decision_shape, false)
      and coalesce(v_decision_access, false)
      and coalesce(v_decision_constraints, false)
      and coalesce(v_queue_rpcs, false)
      and coalesce(v_decision_rpc, false)
      and coalesce(v_rpc_access, false)
      and coalesce(v_parent_fks, false)
      and coalesce(v_receipt_indexes, false)
      and coalesce(v_enrollment_index, false)
      and coalesce(v_manual_trigger, false)
      and coalesce(v_manual_trigger_acl, false),
    'studio_164_ready', coalesce((v_previous ->> 'ready')::boolean, false),
    'broadcast_operation_table', coalesce(v_operation_table, false),
    'broadcast_operation_shape', coalesce(v_operation_shape, false),
    'broadcast_operation_access', coalesce(v_operation_access, false),
    'broadcast_decision_table', coalesce(v_decision_table, false),
    'broadcast_decision_shape', coalesce(v_decision_shape, false),
    'broadcast_decision_access', coalesce(v_decision_access, false),
    'broadcast_decision_constraints', coalesce(v_decision_constraints, false),
    'broadcast_operation_rpcs', coalesce(v_queue_rpcs, false),
    'broadcast_decision_rpc', coalesce(v_decision_rpc, false),
    'broadcast_decision_acl', coalesce(v_rpc_access, false),
    'broadcast_parent_fks', coalesce(v_parent_fks, false),
    'broadcast_receipt_indexes', coalesce(v_receipt_indexes, false),
    'broadcast_enrollment_index', coalesce(v_enrollment_index, false),
    'broadcast_manual_trigger', coalesce(v_manual_trigger, false),
    'broadcast_manual_trigger_acl', coalesce(v_manual_trigger_acl, false),
    'rpc_access_165', coalesce(v_rpc_access, false)
  );
end;
$$;

revoke execute on function public.studio_165_schema_contract() from public, anon, authenticated;
grant execute on function public.studio_165_schema_contract() to service_role;

comment on function public.studio_decide_broadcast_operation(uuid, text, uuid) is
  'Atomically approves or rejects a Studio broadcast. Only a retry with the same decision operation id replays; an independent decision conflicts.';
