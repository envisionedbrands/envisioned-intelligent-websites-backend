-- Migration 101: Funnel analytics (Digital Home Upgrade)
-- Anonymous per-session funnel events for any funnel, keyed by its `funnel`
-- string. Rows are written by the backend's POST /api/crm/funnel/ingest and
-- read by the /crm/funnel dashboard.
-- Events are deduped client-side (each fires at most once per session), so a
-- row count per step equals distinct sessions that reached that step.
-- Written to be re-runnable (if not exists / on conflict do nothing).

create table if not exists funnel_events (
  id uuid primary key default uuid_generate_v4(),
  funnel text not null default 'unknown',   -- funnel key, e.g. 'default'
  session_id text not null,                 -- anonymous per-tab session id
  event_type text not null,                 -- start | view | complete | cta_click
  screen_index integer,                     -- view events: 0-based step position
  screen_id text,                           -- view events: stable screen slug
  event_data jsonb not null default '{}',   -- anything else (cta location, step…)
  page_url text,
  referrer text,
  created_at timestamptz not null default now()
);

create index if not exists idx_funnel_events_funnel_time on funnel_events(funnel, created_at desc);
create index if not exists idx_funnel_events_step on funnel_events(funnel, event_type, screen_index);
create index if not exists idx_funnel_events_session on funnel_events(session_id);

alter table funnel_events enable row level security;

-- Optional: label the fields your funnel writes into leads.custom, so the CRM
-- lead page shows named fields instead of raw JSON keys. Example (edit to
-- match your own funnel's custom keys, or delete this block):
--
-- insert into crm_custom_fields (key, label, field_type, sort_order) values
--   ('funnel_goal',       'Funnel: Goal',           'text', 10),
--   ('funnel_session_id', 'Funnel: Session',        'text', 11)
-- on conflict (key) do nothing;
