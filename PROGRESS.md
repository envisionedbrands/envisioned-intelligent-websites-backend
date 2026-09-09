# Envisioned — Digital Home Progress

## 2026-09-09 — found and fixed: lead capture was silently broken since 09-01

Prompted by MI asking "is envisioned.me connected to what it needs to connect
to." Traced the whole chain (homepage → Map/founder-access/contact →
backend → Supabase) instead of trusting config. Found two real, live bugs:

1. **`digital-home-frontend-starter`'s `API_SECRET_KEY` didn't match the
   backend's.** Every HMAC-signed frontend→backend call (founder-access,
   and anything else using `signedCrmPost`) was failing auth. Fixed: synced
   the frontend's secret to the backend's value via `wrangler secret put`
   (backend's secret untouched — other consumers of it, e.g. claudeclaw
   ops tooling, weren't at risk).
2. **The bigger one: every INSERT into `public.leads` had been failing
   outright** with `permission denied for table hooks`, since the
   `ops-daemon-leads` Database Webhook trigger was added 2026-09-01
   (Stage 3 Client Movement Loop, MI's "ok go" same day) — the trigger
   calls `supabase_functions.http_request(...)`, and `service_role` had
   never been granted `USAGE` on the `supabase_functions` schema. This is
   almost certainly the real explanation for "359 leads, none in the 12
   days before today" noted below — not a traffic problem, a silent outage.
   Fixed with `GRANT USAGE ON SCHEMA supabase_functions ...` (+ table/
   sequence/routine grants) to `service_role, anon, authenticated`.

Verified both fixes with a real test submission through the live
`founder-access` endpoint (200, real row landed in `leads` +
`assessment_completions`), then deleted the test row. Lead count back to
359 afterward, confirmed via direct count.

**Not yet separately verified:** whether the `ops-daemon-leads` webhook
itself now successfully delivers to `clients.envisioned.me/webhooks/envisioned`
(the fix targets the INSERT permission, which is what was blocking leads;
whether the HTTP delivery on the other end succeeds is a smaller, separate
question worth a follow-up check, not a lead-capture blocker).

## Where things stand (2026-09-08)

Adopted, not built from scratch. This Home was already live, in real use,
with 359 leads in the CRM, when Simon (Digital Home Manager) picked it up.

- **Backend repo:** `/Users/maria-ines/repos/envisioned-backend`
  (`envisionedbrands/envisioned-intelligent-websites-backend`, branch `main`)
- **Frontend repo:** `/Users/maria-ines/Code/envisioned/envisioned-intelligent-websites-frontend`
  (`envisionedbrands/envisioned-intelligent-websites-frontend`, branch `main`)
- **Deployed backend URL:** https://app.envisioned.me (custom domain, live)
  — fallback: https://envisioned-intelligent-websites-backend.wandering-mouse-6d47.workers.dev
- **Deployed frontend URL:** https://www.envisioned.me (`home.envisioned.me` redirects here)
- **Supabase project ref:** `aqylffhuzunpimrebgye`
- **Worker:** `envisioned-intelligent-websites-backend`
- **VERSION:** 2.8.0 (current with the official starter as of today)

## What happened today

1. **Adoption health check.** Verified the above against live evidence
   (Cloudflare deployments, direct HTTP checks, git remotes) rather than
   assuming from config. Found repo VERSION was 2.5.6, three releases
   behind. Registered the Home in the shared BraveBrand registry.
2. **Business pulse.** 359 leads total, none in the 12 days before today.
   0 opportunities ever created from any lead — the Sales Pipeline exists
   but nothing was flowing into it. The "3-Email Welcome Nurture" workflow
   was in `draft` AND had a broken trigger (`manual`, which the CRM engine
   never matches to a real event) — fixed the trigger to `lead_created`,
   left it in `draft` pending her review of the copy (safe mode is off
   system-wide, so activating it sends real email immediately).
3. **Version upgrade 2.5.6 → 2.8.0**, approved and deployed:
   - Walked the full official patch chain release by release, hand-merging
     every file with real customizations instead of blind-overwriting
     (leads list/page, content pipeline pages, sidebar nav/branding,
     `middleware.ts`, `worker.ts`, `wrangler.jsonc`).
   - Caught and fixed a real bug in the process: the stock upgrade path
     would have silently dropped the `/data-deletion` Meta App Review
     exemption from `middleware.ts`. Preserved it, verified live post-deploy.
   - New capability landed: Brand Playbook shelf (`/brand`, currently
     empty — no research written yet), signed brand publishing, Articles
     Pipeline/Published split, optional social calendar gate.
   - **Deliberately did not merge `src/types/database.ts`.** Upstream added
     ~600 lines of new table types (`agent_*`, `carousel_*`, `studio_*`)
     that substantially overlap with tables this repo already has custom,
     independently-built versions of (the Operator agent at `/agent`, the
     Carousels feature). Nothing shipped today depends on the new types;
     everything compiles and tests clean without them. Revisit only if a
     future upgrade genuinely needs one of those new tables — diff
     carefully against the live schema first, don't blind-merge.
   - Committed the pending DM-funnel fix (`src/lib/social/dm-funnel.ts`)
     that was sitting uncommitted in the working tree before touching
     anything else, so it wasn't lost in the upgrade.
   - No database migration was required anywhere in this version range.
   - Verified before and after deploy: `tsc --noEmit` clean, `test:social`
     12/12, `test:brand` 8/8, articles UI contract test passing, production
     build clean, then live HTTP checks against `app.envisioned.me` post-deploy
     (root 200, auth-gated routes redirect correctly, `/data-deletion` still
     public, social API returns the expected `SOCIAL_PUBLISHING_DISABLED`).
   - Branch `upgrade/v2.8.0` fast-forward merged into `main` and pushed.
     Deployed. Worker Version ID `ec80587e-5b12-408a-9b38-ba2ef74e34c5`.

## Open items

- **Social calendar — activated 2026-09-08.** She enabled R2 on the
  Cloudflare account; created the `social-media` bucket, attached
  `media.envisioned.me` as its public custom domain (SSL active, verified),
  set `R2_PUBLIC_BASE` and flipped `SOCIAL_PUBLISHING_ENABLED` to `true`,
  redeployed. Proved the full upload → R2 → public URL pipeline with a real
  bounded test post (created as draft, uploaded, verified publicly
  reachable, then deleted through the app's own delete endpoint — no
  leftover data). She already has **active connected accounts** from before
  (2 Facebook pages + 1 Instagram, plus one disconnected Facebook page) —
  this was not a fresh social setup, the calendar is now live and usable
  immediately, not pending a separate account-connection step. No posts
  were sitting in `scheduled`/`publishing` state when this went live, so
  nothing auto-fired on activation. 3 drafts and 1 previously-published
  post exist from before.
- **Welcome nurture workflow** — wired correctly now (`lead_created` trigger)
  but left in `draft`. She hasn't approved the copy for real sending yet
  (safe mode is off, so activating it means real email immediately). Ask
  her before flipping it live.
- **359 leads, 0 opportunities** — a process gap, not a software one. Worth
  raising with her again: leads are landing, nothing is converting them
  into pipeline deals.
- **Brand Playbook shelf is live but empty.** Recommended Tumi (Brand
  Strategist) as the next hire to fill it — her call.
- **Content Studio** — not installed. Requires a signed release brief from
  Bob (Content Manager); Simon has no store pointer for it yet.
- **Backend custom domain** was already `app.envisioned.me` before today —
  not something this session set up, just confirmed and corrected a stale
  assumption from an outdated wrangler.jsonc comment.

## Access status (non-secret)

- Cloudflare: authenticated (`hello@mariaines.co`, OAuth token, this machine).
- GitHub: authenticated (`envisionedbrands` account, `repo` + `workflow` scopes).
- Supabase: `.env.local` on this machine holds the service role key (not
  copied here). Confirmed working via live queries during today's session.
