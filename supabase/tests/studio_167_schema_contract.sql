\set ON_ERROR_STOP on

-- Run only against a disposable database after the 1.6.7 candidate migration.
do $$
declare v_contract jsonb;
begin
  v_contract := public.studio_167_schema_contract();
  if coalesce((v_contract ->> 'ready')::boolean, false) is not true
     or v_contract ->> 'contract_revision' is distinct from 'studio_167_carousel_execution_v1'
     or coalesce((v_contract ->> 'studio_165_ready')::boolean, false) is not true
     or coalesce((v_contract ->> 'carousel_execution_columns')::boolean, false) is not true
     or coalesce((v_contract ->> 'carousel_execution_constraints')::boolean, false) is not true
     or coalesce((v_contract ->> 'carousel_decision_rpc')::boolean, false) is not true
     or coalesce((v_contract ->> 'carousel_decision_acl')::boolean, false) is not true
     or coalesce((v_contract ->> 'carousel_cleanup_rpc')::boolean, false) is not true
     or coalesce((v_contract ->> 'carousel_cleanup_acl')::boolean, false) is not true
     or coalesce((v_contract ->> 'carousel_cleanup_liveness')::boolean, false) is not true
     or coalesce((v_contract ->> 'carousel_materialize_rpc')::boolean, false) is not true
     or coalesce((v_contract ->> 'carousel_materialize_acl')::boolean, false) is not true then
    raise exception 'Studio 1.6.7 carousel execution contract is incomplete: %', v_contract;
  end if;
end
$$;

begin;

insert into public.social_posts(id,title,caption,post_type,status,created_by)
values
  ('16700000-0000-4000-8000-000000000001','Approve fixture','Approve','carousel','draft','studio-runner'),
  ('16700000-0000-4000-8000-000000000002','Reject fixture','Reject','carousel','draft','studio-runner'),
  ('16700000-0000-4000-8000-000000000004','Protected fixture','Protected','carousel','draft','studio-runner'),
  ('16700000-0000-4000-8000-000000000006','Moved fixture','Moved','carousel','scheduled','studio-runner');

insert into public.carousel_jobs(
  id, requested_by, request, source_title, status, stage, progress, post_id,
  executor, result, model_spend_state
) values
  (
    '16700000-0000-4000-8000-000000000001','studio','Approve','Approve fixture',
    'ready','Ready for review on the board',100,'16700000-0000-4000-8000-000000000001',
    'employee','{}','not_started'
  ),
  (
    '16700000-0000-4000-8000-000000000002','studio','Reject','Reject fixture',
    'ready','Ready for review on the board',100,'16700000-0000-4000-8000-000000000002',
    'employee','{}','not_started'
  ),
  (
    '16700000-0000-4000-8000-000000000003','studio','Cleanup','Cleanup fixture',
    'rendering','Rendering',80,null,
    'employee','{}','not_started'
  ),
  (
    '16700000-0000-4000-8000-000000000004','studio','Protected','Protected fixture',
    'ready','Ready for review on the board',100,'16700000-0000-4000-8000-000000000004',
    'employee','{}','not_started'
  ),
  (
    '16700000-0000-4000-8000-000000000006','studio','Moved','Moved fixture',
    'ready','Ready for review on the board',100,'16700000-0000-4000-8000-000000000006',
    'employee','{}','not_started'
  );

update public.carousel_jobs
   set claim_token = '16700000-0000-4000-8000-000000000033',
       lease_expires_at = now() + interval '2 minutes',
       model_spend_state = 'checkpointed',
       structured_payload = '{}'
 where id = '16700000-0000-4000-8000-000000000003';

insert into public.carousel_jobs(
  id, requested_by, request, source_title, status, stage, progress,
  executor, result, model_spend_state, structured_payload,
  claim_token, lease_expires_at
) values (
  '16700000-0000-4000-8000-000000000005','studio','Materialize','Materialize fixture',
  'rendering','Rendering',90,'employee','{}','checkpointed','{}',
  '16700000-0000-4000-8000-000000000055',now() + interval '2 minutes'
);

insert into public.carousel_jobs(
  id, requested_by, request, source_title, status, stage, progress,
  executor, result, model_spend_state, structured_payload,
  claim_token, lease_expires_at
) values (
  '16700000-0000-4000-8000-000000000007','studio','Edited cleanup','Edited cleanup fixture',
  'rendering','Rendering',90,'employee','{}','checkpointed','{}',
  '16700000-0000-4000-8000-000000000077',now() + interval '2 minutes'
), (
  '16700000-0000-4000-8000-000000000008','studio','Deleted replay','Deleted replay fixture',
  'rendering','Rendering',90,'employee','{}','checkpointed','{}',
  '16700000-0000-4000-8000-000000000088',now() + interval '2 minutes'
), (
  '16700000-0000-4000-8000-000000000009','studio','Moved replay','Moved replay fixture',
  'rendering','Rendering',90,'employee','{}','checkpointed','{}',
  '16700000-0000-4000-8000-000000000099',now() + interval '2 minutes'
), (
  '16700000-0000-4000-8000-000000000010','studio','Moved cleanup','Moved cleanup fixture',
  'rendering','Rendering',90,'employee','{}','checkpointed','{}',
  '16700000-0000-4000-8000-000000000100',now() + interval '2 minutes'
), (
  '16700000-0000-4000-8000-000000000012','studio','Quarantined cleanup','Quarantined cleanup fixture',
  'rendering','Rendering',90,'employee','{}','checkpointed','{}',
  '16700000-0000-4000-8000-000000000120',now() + interval '2 minutes'
);

insert into public.social_post_media(post_id,position,kind,path,url)
values
  ('16700000-0000-4000-8000-000000000004',0,'image','carousels/protected/01.png','https://media.example/protected.png');

do $$
declare
  v_result jsonb;
begin
  v_result := public.studio_materialize_carousel_draft(
    '16700000-0000-4000-8000-000000000003',
    '16700000-0000-4000-8000-000000000033',
    'Cleanup fixture',
    'Cleanup',
    '["https://cleanup.example/01.png","https://cleanup.example/02.png","https://cleanup.example/03.png","https://cleanup.example/04.png","https://cleanup.example/05.png","https://cleanup.example/06.png","https://cleanup.example/07.png","https://cleanup.example/08.png","https://cleanup.example/09.png","https://cleanup.example/10.png"]'::jsonb
  );
  if v_result ->> 'state' <> 'materialized' then
    raise exception 'cleanup fixture did not receive a durable materialization receipt: %', v_result;
  end if;

  v_result := public.studio_materialize_carousel_draft(
    '16700000-0000-4000-8000-000000000007',
    '16700000-0000-4000-8000-000000000077',
    'Edited cleanup fixture',
    'Original caption',
    '["https://edited.example/01.png","https://edited.example/02.png","https://edited.example/03.png","https://edited.example/04.png","https://edited.example/05.png","https://edited.example/06.png","https://edited.example/07.png","https://edited.example/08.png","https://edited.example/09.png","https://edited.example/10.png"]'::jsonb
  );
  if v_result ->> 'state' <> 'materialized' then
    raise exception 'edited cleanup fixture did not materialize: %', v_result;
  end if;

  v_result := public.studio_materialize_carousel_draft(
    '16700000-0000-4000-8000-000000000008',
    '16700000-0000-4000-8000-000000000088',
    'Deleted replay fixture',
    'Original caption',
    '["https://deleted.example/01.png","https://deleted.example/02.png","https://deleted.example/03.png","https://deleted.example/04.png","https://deleted.example/05.png","https://deleted.example/06.png","https://deleted.example/07.png","https://deleted.example/08.png","https://deleted.example/09.png","https://deleted.example/10.png"]'::jsonb
  );
  if v_result ->> 'state' <> 'materialized' then
    raise exception 'deleted replay fixture did not materialize: %', v_result;
  end if;

  v_result := public.studio_materialize_carousel_draft(
    '16700000-0000-4000-8000-000000000009',
    '16700000-0000-4000-8000-000000000099',
    'Moved replay fixture',
    'Original caption',
    '["https://moved.example/01.png","https://moved.example/02.png","https://moved.example/03.png","https://moved.example/04.png","https://moved.example/05.png","https://moved.example/06.png","https://moved.example/07.png","https://moved.example/08.png","https://moved.example/09.png","https://moved.example/10.png"]'::jsonb
  );
  if v_result ->> 'state' <> 'materialized' then
    raise exception 'moved replay fixture did not materialize: %', v_result;
  end if;

  v_result := public.studio_materialize_carousel_draft(
    '16700000-0000-4000-8000-000000000010',
    '16700000-0000-4000-8000-000000000100',
    'Moved cleanup fixture',
    'Original caption',
    '["https://cleanup-moved.example/01.png","https://cleanup-moved.example/02.png","https://cleanup-moved.example/03.png","https://cleanup-moved.example/04.png","https://cleanup-moved.example/05.png","https://cleanup-moved.example/06.png","https://cleanup-moved.example/07.png","https://cleanup-moved.example/08.png","https://cleanup-moved.example/09.png","https://cleanup-moved.example/10.png"]'::jsonb
  );
  if v_result ->> 'state' <> 'materialized' then
    raise exception 'moved cleanup fixture did not materialize: %', v_result;
  end if;

  v_result := public.studio_materialize_carousel_draft(
    '16700000-0000-4000-8000-000000000012',
    '16700000-0000-4000-8000-000000000120',
    'Quarantined cleanup fixture',
    'Original caption',
    '["https://quarantined.example/01.png","https://quarantined.example/02.png","https://quarantined.example/03.png","https://quarantined.example/04.png","https://quarantined.example/05.png","https://quarantined.example/06.png","https://quarantined.example/07.png","https://quarantined.example/08.png","https://quarantined.example/09.png","https://quarantined.example/10.png"]'::jsonb
  );
  if v_result ->> 'state' <> 'materialized' then
    raise exception 'quarantined cleanup fixture did not materialize: %', v_result;
  end if;

  -- Exhausted cleanup retries are an operator-visible terminal lane, not
  -- permission to delete or clear evidence. Both cleanup RPCs must refuse a
  -- quarantined row while its token, receipt, draft, and media remain intact.
  update public.carousel_jobs
     set status = 'cleanup_quarantined',
         stage = 'Carousel cleanup quarantined for operator review',
         cleanup_attempts = 4,
         cleanup_last_error = 'Injected persistent object storage failure',
         cleanup_retry_at = null,
         lease_expires_at = null,
         completed_at = null
   where id = '16700000-0000-4000-8000-000000000012';
  v_result := public.studio_cleanup_carousel_draft(
    '16700000-0000-4000-8000-000000000012',
    '16700000-0000-4000-8000-000000000120',
    'Must not erase quarantined evidence'
  );
  if v_result ->> 'state' <> 'refused' then
    raise exception 'cleanup accepted a quarantined carousel: %', v_result;
  end if;
  v_result := public.studio_complete_carousel_cleanup(
    '16700000-0000-4000-8000-000000000012',
    '16700000-0000-4000-8000-000000000120',
    'Must not terminalize quarantined evidence'
  );
  if v_result ->> 'state' <> 'refused'
     or not exists (
       select 1 from public.carousel_jobs
        where id = '16700000-0000-4000-8000-000000000012'
          and status = 'cleanup_quarantined'
          and claim_token = '16700000-0000-4000-8000-000000000120'
          and cleanup_attempts = 4
          and cleanup_last_error = 'Injected persistent object storage failure'
          and materialization_receipt ->> 'contract_revision' = 'studio_carousel_materialization_v1'
          and materialization_receipt ->> 'content_checksum' ~ '^[0-9a-f]{64}$'
     )
     or not exists (
       select 1 from public.social_posts
        where id = '16700000-0000-4000-8000-000000000012'
          and status = 'draft'
          and created_by = 'studio-runner'
     )
     or (select count(*) from public.social_post_media
          where post_id = '16700000-0000-4000-8000-000000000012') <> 10 then
    raise exception 'quarantine did not preserve its cleanup evidence: %', v_result;
  end if;

  v_result := public.studio_materialize_carousel_draft(
    '16700000-0000-4000-8000-000000000005',
    '16700000-0000-4000-8000-000000000055',
    'Materialized atomically',
    'Caption',
    '["https://media.example/01.png","https://media.example/02.png","https://media.example/03.png","https://media.example/04.png","https://media.example/05.png","https://media.example/06.png","https://media.example/07.png","https://media.example/08.png","https://media.example/09.png","https://media.example/10.png"]'::jsonb
  );
  if v_result ->> 'state' <> 'materialized'
     or (v_result ->> 'media_count')::integer <> 10
     or not exists (
       select 1 from public.social_posts
        where id = '16700000-0000-4000-8000-000000000005'
          and status = 'draft' and post_type = 'carousel' and created_by = 'studio-runner'
     )
     or (select count(*) from public.social_post_media
          where post_id = '16700000-0000-4000-8000-000000000005') <> 10
     or not exists (
       select 1 from public.carousel_jobs
        where id = '16700000-0000-4000-8000-000000000005'
          and post_id = id and claim_token = '16700000-0000-4000-8000-000000000055'
          and materialization_receipt ->> 'contract_revision' = 'studio_carousel_materialization_v1'
          and materialization_receipt ->> 'content_checksum' ~ '^[0-9a-f]{64}$'
     ) then
    raise exception 'lease-fenced carousel materialization was incomplete: %', v_result;
  end if;

  update public.carousel_jobs
     set lease_expires_at = now() - interval '1 second'
   where id = '16700000-0000-4000-8000-000000000005';
  v_result := public.studio_materialize_carousel_draft(
    '16700000-0000-4000-8000-000000000005',
    '16700000-0000-4000-8000-000000000055',
    'Must not overwrite',
    'Changed',
    '["https://changed.example/01.png","https://changed.example/02.png","https://changed.example/03.png","https://changed.example/04.png","https://changed.example/05.png","https://changed.example/06.png","https://changed.example/07.png","https://changed.example/08.png","https://changed.example/09.png","https://changed.example/10.png"]'::jsonb
  );
  if v_result ->> 'state' <> 'refused'
     or exists (
       select 1 from public.social_posts
        where id = '16700000-0000-4000-8000-000000000005'
          and title = 'Must not overwrite'
     )
     or exists (
       select 1 from public.social_post_media
        where post_id = '16700000-0000-4000-8000-000000000005'
          and url like 'https://changed.example/%'
     ) then
    raise exception 'expired carousel lease modified post/media: %', v_result;
  end if;

  -- Simulate materialize response loss, a member edit, then a replacement
  -- claimant. The durable checksum must preserve the visible edit instead of
  -- replaying the runner payload over it.
  update public.social_posts
     set title = 'Member title edit'
   where id = '16700000-0000-4000-8000-000000000005';
  update public.carousel_jobs
     set status = 'rendering',
         claim_token = '16700000-0000-4000-8000-000000000056',
         lease_expires_at = now() + interval '2 minutes'
   where id = '16700000-0000-4000-8000-000000000005';
  v_result := public.studio_materialize_carousel_draft(
    '16700000-0000-4000-8000-000000000005',
    '16700000-0000-4000-8000-000000000056',
    'Materialized atomically',
    'Caption',
    '["https://media.example/01.png","https://media.example/02.png","https://media.example/03.png","https://media.example/04.png","https://media.example/05.png","https://media.example/06.png","https://media.example/07.png","https://media.example/08.png","https://media.example/09.png","https://media.example/10.png"]'::jsonb
  );
  if v_result ->> 'state' <> 'preserved_conflict'
     or not exists (
       select 1 from public.social_posts
        where id = '16700000-0000-4000-8000-000000000005'
          and title = 'Member title edit'
     )
     or (select count(*) from public.social_post_media
          where post_id = '16700000-0000-4000-8000-000000000005'
            and url like 'https://media.example/%') <> 10
     or not exists (
       select 1 from public.carousel_jobs
        where id = '16700000-0000-4000-8000-000000000005'
          and status = 'failed' and claim_token is null
          and stage like 'Member-edited%preserved%'
     ) then
    raise exception 'response-loss replay overwrote a member-edited draft: %', v_result;
  end if;

  delete from public.social_posts
   where id = '16700000-0000-4000-8000-000000000008';
  update public.carousel_jobs
     set claim_token = '16700000-0000-4000-8000-000000000089',
         lease_expires_at = now() + interval '2 minutes'
   where id = '16700000-0000-4000-8000-000000000008';
  v_result := public.studio_materialize_carousel_draft(
    '16700000-0000-4000-8000-000000000008',
    '16700000-0000-4000-8000-000000000089',
    'Deleted replay fixture',
    'Original caption',
    '["https://deleted.example/01.png","https://deleted.example/02.png","https://deleted.example/03.png","https://deleted.example/04.png","https://deleted.example/05.png","https://deleted.example/06.png","https://deleted.example/07.png","https://deleted.example/08.png","https://deleted.example/09.png","https://deleted.example/10.png"]'::jsonb
  );
  if v_result ->> 'state' <> 'cleanup_pending'
     or exists (select 1 from public.social_posts where id = '16700000-0000-4000-8000-000000000008')
     or not exists (
       select 1 from public.carousel_jobs
        where id = '16700000-0000-4000-8000-000000000008'
          and status = 'cleanup_pending'
          and claim_token = '16700000-0000-4000-8000-000000000089'
          and error like '%was removed%not recreated%'
     ) then
    raise exception 'response-loss replay resurrected a member-deleted draft: %', v_result;
  end if;
  v_result := public.studio_cleanup_carousel_draft(
    '16700000-0000-4000-8000-000000000008',
    '16700000-0000-4000-8000-000000000089',
    'Deleted draft deterministic storage sweep'
  );
  if v_result ->> 'state' <> 'cleanup_pending'
     or exists (select 1 from public.social_post_media where post_id = '16700000-0000-4000-8000-000000000008') then
    raise exception 'deleted draft cleanup did not converge to zero database artifacts: %', v_result;
  end if;
  -- The runner's executable recovery test proves its eleven deterministic
  -- object paths reach storage=0 before this completion receipt is sent.
  v_result := public.studio_complete_carousel_cleanup(
    '16700000-0000-4000-8000-000000000008',
    '16700000-0000-4000-8000-000000000089',
    'Deleted draft deterministic storage sweep'
  );
  if v_result ->> 'state' <> 'failed'
     or not exists (
       select 1 from public.carousel_jobs
        where id = '16700000-0000-4000-8000-000000000008'
          and status = 'failed' and claim_token is null and materialization_receipt is null
     ) then
    raise exception 'deleted draft cleanup did not terminalize after the storage sweep: %', v_result;
  end if;

  update public.social_posts
     set status = 'scheduled'
   where id = '16700000-0000-4000-8000-000000000009';
  update public.carousel_jobs
     set claim_token = '16700000-0000-4000-8000-000000000090',
         lease_expires_at = now() + interval '2 minutes'
   where id = '16700000-0000-4000-8000-000000000009';
  v_result := public.studio_materialize_carousel_draft(
    '16700000-0000-4000-8000-000000000009',
    '16700000-0000-4000-8000-000000000090',
    'Moved replay fixture',
    'Original caption',
    '["https://moved.example/01.png","https://moved.example/02.png","https://moved.example/03.png","https://moved.example/04.png","https://moved.example/05.png","https://moved.example/06.png","https://moved.example/07.png","https://moved.example/08.png","https://moved.example/09.png","https://moved.example/10.png"]'::jsonb
  );
  if v_result ->> 'state' <> 'preserved_conflict'
     or not exists (
       select 1 from public.social_posts
        where id = '16700000-0000-4000-8000-000000000009'
          and status = 'scheduled'
     )
     or not exists (
       select 1 from public.carousel_jobs
        where id = '16700000-0000-4000-8000-000000000009'
          and status = 'failed' and claim_token is null
     ) then
    raise exception 'response-loss replay overwrote a moved draft: %', v_result;
  end if;

  v_result := public.studio_decide_carousel_operation(
    '16700000-0000-4000-8000-000000000001',
    'approve',
    '16700000-0000-4000-8000-000000000011',
    '2026-09-01T04:00:00Z'
  );
  if v_result ->> 'state' <> 'applied'
     or v_result ->> 'decision' <> 'approve'
     or v_result ->> 'scheduled_at' is null then
    raise exception 'carousel approval did not apply atomically: %', v_result;
  end if;

  v_result := public.studio_decide_carousel_operation(
    '16700000-0000-4000-8000-000000000001',
    'approve',
    '16700000-0000-4000-8000-000000000011',
    '2026-09-01T04:00:00Z'
  );
  if v_result ->> 'state' <> 'replayed' then
    raise exception 'same carousel approval operation did not replay: %', v_result;
  end if;

  v_result := public.studio_decide_carousel_operation(
    '16700000-0000-4000-8000-000000000001',
    'reject',
    '16700000-0000-4000-8000-000000000012',
    null
  );
  if v_result ->> 'state' <> 'conflict'
     or v_result ->> 'existing_decision' <> 'approve' then
    raise exception 'independent carousel decision was not fenced: %', v_result;
  end if;

  v_result := public.studio_decide_carousel_operation(
    '16700000-0000-4000-8000-000000000002',
    'reject',
    '16700000-0000-4000-8000-000000000021',
    null
  );
  if v_result ->> 'state' <> 'applied'
     or v_result ->> 'decision' <> 'reject'
     or v_result -> 'scheduled_at' <> 'null'::jsonb then
    raise exception 'carousel rejection did not apply atomically: %', v_result;
  end if;

  if not exists (
    select 1 from public.carousel_jobs
     where id = '16700000-0000-4000-8000-000000000001'
       and status = 'approved'
       and decision = 'approve'
       and decision_operation_id = '16700000-0000-4000-8000-000000000011'
       and decision_scheduled_at = '2026-09-01T04:00:00Z'
  ) or not exists (
    select 1 from public.social_posts
     where id = '16700000-0000-4000-8000-000000000001'
       and status = 'scheduled'
       and scheduled_at = '2026-09-01T04:00:00Z'
  ) then
    raise exception 'approved carousel post/job state split';
  end if;

  if not exists (
    select 1 from public.carousel_jobs
     where id = '16700000-0000-4000-8000-000000000002'
       and status = 'rejected'
       and decision = 'reject'
       and decision_operation_id = '16700000-0000-4000-8000-000000000021'
       and decision_scheduled_at is null
  ) or not exists (
    select 1 from public.social_posts
     where id = '16700000-0000-4000-8000-000000000002'
       and status = 'draft'
       and scheduled_at is null
  ) then
    raise exception 'rejected carousel did not remain a draft';
  end if;

  v_result := public.studio_decide_carousel_operation(
    '16700000-0000-4000-8000-000000000006',
    'reject',
    '16700000-0000-4000-8000-000000000061',
    null
  );
  if v_result ->> 'state' <> 'conflict'
     or not exists (
       select 1 from public.carousel_jobs
        where id = '16700000-0000-4000-8000-000000000006'
          and status = 'ready' and decision is null and decision_operation_id is null
     )
     or not exists (
       select 1 from public.social_posts
        where id = '16700000-0000-4000-8000-000000000006'
          and status = 'scheduled'
     ) then
    raise exception 'reject split a moved post from its ready carousel job: %', v_result;
  end if;

  update public.social_posts
     set caption = 'Member cleanup edit'
   where id = '16700000-0000-4000-8000-000000000007';
  v_result := public.studio_cleanup_carousel_draft(
    '16700000-0000-4000-8000-000000000007',
    '16700000-0000-4000-8000-000000000077',
    'Renderer failed after member edit'
  );
  if v_result ->> 'state' <> 'preserved_conflict'
     or not exists (
       select 1 from public.social_posts
        where id = '16700000-0000-4000-8000-000000000007'
          and caption = 'Member cleanup edit'
     )
     or (select count(*) from public.social_post_media
          where post_id = '16700000-0000-4000-8000-000000000007') <> 10
     or not exists (
       select 1 from public.carousel_jobs
        where id = '16700000-0000-4000-8000-000000000007'
          and status = 'failed' and claim_token is null
     ) then
    raise exception 'cleanup deleted a member-edited draft/media set: %', v_result;
  end if;

  update public.social_posts
     set status = 'scheduled'
   where id = '16700000-0000-4000-8000-000000000010';
  v_result := public.studio_cleanup_carousel_draft(
    '16700000-0000-4000-8000-000000000010',
    '16700000-0000-4000-8000-000000000100',
    'Renderer failed after post moved'
  );
  if v_result ->> 'state' <> 'preserved_conflict'
     or not exists (
       select 1 from public.social_posts
        where id = '16700000-0000-4000-8000-000000000010'
          and status = 'scheduled'
     )
     or (select count(*) from public.social_post_media
          where post_id = '16700000-0000-4000-8000-000000000010') <> 10
     or not exists (
       select 1 from public.carousel_jobs
        where id = '16700000-0000-4000-8000-000000000010'
          and status = 'failed' and claim_token is null
     ) then
    raise exception 'cleanup looped or deleted after the attached post moved: %', v_result;
  end if;

  v_result := public.studio_cleanup_carousel_draft(
    '16700000-0000-4000-8000-000000000003',
    '16700000-0000-4000-8000-000000000033',
    'Injected renderer failure'
  );
  if v_result ->> 'state' <> 'cleanup_pending'
     or exists (select 1 from public.social_posts where id = '16700000-0000-4000-8000-000000000003')
     or exists (select 1 from public.social_post_media where post_id = '16700000-0000-4000-8000-000000000003')
     or not exists (
       select 1 from public.carousel_jobs
        where id = '16700000-0000-4000-8000-000000000003'
          and status = 'cleanup_pending'
          and claim_token = '16700000-0000-4000-8000-000000000033'
     ) then
    raise exception 'owned draft cleanup did not atomically remove post and media: %', v_result;
  end if;

  v_result := public.studio_materialize_carousel_draft(
    '16700000-0000-4000-8000-000000000003',
    '16700000-0000-4000-8000-000000000034',
    'Replacement must wait',
    'Replacement',
    '["https://replacement.example/01.png","https://replacement.example/02.png","https://replacement.example/03.png","https://replacement.example/04.png","https://replacement.example/05.png","https://replacement.example/06.png","https://replacement.example/07.png","https://replacement.example/08.png","https://replacement.example/09.png","https://replacement.example/10.png"]'::jsonb
  );
  if v_result ->> 'state' <> 'refused'
     or exists (select 1 from public.social_posts where id = '16700000-0000-4000-8000-000000000003')
     or exists (select 1 from public.social_post_media where post_id = '16700000-0000-4000-8000-000000000003') then
    raise exception 'replacement renderer interleaved with cleanup_pending: %', v_result;
  end if;

  v_result := public.studio_complete_carousel_cleanup(
    '16700000-0000-4000-8000-000000000003',
    '16700000-0000-4000-8000-000000000033',
    'Injected renderer failure'
  );
  if v_result ->> 'state' <> 'failed'
     or not exists (
       select 1 from public.carousel_jobs
        where id = '16700000-0000-4000-8000-000000000003'
          and status = 'failed' and claim_token is null
          and error = 'Injected renderer failure'
     ) then
    raise exception 'cleanup completion did not terminalize atomically: %', v_result;
  end if;

  v_result := public.studio_cleanup_carousel_draft(
    '16700000-0000-4000-8000-000000000004',
    '16700000-0000-4000-8000-000000000044',
    'Must be refused'
  );
  if v_result ->> 'state' <> 'refused'
     or not exists (select 1 from public.social_posts where id = '16700000-0000-4000-8000-000000000004' and status = 'draft')
     or not exists (select 1 from public.social_post_media where post_id = '16700000-0000-4000-8000-000000000004') then
    raise exception 'ready draft/media were touched by cleanup: %', v_result;
  end if;
end
$$;

rollback;
