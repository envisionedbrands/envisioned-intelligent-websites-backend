-- Studio 1.6.3 — atomic whole-board saves
--
-- A board graph is one document even though it is stored in nodes + edges.
-- Saving those tables through separate PostgREST requests allowed a process or
-- transport failure between phases to leave a half-new graph. The browser then
-- correctly saw a different server base and refused to apply its recovery
-- snapshot. Keep the complete replacement and its optimistic revision check in
-- one Postgres transaction instead.

alter table public.studio_boards
  add column if not exists graph_revision bigint;

update public.studio_boards
set graph_revision = 0
where graph_revision is null;

alter table public.studio_boards
  alter column graph_revision set default 0,
  alter column graph_revision set not null;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'studio_boards_graph_revision_check'
       and conrelid = 'public.studio_boards'::regclass
  ) then
    alter table public.studio_boards
      add constraint studio_boards_graph_revision_check
      check (graph_revision >= 0);
  end if;
end $$;

-- The 1.6.3 candidate was exercised in-place while these earlier additive
-- migrations were still being hardened. Reassert their final index set in the
-- last migration so a Home that already recorded an earlier candidate does
-- not need a database rebuild. A same-name index with the wrong definition is
-- deliberately not replaced; the readiness contract below will fail closed.
create unique index if not exists studio_gen_jobs_provider_request_idx
  on public.studio_gen_jobs (provider_request_id)
  where provider_request_id is not null;
create index if not exists studio_gen_jobs_recovery_idx
  on public.studio_gen_jobs (status, updated_at)
  where status in ('claimed','generating');
create index if not exists studio_gen_jobs_materialization_idx
  on public.studio_gen_jobs (board_id, created_at desc)
  where materialized_at is null
    and dismissed = false
    and status in ('ready','failed','submission_unknown');

create index if not exists studio_upload_receipts_cleanup_pending_idx
  on public.studio_upload_receipts (status, updated_at)
  where status = 'cleanup_pending';
create index if not exists studio_upload_receipts_purge_pending_idx
  on public.studio_upload_receipts (status, updated_at)
  where status = 'purge_pending';
create index if not exists studio_upload_receipts_purged_idx
  on public.studio_upload_receipts (status, updated_at)
  where status = 'purged';

create or replace function public.studio_save_board_graph(
  p_board_id uuid,
  p_expected_revision bigint,
  p_nodes jsonb,
  p_edges jsonb,
  p_viewport jsonb default null,
  p_has_viewport boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_revision bigint;
  v_node_count integer;
  v_edge_count integer;
  v_affected integer;
begin
  if jsonb_typeof(coalesce(p_nodes, 'null'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_edges, 'null'::jsonb)) <> 'array' then
    return jsonb_build_object('state', 'invalid_payload');
  end if;
  v_node_count := jsonb_array_length(p_nodes);
  v_edge_count := jsonb_array_length(p_edges);

  select graph_revision
    into v_revision
    from public.studio_boards
   where id = p_board_id
     and status = 'ready'
   for update;

  if not found then
    return jsonb_build_object('state', 'not_found');
  end if;

  if p_expected_revision is null or p_expected_revision <> v_revision then
    return jsonb_build_object(
      'state', 'conflict',
      'current_revision', v_revision
    );
  end if;

  -- UUIDs are global primary keys. Refuse a stale/corrupt canvas before the
  -- first write instead of letting ON CONFLICT move another board's rows.
  if exists (
    select 1
      from public.studio_nodes existing
      join jsonb_to_recordset(p_nodes) as incoming(id uuid) on incoming.id = existing.id
     where existing.board_id <> p_board_id
  ) then
    return jsonb_build_object('state', 'foreign_node');
  end if;
  if exists (
    select 1
      from public.studio_edges existing
      join jsonb_to_recordset(p_edges) as incoming(id uuid) on incoming.id = existing.id
     where existing.board_id <> p_board_id
  ) then
    return jsonb_build_object('state', 'foreign_edge');
  end if;

  insert into public.studio_nodes (
    id, board_id, kind, parent_id, position, data, source_id, desk_id
  )
  select
    incoming.id,
    p_board_id,
    incoming.kind,
    incoming.parent_id,
    incoming.position,
    coalesce(incoming.data, '{}'::jsonb),
    incoming.source_id,
    incoming.desk_id
  from jsonb_to_recordset(p_nodes) as incoming(
    id uuid,
    kind text,
    parent_id uuid,
    position jsonb,
    data jsonb,
    source_id uuid,
    desk_id uuid
  )
  on conflict (id) do update set
    kind = excluded.kind,
    parent_id = excluded.parent_id,
    position = excluded.position,
    data = excluded.data,
    source_id = excluded.source_id,
    desk_id = excluded.desk_id
  where studio_nodes.board_id = p_board_id;

  get diagnostics v_affected = row_count;
  if v_affected <> v_node_count then
    raise exception 'Studio node replacement did not affect the complete graph';
  end if;

  -- Nodes exist before edges, so FK validation remains immediate. A failure in
  -- this or any later statement rolls the preceding node upsert back too.
  insert into public.studio_edges (id, board_id, from_node, to_node)
  select incoming.id, p_board_id, incoming.from_node, incoming.to_node
  from jsonb_to_recordset(p_edges) as incoming(
    id uuid,
    from_node uuid,
    to_node uuid
  )
  on conflict (id) do update set
    from_node = excluded.from_node,
    to_node = excluded.to_node
  where studio_edges.board_id = p_board_id;

  get diagnostics v_affected = row_count;
  if v_affected <> v_edge_count then
    raise exception 'Studio edge replacement did not affect the complete graph';
  end if;

  delete from public.studio_edges existing
   where existing.board_id = p_board_id
     and not exists (
       select 1
         from jsonb_to_recordset(p_edges) as incoming(id uuid)
        where incoming.id = existing.id
     );

  delete from public.studio_nodes existing
   where existing.board_id = p_board_id
     and not exists (
       select 1
         from jsonb_to_recordset(p_nodes) as incoming(id uuid)
        where incoming.id = existing.id
     );

  update public.studio_boards
     set graph_revision = graph_revision + 1,
         viewport = case when p_has_viewport then p_viewport else viewport end
   where id = p_board_id
  returning graph_revision into v_revision;

  return jsonb_build_object(
    'state', 'saved',
    'board_id', p_board_id,
    'graph_revision', v_revision,
    'node_count', v_node_count,
    'edge_count', v_edge_count
  );
end;
$$;

-- One latest preview per requested desk, without a global 100-message cap or
-- transferring a legacy 500 KB reply just to render a 180-character card.
create or replace function public.studio_latest_desk_previews(p_desk_ids uuid[])
returns table (desk_id uuid, content text)
language sql
stable
security invoker
set search_path = public
as $$
  select distinct on (message.desk_id)
    message.desk_id,
    left(message.content, 2048) as content
  from public.studio_desk_messages message
  where message.desk_id = any(coalesce(p_desk_ids, array[]::uuid[]))
    and message.role = 'assistant'
  order by message.desk_id, message.created_at desc, message.id desc;
$$;

revoke execute on function public.studio_save_board_graph(uuid, bigint, jsonb, jsonb, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.studio_save_board_graph(uuid, bigint, jsonb, jsonb, jsonb, boolean)
  to service_role;

revoke execute on function public.studio_latest_desk_previews(uuid[])
  from public, anon, authenticated;
grant execute on function public.studio_latest_desk_previews(uuid[])
  to service_role;

comment on column public.studio_boards.graph_revision is
  'Optimistic revision for the atomic whole-graph Studio save.';
comment on function public.studio_save_board_graph is
  'Atomically replaces one ready board graph when its expected revision matches.';
comment on function public.studio_latest_desk_previews is
  'Returns one bounded latest assistant preview per requested Studio desk.';

-- Read-only release contract used by the runner's pairing preflight. Checking
-- only one late table is not enough: a manually interrupted or selectively
-- copied install can otherwise run 1.6.3 code against a half-1.6.3 database.
-- Keep the proof inside Postgres so constraint/index/RPC shape and effective
-- RPC access contracts are checked
-- without creating a board, upload, source, job, or paid provider request.
create or replace function public.studio_163_schema_contract()
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_catalog, storage
as $$
declare
  v_board_lifecycle boolean;
  v_atomic_board_save boolean;
  v_generation_recovery boolean;
  v_runner_health boolean;
  v_upload_receipts boolean;
  v_upload_replay boolean;
  v_upload_bucket boolean;
  v_rpc_access boolean;
begin
  select
    count(*) filter (where column_name in ('status', 'graph_revision')) = 2
    and exists (
      select 1
        from pg_catalog.pg_constraint constraint_row
       where constraint_row.conrelid = pg_catalog.to_regclass('public.studio_boards')
         and constraint_row.contype = 'c'
         and position('building' in pg_catalog.pg_get_constraintdef(constraint_row.oid)) > 0
         and position('ready' in pg_catalog.pg_get_constraintdef(constraint_row.oid)) > 0
         and position('failed' in pg_catalog.pg_get_constraintdef(constraint_row.oid)) > 0
    )
    into v_board_lifecycle
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'studio_boards'
     and column_name in ('status', 'graph_revision');

  select
    exists (
      select 1
        from pg_catalog.pg_proc procedure_row
       where procedure_row.oid = pg_catalog.to_regprocedure(
         'public.studio_save_board_graph(uuid,bigint,jsonb,jsonb,jsonb,boolean)'
       )
         and procedure_row.prokind = 'f'
         and procedure_row.prorettype = 'jsonb'::pg_catalog.regtype
         and procedure_row.proretset = false
         and procedure_row.prosecdef = false
         and procedure_row.provolatile = 'v'
    )
    and exists (
      select 1
        from pg_catalog.pg_proc procedure_row
       where procedure_row.oid = pg_catalog.to_regprocedure(
         'public.studio_latest_desk_previews(uuid[])'
       )
         and procedure_row.prokind = 'f'
         and procedure_row.prorettype = 'record'::pg_catalog.regtype
         and procedure_row.proretset = true
         and procedure_row.prosecdef = false
         and procedure_row.provolatile = 's'
    )
    into v_atomic_board_save;

  select
    count(*) filter (where column_name in (
      'provider_request_id',
      'submission_started_at',
      'submitted_at',
      'materialized_at'
    )) = 4
    and exists (
      select 1
        from pg_catalog.pg_constraint constraint_row
       where constraint_row.conrelid = pg_catalog.to_regclass('public.studio_gen_jobs')
         and constraint_row.contype = 'c'
         and position('claimed' in pg_catalog.pg_get_constraintdef(constraint_row.oid)) > 0
         and position('submission_unknown' in pg_catalog.pg_get_constraintdef(constraint_row.oid)) > 0
         and position('cancelled' in pg_catalog.pg_get_constraintdef(constraint_row.oid)) > 0
    )
    and exists (
      select 1
        from pg_catalog.pg_index index_row
       where index_row.indexrelid = pg_catalog.to_regclass(
         'public.studio_gen_jobs_provider_request_idx'
       )
         and index_row.indrelid = pg_catalog.to_regclass('public.studio_gen_jobs')
         and index_row.indisvalid
         and index_row.indisready
         and index_row.indisunique
         and index_row.indnkeyatts = 1
         and pg_catalog.pg_get_indexdef(index_row.indexrelid, 1, true) = 'provider_request_id'
         and position(
           'provider_request_id' in coalesce(
             pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid), ''
           )
         ) > 0
         and position(
           'IS NOT NULL' in coalesce(
             pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid), ''
           )
         ) > 0
    )
    and exists (
      select 1
        from pg_catalog.pg_index index_row
       where index_row.indexrelid = pg_catalog.to_regclass(
         'public.studio_gen_jobs_recovery_idx'
       )
         and index_row.indrelid = pg_catalog.to_regclass('public.studio_gen_jobs')
         and index_row.indisvalid
         and index_row.indisready
         and index_row.indnkeyatts = 2
         and pg_catalog.pg_get_indexdef(index_row.indexrelid, 1, true) = 'status'
         and pg_catalog.pg_get_indexdef(index_row.indexrelid, 2, true) = 'updated_at'
         and position(
           'claimed' in coalesce(
             pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid), ''
           )
         ) > 0
         and position(
           'generating' in coalesce(
             pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid), ''
           )
         ) > 0
    )
    and exists (
      select 1
        from pg_catalog.pg_index index_row
       where index_row.indexrelid = pg_catalog.to_regclass(
         'public.studio_gen_jobs_materialization_idx'
       )
         and index_row.indrelid = pg_catalog.to_regclass('public.studio_gen_jobs')
         and index_row.indisvalid
         and index_row.indisready
         and index_row.indnkeyatts = 2
         and pg_catalog.pg_get_indexdef(index_row.indexrelid, 1, true) = 'board_id'
         and pg_catalog.pg_get_indexdef(index_row.indexrelid, 2, true) = 'created_at'
         and position(
           'created_at DESC' in pg_catalog.pg_get_indexdef(index_row.indexrelid)
         ) > 0
         and position(
           'materialized_at IS NULL' in coalesce(
             pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid), ''
           )
         ) > 0
         and position(
           'dismissed = false' in coalesce(
             pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid), ''
           )
         ) > 0
         and position(
           'submission_unknown' in coalesce(
             pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid), ''
           )
         ) > 0
         and position(
           '''ready''' in coalesce(
             pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid), ''
           )
         ) > 0
         and position(
           '''failed''' in coalesce(
             pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid), ''
           )
         ) > 0
    )
    into v_generation_recovery
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'studio_gen_jobs'
     and column_name in (
       'provider_request_id',
       'submission_started_at',
       'submitted_at',
       'materialized_at'
     );

  select count(*) filter (where column_name in (
    'instance_id', 'status', 'failure_code', 'capabilities', 'last_seen_at'
  )) = 5
    into v_runner_health
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'studio_runner_health'
     and column_name in (
       'instance_id', 'status', 'failure_code', 'capabilities', 'last_seen_at'
     );

  select
    count(*) filter (where column_name in (
      'id',
      'bucket',
      'object_path',
      'public_url',
      'original_name',
      'media',
      'content_type',
      'expected_size',
      'status',
      'source_id',
      'job_id',
      'failure_code',
      'expires_at',
      'completed_at'
    )) = 14
    and exists (
      select 1
        from pg_catalog.pg_proc procedure_row
       where procedure_row.oid = pg_catalog.to_regprocedure(
         'public.studio_complete_upload_receipt(uuid,text,text)'
       )
         and procedure_row.prokind = 'f'
         and procedure_row.prorettype = 'jsonb'::pg_catalog.regtype
         and procedure_row.proretset = false
         and procedure_row.prosecdef = false
         and procedure_row.provolatile = 'v'
    )
    into v_upload_receipts
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'studio_upload_receipts'
     and column_name in (
       'id',
       'bucket',
       'object_path',
       'public_url',
       'original_name',
       'media',
       'content_type',
       'expected_size',
       'status',
       'source_id',
       'job_id',
       'failure_code',
       'expires_at',
       'completed_at'
     );

  select
    exists (
      select 1
        from pg_catalog.pg_constraint constraint_row
       where constraint_row.conrelid = pg_catalog.to_regclass('public.studio_upload_receipts')
         and constraint_row.contype = 'c'
         and position('purge_pending' in pg_catalog.pg_get_constraintdef(constraint_row.oid)) > 0
         and position('purged' in pg_catalog.pg_get_constraintdef(constraint_row.oid)) > 0
    )
    and exists (
      select 1
        from pg_catalog.pg_index index_row
       where index_row.indexrelid = pg_catalog.to_regclass(
         'public.studio_upload_receipts_cleanup_pending_idx'
       )
         and index_row.indrelid = pg_catalog.to_regclass('public.studio_upload_receipts')
         and index_row.indisvalid
         and index_row.indisready
         and index_row.indnkeyatts = 2
         and pg_catalog.pg_get_indexdef(index_row.indexrelid, 1, true) = 'status'
         and pg_catalog.pg_get_indexdef(index_row.indexrelid, 2, true) = 'updated_at'
         and position(
           'cleanup_pending' in coalesce(
             pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid), ''
           )
         ) > 0
    )
    and exists (
      select 1
        from pg_catalog.pg_index index_row
       where index_row.indexrelid = pg_catalog.to_regclass(
         'public.studio_upload_receipts_purge_pending_idx'
       )
         and index_row.indrelid = pg_catalog.to_regclass('public.studio_upload_receipts')
         and index_row.indisvalid
         and index_row.indisready
         and index_row.indnkeyatts = 2
         and pg_catalog.pg_get_indexdef(index_row.indexrelid, 1, true) = 'status'
         and pg_catalog.pg_get_indexdef(index_row.indexrelid, 2, true) = 'updated_at'
         and position(
           'purge_pending' in coalesce(
             pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid), ''
           )
         ) > 0
    )
    and exists (
      select 1
        from pg_catalog.pg_index index_row
       where index_row.indexrelid = pg_catalog.to_regclass(
         'public.studio_upload_receipts_purged_idx'
       )
         and index_row.indrelid = pg_catalog.to_regclass('public.studio_upload_receipts')
         and index_row.indisvalid
         and index_row.indisready
         and index_row.indnkeyatts = 2
         and pg_catalog.pg_get_indexdef(index_row.indexrelid, 1, true) = 'status'
         and pg_catalog.pg_get_indexdef(index_row.indexrelid, 2, true) = 'updated_at'
         and position(
           'purged' in coalesce(
             pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid), ''
           )
         ) > 0
    )
    into v_upload_replay;

  select exists (
    select 1
      from storage.buckets bucket_row
     where bucket_row.id = 'studio-uploads'
       and bucket_row.name = 'studio-uploads'
       and bucket_row.public = true
       and bucket_row.file_size_limit = 20971520
       and coalesce(bucket_row.allowed_mime_types, '{}'::text[]) @> array[
         'image/jpeg',
         'image/png',
         'image/webp',
         'image/gif',
         'application/pdf'
       ]::text[]
       and array[
         'image/jpeg',
         'image/png',
         'image/webp',
         'image/gif',
         'application/pdf'
       ]::text[] @> coalesce(bucket_row.allowed_mime_types, '{}'::text[])
  ) into v_upload_bucket;

  -- `has_function_privilege` resolves effective access, including an
  -- accidental PUBLIC grant. Presence alone cannot prove the browser roles
  -- are outside these service-only mutation/readiness doors.
  select count(*) = 4
    and bool_and(
      pg_catalog.has_function_privilege(
        'service_role', rpc.function_oid, 'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'anon', rpc.function_oid, 'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'authenticated', rpc.function_oid, 'EXECUTE'
      )
    )
    into v_rpc_access
    from unnest(array[
      pg_catalog.to_regprocedure(
        'public.studio_save_board_graph(uuid,bigint,jsonb,jsonb,jsonb,boolean)'
      ),
      pg_catalog.to_regprocedure('public.studio_latest_desk_previews(uuid[])'),
      pg_catalog.to_regprocedure(
        'public.studio_complete_upload_receipt(uuid,text,text)'
      ),
      pg_catalog.to_regprocedure('public.studio_163_schema_contract()')
    ]) as rpc(function_oid)
   where rpc.function_oid is not null;

  return pg_catalog.jsonb_build_object(
    'ready',
      coalesce(v_board_lifecycle, false)
      and coalesce(v_atomic_board_save, false)
      and coalesce(v_generation_recovery, false)
      and coalesce(v_runner_health, false)
      and coalesce(v_upload_receipts, false)
      and coalesce(v_upload_replay, false)
      and coalesce(v_upload_bucket, false)
      and coalesce(v_rpc_access, false),
    'board_lifecycle', coalesce(v_board_lifecycle, false),
    'atomic_board_save', coalesce(v_atomic_board_save, false),
    'generation_recovery', coalesce(v_generation_recovery, false),
    'runner_health', coalesce(v_runner_health, false),
    'upload_receipts', coalesce(v_upload_receipts, false),
    'upload_replay', coalesce(v_upload_replay, false),
    'upload_bucket', coalesce(v_upload_bucket, false),
    'rpc_access', coalesce(v_rpc_access, false)
  );
end;
$$;

revoke execute on function public.studio_163_schema_contract()
  from public, anon, authenticated;
grant execute on function public.studio_163_schema_contract()
  to service_role;

comment on function public.studio_163_schema_contract is
  'Read-only proof that every Studio 1.6.3 database contract is installed.';
