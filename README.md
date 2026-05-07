# Envisioned Intelligent Websites — Backend

The headless content engine + AI agent infrastructure powering the Envisioned
Intelligent Websites product family.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/envisionedbrands/envisioned-intelligent-websites-backend)

---

## What this is

A complete back-of-house for an AI-driven website:

- **AI content pipeline** — idea → outline → article → publish, powered by Anthropic
- **Lead capture API + embed snippet** — drop on any existing site to route submissions to your DB
- **Optional brand wiki sync** — if you keep a private markdown wiki in a separate GitHub repo (any structure), the backend can sync it into Supabase as brand intelligence the AI agents read from. Skip if you don't need it.
- **Publisher adapters** *(roadmap)* — push articles into existing CMS platforms (Showit / WordPress / Webflow / Squarespace / Ghost / Notion / Substack)
- **Admin dashboard** — content calendar, leads, analytics, agents, graph view

Pairs with the [Envisioned Intelligent Websites Frontend](https://github.com/envisionedbrands/envisioned-intelligent-websites-frontend) (templates), or use it standalone with your existing site via a publisher adapter.

---

## One-click deploy

Click the button above. Cloudflare will:

1. Fork this repo into your GitHub account
2. Create a new Cloudflare Worker connected to the fork
3. Deploy on every future push to `main` automatically

You'll then need to set secrets via `wrangler secret put` (or the Cloudflare dashboard):

```bash
wrangler secret put SUPABASE_SERVICE_ROLE_KEY    # from Supabase → Settings → API
wrangler secret put ANTHROPIC_API_KEY            # from console.anthropic.com
wrangler secret put RESEND_API_KEY               # from resend.com (optional, for email)
wrangler secret put API_SECRET_KEY               # any random 32+ char string — must match frontend
```

And update `wrangler.jsonc` `vars` with your actual Supabase URL, anon key, and frontend URL — then push. Cloudflare redeploys automatically.

---

## Local development

```bash
git clone https://github.com/<your-fork>/envisioned-intelligent-websites-backend.git
cd envisioned-intelligent-websites-backend
npm install
cp .env.local.example .env.local      # fill in real values
npm run dev                            # serves on :3001
```

Default port is **3001** (the companion frontend uses :3000).

---

## What you need to bring

| Thing | Where to get it | Required? |
|---|---|---|
| Supabase project | [supabase.com](https://supabase.com) (free tier OK) | ✅ |
| Cloudflare account | [cloudflare.com](https://cloudflare.com) (free tier OK) | ✅ |
| Anthropic API key | [console.anthropic.com](https://console.anthropic.com) (paid, ~$5 minimum) | ✅ for AI features |
| Resend account | [resend.com](https://resend.com) (free tier OK) | Optional |

After you fork the repo, run the schema migrations once in your Supabase SQL Editor:
- `supabase/migrations/001_backend_core.sql`

That installs the `articles`, `content_calendar`, `wiki_articles`, `leads`, and supporting tables.

---

## Three usage modes

| Mode | What happens |
|---|---|
| **You already have a website** (Showit / Squarespace / Webflow / WP) | Deploy backend; pick a publisher adapter; paste the lead-capture embed onto your contact page; AI writes articles, pushes them into your existing site |
| **You want a new editorial site** (bold/dark/authoritative) | Deploy backend + `templates/editorial` from the [frontend repo](https://github.com/envisionedbrands/envisioned-intelligent-websites-frontend) |
| **You want a new warm site** (soft/light/intimate) | Deploy backend + `templates/warm` from the same frontend repo |

---

## Architecture

- **Framework:** Next.js 15
- **Runtime:** Cloudflare Workers (via OpenNext)
- **Database:** Supabase (PostgreSQL)
- **AI:** Anthropic API (configurable to OpenAI as fallback)
- **Email:** Resend
- **Auth:** Supabase Auth (admin-only — there is no public signup)

---

## License

MIT — see [`LICENSE`](./LICENSE). This work is built on the Digital Home Starter
by BraveBrand (also MIT) — see [`LICENSE-BRAVEBRAND`](./LICENSE-BRAVEBRAND) and
[`NOTICE.md`](./NOTICE.md) for attribution and what this fork adds.

---

*Part of the Envisioned Intelligent Websites product family by Maria-Ines Design Studio (d/b/a Envisioned).*
