-- Migration 300: DM Funnels (Instagram / Facebook)
--
-- The owned ManyChat replacement. A funnel is: someone comments a keyword (or
-- DMs it) → we open a private conversation → optionally require a follow →
-- collect their email → deliver the thing in the DM *and* to their inbox, with
-- the lead landing in the CRM tagged and enrolled like any other capture.
--
-- What is deliberately NOT here: a "new follower" trigger. Instagram's `follows`
-- webhook is not publicly subscribable — it is a private Meta partner beta. No
-- amount of App Review gets it. See docs/dm-funnels.md.
--
-- Platform constraints encoded below:
--   * Private reply to a comment: ONE per comment, within 7 days.
--   * Free-form DM: only within 24h of the user's last message.
-- Both windows are tracked per run so an expired conversation fails quietly
-- instead of burning quota on a call Meta will reject.

-- ── Channel enum gains the DM platforms ─────────────────────────────────────
-- 008_conversations.sql created this as ('web_chat','whatsapp'). Additive only.
do $$
begin
  if not exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'conversation_channel' and e.enumlabel = 'instagram'
  ) then
    alter type conversation_channel add value 'instagram';
  end if;
  if not exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'conversation_channel' and e.enumlabel = 'facebook'
  ) then
    alter type conversation_channel add value 'facebook';
  end if;
end $$;

-- ── The funnel definition ───────────────────────────────────────────────────
create table if not exists dm_funnels (
  id uuid primary key default gen_random_uuid(),

  name text not null,
  -- Stored lowercase. The unique index below is what stops two funnels
  -- fighting over the same word — the failure mode that makes DM automations
  -- feel haunted.
  keyword text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'paused')),

  -- Which account answers. Null = the single active instagram account.
  account_id uuid references social_accounts(id) on delete set null,

  -- 'comment' = only public comments trigger it, 'dm' = only direct messages,
  -- 'both' = either.
  trigger_source text not null default 'both'
    check (trigger_source in ('comment', 'dm', 'both')),
  -- Optional: restrict to one post/reel. Null = any media on the account.
  media_id text,

  -- Copy. Every field is plain text; {{first_name}} and {{keyword}} interpolate.
  public_comment_reply text,        -- posted under their comment; null = skip
  opening_dm text not null,         -- the private reply that opens the thread
  follow_prompt_dm text,            -- sent when require_follow and they don't
  email_prompt_dm text,             -- asks for the email address
  delivery_dm text not null,        -- sent with the link once qualified
  already_done_dm text,             -- they trigger it twice; null = stay silent

  -- Behaviour
  require_follow boolean not null default false,
  ask_email boolean not null default true,
  -- Recognition. When we already hold this person's email, asking again is the
  -- thing that makes an automation feel like a form. Off only when a funnel
  -- genuinely needs the address re-confirmed.
  skip_email_if_known boolean not null default true,
  delivery_link text,

  -- What happens in the CRM once we have their email
  tags text[] not null default '{}',
  email_template_id uuid references email_templates(id) on delete set null,
  enroll_workflow_id uuid references workflows(id) on delete set null,

  -- Counters, maintained by the runner (cheap dashboard, no aggregate scan)
  stat_triggered integer not null default 0,
  stat_delivered integer not null default 0,
  stat_emails_captured integer not null default 0,
  -- Counted separately from captures, so "emails captured" stays an honest
  -- number for a returning audience rather than counting the same person twice.
  stat_recognised integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One live funnel per word. Drafts and paused funnels may share a keyword so a
-- replacement can be written before the old one is retired.
create unique index if not exists idx_dm_funnels_keyword_active
  on dm_funnels (lower(keyword))
  where status = 'active';
create index if not exists idx_dm_funnels_status on dm_funnels (status);

-- ── The people on the other end ─────────────────────────────────────────────
-- An IG-scoped ID is per-app, so this is our own address book, not a shadow
-- copy of Instagram's. Linked to a lead only once they hand over an email.
create table if not exists dm_subscribers (
  id uuid primary key default gen_random_uuid(),

  platform text not null default 'instagram' check (platform in ('instagram', 'facebook')),
  igsid text not null,                -- Instagram-scoped / Page-scoped user id
  username text,
  name text,
  profile_pic text,
  follower_count integer,

  -- Cached from the User Profile API on each inbound message. Cheap, and the
  -- follow gate needs it fresh.
  is_follower boolean,
  follow_checked_at timestamptz,

  lead_id uuid references leads(id) on delete set null,

  -- The 24-hour clock. Every inbound message resets it; the sender refuses to
  -- send free-form once it has passed.
  last_inbound_at timestamptz,
  first_seen_at timestamptz not null default now(),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_dm_subscribers_igsid
  on dm_subscribers (platform, igsid);
create index if not exists idx_dm_subscribers_lead on dm_subscribers (lead_id);

-- ── One person moving through one funnel ────────────────────────────────────
create table if not exists dm_funnel_runs (
  id uuid primary key default gen_random_uuid(),

  funnel_id uuid not null references dm_funnels(id) on delete cascade,
  subscriber_id uuid not null references dm_subscribers(id) on delete cascade,

  state text not null default 'opened' check (state in (
    'opened',           -- opening DM sent, waiting for them to engage
    'awaiting_follow',  -- asked them to follow, re-checking on next message
    'awaiting_email',   -- asked for the address
    'delivered',        -- link sent (and emailed, if configured)
    'expired',          -- 24h window closed before they finished
    'failed'
  )),

  -- Provenance
  trigger_source text not null check (trigger_source in ('comment', 'dm')),
  comment_id text,                -- the comment we private-replied to
  media_id text,

  -- Windows, so we never call an endpoint Meta will refuse
  dm_window_expires_at timestamptz,     -- last_inbound + 24h
  private_reply_used boolean not null default false,

  email_captured text,
  delivered_at timestamptz,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One run per person per funnel. A second comment on the same funnel updates
-- the existing run rather than restarting the sequence — this is what stops
-- someone who comments three times getting three opening DMs.
create unique index if not exists idx_dm_funnel_runs_unique
  on dm_funnel_runs (funnel_id, subscriber_id);
create index if not exists idx_dm_funnel_runs_state on dm_funnel_runs (state);
create index if not exists idx_dm_funnel_runs_subscriber on dm_funnel_runs (subscriber_id);

-- ── Webhook dedupe ──────────────────────────────────────────────────────────
-- Meta redelivers on any non-200, and redelivers optimistically besides. Every
-- message id / comment id passes through here exactly once. Without this, a
-- slow response means the subscriber gets the opening DM twice.
create table if not exists meta_webhook_events (
  event_key text primary key,       -- message mid, or 'comment:<id>'
  object_type text,
  received_at timestamptz not null default now(),
  payload jsonb
);

create index if not exists idx_meta_webhook_events_received
  on meta_webhook_events (received_at);

-- ── Message log ─────────────────────────────────────────────────────────────
-- Uses the existing conversations/messages tables from frontend migration 008
-- rather than a parallel store, so DM history shows up wherever chat history
-- already does. This table only records the DM-specific routing bits.
create table if not exists dm_messages (
  id uuid primary key default gen_random_uuid(),

  subscriber_id uuid not null references dm_subscribers(id) on delete cascade,
  run_id uuid references dm_funnel_runs(id) on delete set null,

  direction text not null check (direction in ('inbound', 'outbound')),
  body text,
  external_id text,                 -- Meta's mid
  -- 'send_api' | 'private_reply' | 'comment_reply'
  method text,
  -- Set when safe mode suppressed a real send. The row still exists so the
  -- transcript reads correctly in a rehearsal.
  simulated boolean not null default false,
  error text,

  created_at timestamptz not null default now()
);

create index if not exists idx_dm_messages_subscriber
  on dm_messages (subscriber_id, created_at desc);

-- ── updated_at triggers (function defined in frontend 001) ──────────────────
drop trigger if exists dm_funnels_updated_at on dm_funnels;
create trigger dm_funnels_updated_at
  before update on dm_funnels
  for each row execute function update_updated_at();

drop trigger if exists dm_subscribers_updated_at on dm_subscribers;
create trigger dm_subscribers_updated_at
  before update on dm_subscribers
  for each row execute function update_updated_at();

drop trigger if exists dm_funnel_runs_updated_at on dm_funnel_runs;
create trigger dm_funnel_runs_updated_at
  before update on dm_funnel_runs
  for each row execute function update_updated_at();

-- ── Recognition columns, re-runnably ────────────────────────────────────────
-- `create table if not exists` skips the whole statement on an upgrade, so a
-- column added to the body above would never reach an install that already ran
-- an earlier copy of this file. These alters are what actually apply it.
alter table dm_funnels add column if not exists skip_email_if_known boolean not null default true;
alter table dm_funnels add column if not exists stat_recognised integer not null default 0;

-- Recognising someone by their Instagram handle is a lookup on every inbound
-- message, so it gets an index. Partial: most leads have no handle recorded.
create index if not exists idx_leads_instagram_username
  on leads ((lower(custom->>'instagram_username')))
  where custom->>'instagram_username' is not null;

-- ── Approvals queue learns a new action type ────────────────────────────────
-- Activating a funnel is an EXTERNAL action — it starts messaging real people
-- — so it goes through agent_actions like a workflow activation does, rather
-- than the agent flipping status itself. Dropped and re-added because 200's
-- constraint is written to be widened this way.
alter table agent_actions drop constraint if exists agent_actions_type_check;
alter table agent_actions
  add constraint agent_actions_type_check
  check (type in ('email', 'publish', 'workflow', 'dm_funnel', 'other'));

-- ── RLS: service-role only, like the rest of the CRM ────────────────────────
alter table dm_funnels enable row level security;
alter table dm_subscribers enable row level security;
alter table dm_funnel_runs enable row level security;
alter table meta_webhook_events enable row level security;
alter table dm_messages enable row level security;
