-- ===========================================================================
-- Run this whole file in the Supabase SQL editor. Safe to run more than once.
--
-- Bundles two pending migrations:
--   201_founder_access_assessment.sql — the Founder Intelligence Assessment
--                                       table, CRM fields and tags
--   303_dm_delivery_card.sql          — the tappable link card for DM delivery
--
-- Verified 2026-08-15 before writing: leads, crm_custom_fields, crm_tags and
-- dm_funnels all exist; assessment_completions does not.
-- ===========================================================================


-- ── 201: Founder Access Diagnostic ─────────────────────────────────────────
-- Keeps the latest assessment summary on the lead and every completed result
-- here as immutable funnel intelligence.

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


-- ── 303: DM delivery card ──────────────────────────────────────────────────
-- Instagram renders a text message containing a URL as a link-preview panel
-- with the raw https:// still sitting in the sentence underneath. One message,
-- but it reads as the same link sent twice. A generic template is the same
-- panel with the URL moved into a tappable button — the picture stays, the
-- duplicate goes.
--
-- All four columns are nullable and every existing funnel keeps sending plain
-- text until a title is set. `delivery_card_title` is the switch.

alter table dm_funnels
  add column if not exists delivery_card_title    text,
  add column if not exists delivery_card_subtitle text,
  add column if not exists delivery_card_image    text,
  add column if not exists delivery_button_label  text;

-- Meta rejects the whole send with a 400 if either string overruns, so the
-- limit is enforced at the column rather than trusted to the form. Postgres has
-- no `add constraint if not exists`, so these drop first to stay re-runnable.
alter table dm_funnels drop constraint if exists dm_funnels_card_title_len;
alter table dm_funnels drop constraint if exists dm_funnels_card_subtitle_len;

alter table dm_funnels
  add constraint dm_funnels_card_title_len
    check (delivery_card_title is null or char_length(delivery_card_title) <= 80) not valid,
  add constraint dm_funnels_card_subtitle_len
    check (delivery_card_subtitle is null or char_length(delivery_card_subtitle) <= 80) not valid;

comment on column dm_funnels.delivery_card_title is
  'Headline on the delivery card. Null = send the delivery as plain text (old behaviour). Max 80 chars — Meta''s limit.';
comment on column dm_funnels.delivery_card_image is
  'Hero image URL shown on the card. Must be publicly reachable — Meta fetches it.';
comment on column dm_funnels.delivery_button_label is
  'Wording on the button. Defaults to "Read it" when blank.';

-- Switch the live funnel over. Title and image are the article's own, read from
-- content_objects, so the card carries the same picture that appeared in the
-- preview panel before. The closing line moves into the subtitle, which is why
-- it is shorter: 80 characters is Meta's ceiling, not an edit for its own sake.
-- The keyword was saved before normalisation shipped, so it holds the same word
-- three times — harmless, but it reads as a bug on the screen.
update dm_funnels
set delivery_card_title    = 'You Are Not Behind on AI. You Are Behind on Yourself.',
    delivery_card_subtitle = 'In your inbox too. If it names what you''ve been avoiding, that''s the point.',
    delivery_card_image    = 'https://aqylffhuzunpimrebgye.supabase.co/storage/v1/object/public/images/articles/you-are-not-behind-on-ai-you-are-cover.png',
    delivery_button_label  = 'Read the essay',
    keyword                = 'behind'
where name = 'Behind on AI — essay delivery';


-- ── Confirmation ───────────────────────────────────────────────────────────
-- Should return one row: card_title filled in, and assessment_table = true.
select
  f.delivery_card_title,
  f.delivery_button_label,
  f.keyword,
  (to_regclass('public.assessment_completions') is not null) as assessment_table_created
from dm_funnels f
where f.name = 'Behind on AI — essay delivery';
