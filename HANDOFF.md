# Handoff — envisioned-intelligent-websites-backend

> A short orientation for any future Claude Code session (or human teammate)
> picking this up. Keep this updated as the repo evolves.

## What this repo is

The headless content engine + AI agent infrastructure powering the
**Envisioned Intelligent Websites** product family. Forked from BraveBrand's
MIT-licensed Digital Home Backend Starter and re-attributed to
Maria-Ines Design Studio (d/b/a Envisioned).

## Where it sits in the product family

```
envisioned-intelligent-websites-backend            ← THIS REPO
envisioned-intelligent-websites-template-editorial ← bold/dark template (skeleton)
envisioned-intelligent-websites-template-warm     ← soft/light template (skeleton)
envisioned-intelligent-websites-installer         ← brand interview + deploy CLI (skeleton)
```

All four live under `envisionedbrands` on GitHub (private).

## What's done

- ✅ Repo created and seeded from `lukesbrave/digital-home-backend-starter`
  with full git history preserved (MIT chain of custody)
- ✅ LICENSE rewritten under Maria-Ines Design Studio (d/b/a Envisioned)
- ✅ LICENSE-BRAVEBRAND preserved verbatim
- ✅ NOTICE.md added with full attribution + summary of intended additions
- ✅ README rewritten to neutral Envisioned framing (3 usage modes: existing
  site / editorial / warm)
- ✅ `upstream` remote tracks `lukesbrave/digital-home-backend-starter` for
  optional future pulls

## What's NOT done yet (open work)

- ❌ Strip remaining BraveBrand-specific copy from internal docs (`CLAUDE.md`,
  `CONTRIBUTING.md`, `DEPLOYMENT.md`, in-code comments) — currently still
  reflects the upstream. Do this in a single rebrand pass when ready.
- ❌ Build publisher adapters (Showit/WP, Webflow, Squarespace, Ghost,
  Notion, Substack). Recommended order: WordPress (highest reach via Showit),
  Webflow, Squarespace, Ghost, Notion, Substack.
- ❌ Build lead-capture embed snippet (`/embed.js` route + minimal JS)
- ❌ Build manual export endpoint (`POST /api/articles/:id/export?format=html`)
  as the "works for everyone" fallback
- ❌ De-couple Aureum-specific branding from the reference implementation
  (Aureum lives at `aureumai26/intelligent-website-backend` and is currently
  the only working real instance — eventually some of its hardening should
  flow back here as upstream improvements)
- ❌ PRD for the full product — not yet drafted (next step after this scaffold)

## Reference implementation

The Aureum AI agency is currently the only fully wired-up instance of this
backend. It lives at `aureumai26/intelligent-website-backend` (private) and is
deployed at `aureum-backend.team-7e0.workers.dev`. When questions arise about
"how should this work in practice", check that repo — it has live env vars,
real Supabase data, working Cloudflare Workers config, and a months-of-real-use
content pipeline.

**Important:** Aureum's repo has Aureum-specific brand intelligence baked into
its content-corpus folder. Any code patterns or schema decisions extracted
from Aureum's repo back into this one need to be **brand-neutralized** before
landing here.

## Key files / where things live

| Path | What |
|---|---|
| `src/app/content/` | Article editor + content list (admin dashboard) |
| `src/app/api/write-article/route.ts` | AI article writer (Anthropic API) |
| `src/app/api/wiki-sync/route.ts` | Wiki repo → Supabase sync |
| `src/lib/wiki/` | Wiki parsing + GitHub fetching |
| `src/components/sidebar.tsx` | Dashboard nav |
| `supabase/migrations/` | Schema — single migration `001_backend_core.sql` |
| `wrangler.jsonc` | Cloudflare Workers config (deploy target + env vars) |
| `.env.local.example` | Env var contract — keep this in sync as new keys are added |

## How to run locally

Once env is set up:
```bash
npm install
npm run dev   # serves on :3001 (frontend uses :3000)
```

## How to deploy

```bash
npm run deploy
# = opennextjs-cloudflare build && wrangler deploy
```

Requires `wrangler login` first time.

## Upstream sync

The upstream MIT starter at `lukesbrave/digital-home-backend-starter` may push
useful fixes from time to time. To pull them in:

```bash
git fetch upstream
git merge upstream/main   # resolve any conflicts in our customized files
```

Don't blindly merge — always review what's incoming.

---

*Last updated: April 2026. Update this file whenever you complete or shift
something material.*
