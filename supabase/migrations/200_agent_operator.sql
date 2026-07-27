-- Migration 200: The Operator — agentic layer on your backend
--
-- agent_runs: one row per Operator invocation (a chat turn or a scheduled
-- review), with a live-updated jsonb log of tool calls so the dashboard shows
-- work as it happens. agent_actions: the trust layer — everything
-- outward-facing (emails, publishes, workflow activations) lands here as
-- 'proposed' and only executes when you approve it.
--
-- Requires the Digital Home Upgrade (migrations 100-103). Re-runnable.

create table if not exists agent_runs (
  id uuid primary key default uuid_generate_v4(),
  trigger text not null default 'chat' check (trigger in ('chat', 'tick', 'mcp')),
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  summary text,                              -- one-line "what this run did"
  report_md text,                            -- final assistant text (the report for scheduled runs)
  tool_calls jsonb not null default '[]',    -- [{tool, input, summary, ok, ms, at}]
  tokens_used integer,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_agent_runs_created on agent_runs(created_at desc);

create table if not exists agent_actions (
  id uuid primary key default uuid_generate_v4(),
  run_id uuid references agent_runs(id) on delete set null,
  type text not null,                        -- constrained below (re-runnable)
  title text not null,
  summary text,
  payload jsonb not null default '{}',       -- email: {lead_id, email, subject, body_md, preheader, reason}
                                             -- publish: {calendar_entry_id, article_title, reason}
                                             -- workflow: {workflow_id, name, reason}
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected', 'executed', 'failed')),
  result jsonb,                              -- execution outcome (send id, simulated flag, error…)
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  executed_at timestamptz
);

create index if not exists idx_agent_actions_status on agent_actions(status, created_at desc);

-- Constraints applied separately so this migration re-runs cleanly over an
-- older install: `create table if not exists` skips the whole statement, so an
-- inline check would never be updated on an upgrade.
alter table agent_actions drop constraint if exists agent_actions_type_check;
alter table agent_actions
  add constraint agent_actions_type_check
  check (type in ('email', 'publish', 'workflow', 'other'));

-- 'mcp' is the optional external-agent bridge (/api/agent/mcp).
alter table agent_runs drop constraint if exists agent_runs_trigger_check;
alter table agent_runs
  add constraint agent_runs_trigger_check
  check (trigger in ('chat', 'tick', 'mcp'));

-- Service-role only (all access goes through your API routes); no anon policies.
alter table agent_runs enable row level security;
alter table agent_actions enable row level security;

-- The Operator's persistent memory (save_insight / list_insights) lives in
-- backend_settings under the key 'operator_insights' as a capped JSON array —
-- no table needed, it works as soon as the CRM upgrade's settings table exists.
