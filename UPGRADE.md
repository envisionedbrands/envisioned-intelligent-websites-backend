# Upgrading your Digital Home Backend

This guide is written to be executed by **Claude Code inside your own
backend project**. Paste this into Claude Code from your backend project
folder:

> Fetch https://raw.githubusercontent.com/lukesbrave/digital-home-backend/main/UPGRADE.md
> and upgrade my backend to the latest version. My project may be
> customized — preserve my changes while applying the upgrade.

---

## Instructions for Claude

You are upgrading a member's Digital Home backend — a customized fork of
`digital-home-backend`. Work inside THEIR project. Their
customizations are intentional: **merge, don't overwrite.** When a file
conflicts, prefer their copy design-wise and add the new capability into it.

### Step 0 — Determine current version
- If a `VERSION` file exists, read it. If it says `2.5.0` or higher, stop —
  already up to date.
- No `VERSION` file = v1.x (content pipeline era). Apply the full v2.5.0
  upgrade below.
- Confirm this is really the backend (has `src/app/api/write-article/` or
  similar) and NOT the frontend. If it's the frontend, stop and say so.

### Step 1 — Preflight
1. `git status` — if there are uncommitted changes, commit or stash them
   first so the upgrade is revertible.
2. Create a branch: `git checkout -b upgrade/v2.5.0`.
3. Add the starter as a remote if missing:
   `git remote add starter https://github.com/lukesbrave/digital-home-backend.git`
   then `git fetch starter --tags`.

### Step 2 — Bring in v2.5.0
1. Diff `git diff HEAD..v2.5.0 --stat` to see scope.
2. New files (the vast majority) can be checked out directly:
   `git checkout v2.5.0 -- <path>` for: `src/lib/crm/`, `src/lib/social/`,
   `src/app/api/crm/`, `src/app/api/social/`, `src/app/api/settings/`,
   `src/app/api/webhooks/`, `src/app/crm/`, `src/app/social/`,
   `src/components/crm/`, `worker.ts`, `scripts/deploy.sh`,
   `scripts/apply-migration.mjs`, `scripts/connect-meta.mjs`,
   `scripts/social-post.mjs`, `supabase/migrations/002_crm_core.sql`,
   `CRM.md`, `SOCIAL.md`, `BOOKINGS.md`, `CHANGELOG.md`, `VERSION`.
3. Shared files — MERGE these by hand, preserving the member's edits:
   `src/components/sidebar.tsx` (add CRM + Social nav sections),
   `src/middleware.ts`, `src/lib/api/auth.ts` (social role + signed
   requests), `src/types/database.ts` (take v2.5.0's copy wholesale unless
   they added their own tables — then merge), `package.json` (add new deps,
   keep theirs), `tsconfig.json`, `wrangler.jsonc` (add the cron trigger;
   KEEP their routes/domains/vars), `src/app/api/write-article/route.ts`
   and `src/app/api/trend-scan/route.ts` (take v2.5.0 unless customized).
4. `npm install`.

### Step 3 — Database
1. **Before applying anything, read their env and tell the member which
   Supabase project URL it points at, and ask them to confirm it's theirs.**
   Never apply a migration to a database you haven't confirmed out loud.
2. Apply `supabase/migrations/002_crm_core.sql` to their Supabase project
   (use `scripts/apply-migration.mjs` or the Supabase SQL editor).
   It is additive — no destructive changes.
2. **Frontend pairing:** copy `src/types/database.ts` byte-identical into
   their frontend project (`digital-home-frontend` fork), commit
   there too. Both repos share one Supabase — types must match.

### Step 4 — Configuration
1. Env vars (`.env.local` + Cloudflare secrets): `CAPTURE_KEY` (new —
   generate a random string), `RESEND_API_KEY` (email sending; can wait),
   optional `CALCOM_WEBHOOK_SECRET`, Meta/Google OAuth creds for social
   (can wait — see SOCIAL.md).
2. Safe mode ships ON — emails simulate until they flip
   `crm_safe_mode` off in `/crm/settings`. Tell the member this explicitly.

### Step 5 — Verify (walk the member through it)
1. `npx tsc --noEmit` clean, `npm run build` clean, deploy.
2. Log into the dashboard — CRM and Social appear in the sidebar,
   light/dark toggle works.
3. Point one site form at `POST /api/crm/capture` with the `x-capture-key`
   header → submit it yourself → the lead appears in `/crm` with an
   activity entry and an opportunity in the first stage.
4. Draft a 2-step test workflow, enroll yourself, run "Run engine now" —
   the send appears as `simulated` in the sent-email viewer.
5. Commit, merge the branch, deploy. Done — write `2.5.0` into `VERSION`
   if not already there.

### If something breaks
Revert is always available: `git checkout main` (the upgrade lives on its
branch until merged). The migration is additive and safe to leave applied.

## Patch upgrades (you're already on 2.5.x)

If your `VERSION` says `2.5.0` and the latest is `2.5.1`: fetch the starter
remote (`git fetch starter --tags`) and take the patched files directly —

    git checkout v2.5.1 -- "src/app/api/social/accounts/route.ts" "src/app/social/accounts/page.tsx" "src/app/social/page.tsx" VERSION CHANGELOG.md

If the member has customized any of these files, merge instead of
overwrite. Then build, verify the social studio loads, and deploy.
No database changes in this patch.
