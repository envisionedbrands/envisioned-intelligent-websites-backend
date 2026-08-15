-- Migration 201: Founder Access Diagnostic
-- Keeps the latest assessment summary on the lead and every completed result
-- here as immutable funnel intelligence. Safe to re-run.

create table if not exists assessment_completions (
  id uuid primary key default uuid_generate_v4(),
  lead_id uuid not null references leads(id) on delete cascade,
  assessment_key text not null,
  version text not null,
  session_id text not null,
  raw_score integer not null,
  normalized_score integer not null check (normalized_score between 0 and 100),
  maturity_stage text not null,
  dimension_scores jsonb not null default '{}',
  answers jsonb not null default '{}',
  commercial_fit text,
  qualification jsonb not null default '{}',
  marketing_consent boolean not null default false,
  page_url text,
  referrer text,
  completed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (assessment_key, session_id)
);

create index if not exists idx_assessment_completions_lead_time
  on assessment_completions(lead_id, completed_at desc);
create index if not exists idx_assessment_completions_stage
  on assessment_completions(assessment_key, maturity_stage, completed_at desc);
create index if not exists idx_assessment_completions_fit
  on assessment_completions(assessment_key, commercial_fit, completed_at desc);

alter table assessment_completions enable row level security;

insert into crm_custom_fields (key, label, field_type, options, sort_order) values
  ('founder_access_score', 'Founder Access: Score', 'number', '[]'::jsonb, 60),
  ('founder_access_stage', 'Founder Access: Stage', 'select', '["Founder-held","Documented","Structured","Transferable","Codified"]'::jsonb, 61),
  ('founder_access_priority', 'Founder Access: Priority', 'text', '[]'::jsonb, 62),
  ('founder_access_fit', 'Founder Access: Commercial fit', 'select', '["high","developing","nurture"]'::jsonb, 63),
  ('founder_access_delivery_preference', 'Founder Access: Delivery preference', 'select', '["virtual","in_person","team","undecided"]'::jsonb, 64),
  ('founder_access_completed_at', 'Founder Access: Completed', 'date', '[]'::jsonb, 65)
on conflict (key) do update set
  label = excluded.label,
  field_type = excluded.field_type,
  options = excluded.options,
  sort_order = excluded.sort_order;

insert into crm_tags (name, color) values
  ('founder-access-completed', '#4C5A2E'),
  ('fit-high', '#4C5A2E'),
  ('fit-developing', '#8A9A6B'),
  ('fit-nurture', '#8A7A68')
on conflict (name) do nothing;
