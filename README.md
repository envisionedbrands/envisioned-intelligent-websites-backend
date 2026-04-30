# Envisioned Intelligent Websites — Backend

The headless content engine + AI agent infrastructure powering the Envisioned
Intelligent Websites product family.

```
┌─ Backend (this repo) ─────────────────────────────────────────┐
│                                                               │
│  • AI content pipeline (idea → outline → article → publish)   │
│  • Wiki sync (markdown brand intelligence → Supabase)         │
│  • Lead capture API + embed snippet for external sites        │
│  • Publisher adapters (Showit / WP / Webflow / Squarespace /  │
│    Ghost / Notion / Substack)                                 │
│  • Admin dashboard (content, leads, analytics, agents)        │
│                                                               │
└────────────────────┬──────────────────────────────────────────┘
                     │ writes to
                     ↓
              Supabase (shared DB)
                     ↑
                     │ reads from
┌─ Frontend ──────────────────────────────────────────────────────┐
│  • envisioned-intelligent-websites-template-editorial           │
│  • envisioned-intelligent-websites-template-warm                │
│  • OR any external website via publisher adapter + lead embed   │
└─────────────────────────────────────────────────────────────────┘
```

## Three usage modes

This backend is designed to support three different audiences:

1. **You already have a website** (Showit, Squarespace, Webflow, WordPress, etc.)
   → install the backend, pick a publisher adapter for your CMS, paste the
   lead-capture embed onto your contact page. AI writes articles, publishes
   to your existing site.

2. **You want a fresh editorial site** (bold, dark, authoritative)
   → install the backend + `envisioned-intelligent-websites-template-editorial`.

3. **You want a fresh warm site** (soft, light, intimate)
   → install the backend + `envisioned-intelligent-websites-template-warm`.

In all three modes, the backend is the same. Only the publishing target differs.

## Status

🚧 **Work in progress.** This repo is being assembled from a working reference
implementation. Forks are welcome but expect the API surface to shift as the
product line stabilizes.

## Quick start

The fastest path is via the installer:

```bash
# Coming soon — a Claude Code skill that runs a brand interview and
# provisions a full Envisioned Intelligent Websites stack.
```

Manual setup instructions will live in `SETUP.md` once the templates and
installer are wired up.

## Architecture

- **Framework:** Next.js 15
- **Runtime:** Cloudflare Workers (via OpenNext)
- **Database:** Supabase (PostgreSQL)
- **AI:** Anthropic API (configurable to OpenAI as fallback)
- **Email:** Resend
- **Auth:** Supabase Auth (admin-only — there is no public signup)

## License

MIT — see [`LICENSE`](./LICENSE). This work is built on the Digital Home Starter
by BraveBrand (also MIT) — see [`LICENSE-BRAVEBRAND`](./LICENSE-BRAVEBRAND) and
[`NOTICE.md`](./NOTICE.md) for attribution and what this fork adds.

---

*Part of the Envisioned Intelligent Websites product family by Maria-Ines Design Studio (d/b/a Envisioned).*
