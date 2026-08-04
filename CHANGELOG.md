# Changelog

All notable changes to the Digital Home Backend Starter.

## [2.5.1] — 2026-08-03

Social calendar fixes, straight from production use:

- Carousels now render as carousels in the post modal (previously showed
  only the first slide).
- The `social-manager` role can read connected accounts (previously
  couldn't see which platforms were wired up).
- The studio board self-heals when a post was replaced or deleted in
  another session (no more stale "Not found" errors).

## [2.5.0] — 2026-08-03

The operating-system release: your backend grows from a content pipeline
into a full CRM, email automation engine, social calendar, and bookings
system.

### Added

**CRM (the headline)**
- AI-native CRM at `/crm`: leads, activity timelines, custom fields, tags,
  pipelines with drag-through stages, opportunities, and tasks.
- Universal capture endpoint (`POST /api/crm/capture`, key-protected) —
  point every form on your site at it; leads upsert with full activity
  history.
- Auto-pipeline: every real inbound lead opens an opportunity in your first
  stage; entering an email sequence advances it (forward-only).
- Email workflow engine: sequences with wait/tag/stage/webhook/task steps,
  AI-drafted sequences and rewrites (bring your Anthropic key), A/B subject
  tests, per-send open/click tracking, sent-email viewer.
- Safe mode ON by default — workflows run fully but sends are simulated
  until you flip the switch. Suppression, bounce circuit-breaker,
  reputation send-budget, and optional business-hours send windows built in.
- Lead scoring, engagement sensing, hot-lead alerts, attribution, and a
  weekly report.
- Funnel analytics: ingest events from any funnel, see step-by-step stats
  at `/crm/funnel`.
- Engine tick runs on a native Cloudflare cron (no GitHub Action needed).

**Social calendar**
- Social studio at `/social`: plan, compose, and publish to Instagram,
  Facebook, and YouTube from one calendar.
- **Post Now**: publish immediately from the composer (fire-and-forget —
  the engine runs inline and the calendar card tracks progress).
- Multi-slide carousels, single-photo posts, and short-form video
  distribution (IG Reels / FB Reels / YouTube Shorts).
- Media storage on Cloudflare R2: multipart uploads (no 50MB cap), free
  egress for Meta's pulls, refcounted deletion. Images auto-normalize to
  JPEG and auto-crop into Instagram's accepted ratio range on upload;
  video aspect guards warn on non-9:16.
- Meta business-login connect flow + manual connect script; Google OAuth
  for YouTube.
- `social-manager` role for team members who only touch social.

**Bookings**
- Cal.com integration: webhook sync, appointment tracking in the CRM, and
  automatic 24h/1h reminder emails.

**Content pipeline**
- Per-article image direction with cinematic hero style.
- Pull quotes, canonical internal links, pillar-topic directives, and
  deeper long-form output.
- Archived articles free up weekly calendar slots.

**Dashboard**
- Full design-system rework: light/dark mode, legible typography,
  collapsible sidebar with CRM and Social sections.

### Database
- New migration `supabase/migrations/002_crm_core.sql` (CRM, funnel,
  social, bookings schema). Requires the Frontend Starter's base
  migrations (001–011) — already applied if your Digital Home is set up.
- `src/types/database.ts` updated — must stay identical to the copy in
  the Frontend Starter (companion frontend release syncs it).

### Upgrading
See [UPGRADE.md](UPGRADE.md) — written to be handed to Claude Code inside
your own backend project.
