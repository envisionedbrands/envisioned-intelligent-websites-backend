-- Studio 1.6.4 — one-snapshot board hydration
--
-- A board open used to make separate PostgREST requests for the board, graph,
-- referenced sources, desks, ingestion progress and desk previews. Besides
-- spending avoidable Worker CPU, those statements could observe different
-- database snapshots. Aggregate the complete browser payload inside one
-- read-only PostgreSQL statement. The JSON document is one PostgREST row, so
-- nested graph arrays are not subject to PostgREST's row response cap.

-- Hydration chooses one deterministic latest job for every referenced source.
-- Legacy Homes can contain more than the canonical one-row-per-source shape,
-- so make that lookup indexed rather than repeatedly sorting the whole queue.
create index if not exists studio_ingest_jobs_source_updated_idx
  on public.studio_ingest_jobs (source_id, updated_at desc, id desc);

create or replace function public.studio_read_board_snapshot(p_board_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with
  board_row as materialized (
    select board.*
      from public.studio_boards board
     where board.id = p_board_id
       and board.status = 'ready'
  ),
  node_rows as materialized (
    select node.*
      from public.studio_nodes node
      join board_row board on board.id = node.board_id
  ),
  edge_rows as materialized (
    select edge.*
      from public.studio_edges edge
      join board_row board on board.id = edge.board_id
  ),
  source_ids as materialized (
    select distinct node.source_id as id
      from node_rows node
     where node.source_id is not null
  ),
  desk_ids as materialized (
    select distinct node.desk_id as id
      from node_rows node
     where node.desk_id is not null
  ),
  latest_jobs as materialized (
    select distinct on (job.source_id)
      job.source_id,
      job.stage,
      job.progress,
      job.status,
      job.error,
      job.created_at,
      job.updated_at,
      job.claimed_at
    from public.studio_ingest_jobs job
    join source_ids source_ref on source_ref.id = job.source_id
    order by job.source_id, job.updated_at desc, job.id desc
  ),
  source_rows as materialized (
    select
      source.id,
      pg_catalog.jsonb_build_object(
        'id', source.id,
        'url', source.url,
        'platform', source.platform,
        'kind', source.kind,
        'status', source.status,
        'title', source.title,
        'author', source.author,
        'seconds', source.seconds,
        'analysis', source.analysis,
        'engagement', source.engagement,
        'notes', source.notes,
        'thumbnail', source.thumbnail,
        'added_at', source.added_at,
        'latest_job', case
          when latest.source_id is null then null
          else pg_catalog.jsonb_build_object(
            'source_id', latest.source_id,
            'stage', latest.stage,
            'progress', latest.progress,
            'status', latest.status,
            'error', latest.error,
            'created_at', latest.created_at,
            'updated_at', latest.updated_at,
            'claimed_at', latest.claimed_at
          )
        end
      ) as payload
    from source_ids source_ref
    join public.studio_sources source on source.id = source_ref.id
    left join latest_jobs latest on latest.source_id = source.id
  ),
  desk_rows as materialized (
    select
      desk.id,
      pg_catalog.jsonb_build_object(
        'id', desk.id,
        'name', desk.name,
        'persona', desk.persona,
        'sop', desk.sop,
        'model', desk.model,
        'max_context_tokens', desk.max_context_tokens
      ) as payload
    from desk_ids desk_ref
    join public.studio_desks desk on desk.id = desk_ref.id
  ),
  preview_rows as materialized (
    select preview.desk_id, preview.content
      from public.studio_latest_desk_previews(
        array(select desk_ref.id from desk_ids desk_ref order by desk_ref.id)
      ) preview
  )
  select case
    when not exists (select 1 from board_row) then
      pg_catalog.jsonb_build_object('state', 'not_found')
    else
      pg_catalog.jsonb_build_object(
        'state', 'ready',
        'board', (select pg_catalog.to_jsonb(board) from board_row board),
        'nodes', coalesce(
          (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(node) order by node.id) from node_rows node),
          '[]'::jsonb
        ),
        'edges', coalesce(
          (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(edge) order by edge.id) from edge_rows edge),
          '[]'::jsonb
        ),
        'sources', coalesce(
          (select pg_catalog.jsonb_agg(source.payload order by source.id) from source_rows source),
          '[]'::jsonb
        ),
        'desks', coalesce(
          (select pg_catalog.jsonb_agg(desk.payload order by desk.id) from desk_rows desk),
          '[]'::jsonb
        ),
        'previews', coalesce(
          (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'desk_id', preview.desk_id,
                'content', preview.content
              )
              order by preview.desk_id
            )
            from preview_rows preview
          ),
          '[]'::jsonb
        ),
        'runner_working', exists (
          select 1
            from public.studio_ingest_jobs active_job
           where active_job.status in ('claimed', 'fetching', 'transcribing', 'analyzing')
        ),
        'counts', pg_catalog.jsonb_build_object(
          'nodes', (select count(*) from node_rows),
          'edges', (select count(*) from edge_rows)
        )
      )
  end;
$$;

revoke execute on function public.studio_read_board_snapshot(uuid)
  from public, anon, authenticated;
grant execute on function public.studio_read_board_snapshot(uuid)
  to service_role;

comment on function public.studio_read_board_snapshot is
  'Returns one transactionally consistent, complete and bounded Studio board hydration document.';

-- Keep the shipped 1.6.3 proof immutable. The 1.6.4 runner preflight asks a
-- new contract that composes the complete previous proof with the hydration
-- function's exact shape and effective access boundary.
create or replace function public.studio_164_schema_contract()
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_previous jsonb;
  v_previous_ready boolean;
  v_board_hydration boolean;
  v_latest_job_index boolean;
  v_rpc_access boolean;
begin
  v_previous := public.studio_163_schema_contract();
  v_previous_ready := coalesce((v_previous ->> 'ready')::boolean, false);

  select exists (
    select 1
      from pg_catalog.pg_proc procedure_row
     where procedure_row.oid = pg_catalog.to_regprocedure(
       'public.studio_read_board_snapshot(uuid)'
     )
       and procedure_row.prokind = 'f'
       and procedure_row.prorettype = 'jsonb'::pg_catalog.regtype
       and procedure_row.proretset = false
       and procedure_row.prosecdef = false
       and procedure_row.provolatile = 's'
  ) into v_board_hydration;

  select exists (
    select 1
      from pg_catalog.pg_index index_row
     where index_row.indexrelid = pg_catalog.to_regclass(
       'public.studio_ingest_jobs_source_updated_idx'
     )
       and index_row.indrelid = pg_catalog.to_regclass('public.studio_ingest_jobs')
       and index_row.indisvalid
       and index_row.indisready
       and not index_row.indisunique
       and index_row.indnkeyatts = 3
       and index_row.indpred is null
       and pg_catalog.pg_get_indexdef(index_row.indexrelid, 1, true) = 'source_id'
       and pg_catalog.pg_get_indexdef(index_row.indexrelid, 2, true) = 'updated_at'
       and pg_catalog.pg_get_indexdef(index_row.indexrelid, 3, true) = 'id'
       and position(
         '(source_id, updated_at DESC, id DESC)'
         in pg_catalog.pg_get_indexdef(index_row.indexrelid)
       ) > 0
  ) into v_latest_job_index;

  select count(*) = 2
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
      pg_catalog.to_regprocedure('public.studio_read_board_snapshot(uuid)'),
      pg_catalog.to_regprocedure('public.studio_164_schema_contract()')
    ]) as rpc(function_oid)
   where rpc.function_oid is not null;

  return v_previous || pg_catalog.jsonb_build_object(
    'ready',
      v_previous_ready
      and coalesce(v_board_hydration, false)
      and coalesce(v_latest_job_index, false)
      and coalesce(v_rpc_access, false),
    'studio_163_ready', v_previous_ready,
    'board_hydration', coalesce(v_board_hydration, false),
    'latest_job_index', coalesce(v_latest_job_index, false),
    'rpc_access_164', coalesce(v_rpc_access, false)
  );
end;
$$;

revoke execute on function public.studio_164_schema_contract()
  from public, anon, authenticated;
grant execute on function public.studio_164_schema_contract()
  to service_role;

comment on function public.studio_164_schema_contract is
  'Read-only proof that Studio 1.6.3 plus the 1.6.4 board hydration contract are installed.';
