-- 311: Substack Notes as a social platform.
--
-- Substack has no official API. Notes post through the same endpoint the
-- Substack web app uses, authenticated by the owner's `substack.sid` session
-- cookie. That cookie is a full login to her Substack account, so it is NOT
-- stored in social_accounts.access_token (plain text, like every other token
-- here). It lives in the Worker secret SUBSTACK_SID. The social_accounts row
-- only records which Substack profile + publication the secret belongs to.
--
-- Notes are text-only, so social_posts learns a third post_type, 'text'.
-- Text posts never go through POST /api/social/posts (that route stays
-- video/carousel). They are created by exactly two gated paths:
--   1. the owner, logged in, scheduling a Repurpose draft (session only), or
--   2. the owner approving a `social_post` proposal in the approvals queue.
-- Verified 2026-10-04 that a Cloudflare Worker can reach Substack's API, on
-- condition that it sends a browser User-Agent (none → HTTP 429).

begin;

-- ── guard: never narrow a live list ─────────────────────────────────────────
-- Each constraint below is dropped and re-created. If the live DB allows a
-- value this file doesn't know about (a hand edit or a later migration), stop
-- here and change nothing, rather than silently removing it.
do $$
declare
  c record;
  v text;
begin
  for c in
    select * from (values
      ('social_accounts',     'social_accounts_platform_check',     array['instagram','facebook','youtube','substack']),
      ('social_post_targets', 'social_post_targets_platform_check', array['instagram','facebook','youtube','substack']),
      ('social_posts',        'social_posts_post_type_check',       array['video','carousel','text']),
      ('agent_actions',       'agent_actions_type_check',           array['email','publish','workflow','dm_funnel','social_post','other'])
    ) as t(tbl, con, allowed)
  loop
    for v in
      select m[1]
      from pg_constraint k
      join pg_class r on r.oid = k.conrelid
      cross join lateral regexp_matches(pg_get_constraintdef(k.oid), '''([^'']+)''', 'g') as m
      where r.relname = c.tbl and k.conname = c.con
    loop
      if not (v = any (c.allowed)) then
        raise exception '311 stopped: %.% allows % which this migration would remove', c.tbl, c.con, v;
      end if;
    end loop;
  end loop;
end $$;

-- ── platform: + substack ─────────────────────────────────────────────────────
alter table social_accounts drop constraint if exists social_accounts_platform_check;
alter table social_accounts
  add constraint social_accounts_platform_check
  check (platform in ('instagram', 'facebook', 'youtube', 'substack'));

alter table social_post_targets drop constraint if exists social_post_targets_platform_check;
alter table social_post_targets
  add constraint social_post_targets_platform_check
  check (platform in ('instagram', 'facebook', 'youtube', 'substack'));

-- ── post_type: + text ────────────────────────────────────────────────────────
alter table social_posts drop constraint if exists social_posts_post_type_check;
alter table social_posts
  add constraint social_posts_post_type_check
  check (post_type in ('video', 'carousel', 'text'));

-- Which Repurpose draft a Note came from, so publishing can mark it published.
alter table social_posts
  add column if not exists source_derivative_id uuid references content_derivatives(id) on delete set null;
create index if not exists idx_social_posts_source_derivative
  on social_posts (source_derivative_id) where source_derivative_id is not null;

-- ── approvals queue: + social_post ───────────────────────────────────────────
-- Scheduling a Note publishes words under her name, so an agent can only
-- propose it. Same widening pattern as 300.
alter table agent_actions drop constraint if exists agent_actions_type_check;
alter table agent_actions
  add constraint agent_actions_type_check
  check (type in ('email', 'publish', 'workflow', 'dm_funnel', 'social_post', 'other'));

-- ── record the native-import dedup index (schema drift) ─────────────────────
-- Created by hand on the live DB on 2026-09-16 (commit 3bf3ced) and never
-- written down. Same name, so this is a no-op where it exists and creates it on
-- fresh installs. It is PARTIAL, which is why native-import must use a plain
-- insert (and treat 23505 as a lost race): ON CONFLICT (external_id) cannot
-- match a partial index and failed with 42P10 on every import (proven 2026-10-04).
create unique index if not exists social_post_targets_external_id_uniq
  on social_post_targets (external_id) where external_id is not null;

commit;
