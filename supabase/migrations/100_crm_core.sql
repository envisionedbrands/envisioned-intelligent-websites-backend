-- Migration 100: CRM Core (Digital Home Upgrade)
-- Turns the lead tables into a full CRM: pipelines, timeline activities,
-- custom fields, tag registry, nurture workflows with enrollments,
-- email templates, tasks and appointments.
-- Written to be re-runnable (if not exists / drop-first where needed).
--
-- INSTALL TOKENS — replace before applying (the /upgrade skill does this):
--   Maria-Inés from Envisioned  hello@mariaines.co  hello@mariaines.co  EUR  Europe/Madrid

-- ── Enums ────────────────────────────────────────────────────────────────────

do $$ begin
  create type email_subscription_status as enum ('subscribed', 'unsubscribed', 'bounced', 'complained');
exception when duplicate_object then null; end $$;

do $$ begin
  create type opportunity_status as enum ('open', 'won', 'lost');
exception when duplicate_object then null; end $$;

do $$ begin
  create type workflow_status as enum ('draft', 'active', 'paused', 'archived');
exception when duplicate_object then null; end $$;

do $$ begin
  create type enrollment_status as enum ('active', 'completed', 'exited', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type crm_task_status as enum ('open', 'done');
exception when duplicate_object then null; end $$;

do $$ begin
  create type appointment_status as enum ('scheduled', 'completed', 'cancelled', 'no_show');
exception when duplicate_object then null; end $$;

-- email_sends gains outcomes for safe mode + suppression
alter type send_status add value if not exists 'simulated';
alter type send_status add value if not exists 'suppressed';

-- ── Extend leads into a full contact record ──────────────────────────────────

alter table leads add column if not exists phone text;
alter table leads add column if not exists company text;
alter table leads add column if not exists custom jsonb not null default '{}';
alter table leads add column if not exists email_status email_subscription_status not null default 'subscribed';
alter table leads add column if not exists unsubscribe_token uuid not null default uuid_generate_v4();
alter table leads add column if not exists timezone text;
alter table leads add column if not exists last_activity_at timestamptz not null default now();

create unique index if not exists idx_leads_unsub_token on leads(unsubscribe_token);
create index if not exists idx_leads_last_activity on leads(last_activity_at desc);
create index if not exists idx_leads_tags on leads using gin(tags);
create index if not exists idx_leads_email_status on leads(email_status);

-- ── Custom field definitions (schema for leads.custom) ──────────────────────

create table if not exists crm_custom_fields (
  id uuid primary key default uuid_generate_v4(),
  key text unique not null,                -- snake_case key inside leads.custom
  label text not null,
  field_type text not null default 'text', -- text|number|date|select|multiselect|boolean|url
  options jsonb not null default '[]',     -- for select/multiselect
  sort_order integer not null default 0,
  created_at timestamptz default now()
);

-- ── Tag registry (leads.tags stays text[]; this adds metadata + autocomplete)

create table if not exists crm_tags (
  id uuid primary key default uuid_generate_v4(),
  name text unique not null,
  color text,
  created_at timestamptz default now()
);

-- ── Pipelines / stages / opportunities ───────────────────────────────────────

create table if not exists pipelines (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  is_default boolean not null default false,
  position integer not null default 0,
  created_at timestamptz default now()
);

create table if not exists pipeline_stages (
  id uuid primary key default uuid_generate_v4(),
  pipeline_id uuid not null references pipelines(id) on delete cascade,
  name text not null,
  position integer not null default 0,
  created_at timestamptz default now()
);

create index if not exists idx_stages_pipeline on pipeline_stages(pipeline_id, position);

create table if not exists opportunities (
  id uuid primary key default uuid_generate_v4(),
  lead_id uuid not null references leads(id) on delete cascade,
  pipeline_id uuid not null references pipelines(id) on delete cascade,
  stage_id uuid not null references pipeline_stages(id) on delete cascade,
  name text not null,
  value_cents bigint not null default 0,
  currency text not null default 'EUR',
  status opportunity_status not null default 'open',
  position integer not null default 0,
  won_at timestamptz,
  lost_at timestamptz,
  lost_reason text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_opps_stage on opportunities(stage_id, position);
create index if not exists idx_opps_lead on opportunities(lead_id);
create index if not exists idx_opps_status on opportunities(status);

drop trigger if exists opportunities_updated_at on opportunities;
create trigger opportunities_updated_at
  before update on opportunities
  for each row execute function update_updated_at();

-- ── Lead timeline ─────────────────────────────────────────────────────────────

create table if not exists lead_activities (
  id uuid primary key default uuid_generate_v4(),
  lead_id uuid not null references leads(id) on delete cascade,
  activity_type text not null,  -- created|note|email_sent|email_opened|email_clicked|form_submitted|
                                -- tag_added|tag_removed|status_changed|stage_changed|enrolled|workflow_completed|
                                -- task_created|appointment_booked|field_updated|unsubscribed|webhook|ai
  title text not null,
  body text,
  data jsonb not null default '{}',
  actor text not null default 'system',   -- human | system | agent:<name>
  created_at timestamptz default now()
);

create index if not exists idx_activities_lead on lead_activities(lead_id, created_at desc);
create index if not exists idx_activities_created on lead_activities(created_at desc);
create index if not exists idx_activities_type on lead_activities(activity_type);

-- ── Email templates (markdown source, rendered at send time) ─────────────────

create table if not exists email_templates (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  subject text not null,
  preheader text,
  body_md text not null,
  category text,
  ai_generated boolean not null default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

drop trigger if exists email_templates_updated_at on email_templates;
create trigger email_templates_updated_at
  before update on email_templates
  for each row execute function update_updated_at();

-- ── Workflows (nurture automations) ──────────────────────────────────────────

create table if not exists workflows (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  description text,
  status workflow_status not null default 'draft',
  trigger_type text not null default 'manual',  -- manual|lead_created|form_submitted|tag_added|status_changed|stage_changed
  trigger_config jsonb not null default '{}',   -- e.g. {"tag":"downloaded-guide"} {"form":"newsletter"} {"stage_id":"..."}
  steps jsonb not null default '[]',            -- ordered [{id,type,config}] — types: send_email|wait|add_tag|remove_tag|
                                                -- set_status|move_stage|update_field|webhook|create_task
  allow_reenrollment boolean not null default false,
  ai_brief jsonb,                               -- the brief that generated this workflow (if AI-drafted)
  enrolled_count integer not null default 0,
  completed_count integer not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_workflows_status on workflows(status);
create index if not exists idx_workflows_trigger on workflows(trigger_type) where status = 'active';

drop trigger if exists workflows_updated_at on workflows;
create trigger workflows_updated_at
  before update on workflows
  for each row execute function update_updated_at();

create table if not exists workflow_enrollments (
  id uuid primary key default uuid_generate_v4(),
  workflow_id uuid not null references workflows(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  status enrollment_status not null default 'active',
  current_step integer not null default 0,      -- index of the NEXT step to execute
  next_run_at timestamptz not null default now(),
  context jsonb not null default '{}',
  last_error text,
  enrolled_at timestamptz default now(),
  completed_at timestamptz
);

create index if not exists idx_enroll_due on workflow_enrollments(next_run_at) where status = 'active';
create index if not exists idx_enroll_lead on workflow_enrollments(lead_id);
create index if not exists idx_enroll_workflow on workflow_enrollments(workflow_id, status);
create unique index if not exists idx_enroll_active_unique on workflow_enrollments(workflow_id, lead_id) where status = 'active';

-- ── Tasks (for humans and agents) ────────────────────────────────────────────

create table if not exists crm_tasks (
  id uuid primary key default uuid_generate_v4(),
  lead_id uuid references leads(id) on delete cascade,
  title text not null,
  description text,
  status crm_task_status not null default 'open',
  due_at timestamptz,
  created_by text not null default 'human',
  completed_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists idx_tasks_open on crm_tasks(status, due_at);
create index if not exists idx_tasks_lead on crm_tasks(lead_id);

-- ── Appointments (bookings recorded from any source) ─────────────────────────

create table if not exists appointments (
  id uuid primary key default uuid_generate_v4(),
  lead_id uuid references leads(id) on delete cascade,
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  status appointment_status not null default 'scheduled',
  location text,
  notes text,
  source text,
  created_at timestamptz default now()
);

create index if not exists idx_appts_time on appointments(starts_at);
create index if not exists idx_appts_lead on appointments(lead_id);

-- ── Extend email_sends for the workflow engine ───────────────────────────────

alter table email_sends add column if not exists workflow_id uuid references workflows(id);
alter table email_sends add column if not exists enrollment_id uuid references workflow_enrollments(id);
alter table email_sends add column if not exists email_template_id uuid references email_templates(id);
alter table email_sends add column if not exists body_html text;
alter table email_sends add column if not exists opened_at timestamptz;
alter table email_sends add column if not exists clicked_at timestamptz;

create index if not exists idx_sends_workflow on email_sends(workflow_id);
create index if not exists idx_sends_created on email_sends(created_at desc);

-- ── Row level security (service-role access only, like the rest) ─────────────

alter table crm_custom_fields enable row level security;
alter table crm_tags enable row level security;
alter table pipelines enable row level security;
alter table pipeline_stages enable row level security;
alter table opportunities enable row level security;
alter table lead_activities enable row level security;
alter table email_templates enable row level security;
alter table workflows enable row level security;
alter table workflow_enrollments enable row level security;
alter table crm_tasks enable row level security;
alter table appointments enable row level security;

-- ── Seeds ────────────────────────────────────────────────────────────────────

insert into pipelines (name, is_default, position)
select 'Sales Pipeline', true, 0
where not exists (select 1 from pipelines);

insert into pipeline_stages (pipeline_id, name, position)
select p.id, s.name, s.pos
from pipelines p,
     (values ('New', 0), ('Nurturing', 1), ('Call Booked', 2), ('Proposal', 3), ('Negotiation', 4)) as s(name, pos)
where p.is_default
  and not exists (select 1 from pipeline_stages where pipeline_id = p.id);

insert into backend_settings (key, value) values
  ('crm_safe_mode', 'true'::jsonb),
  ('crm_sender', '{"from_name": "Maria-Inés from Envisioned", "from_email": "hello@mariaines.co", "reply_to": "hello@mariaines.co"}'::jsonb),
  ('crm_send_window', '{"enabled": false, "start_hour": 8, "end_hour": 18, "timezone": "Europe/Madrid", "days": [1,2,3,4,5]}'::jsonb)
on conflict (key) do nothing;
