# Detailed Setup (Manual)

For developers who'd rather wire things up by hand instead of running the one-command install. This is what the install script does, in human form.

> If you just want a working website with no fuss, skip this and run the one-command install:
> `bash <(curl -fsSL https://gist.githubusercontent.com/envisionedbrands/646e94e9c1b95f2b5bb97e95a197a319/raw/envisioned-install.sh)`

---

## What you need first

Same as the prep checklist — see
[PREP-BEFORE-INSTALL.md](https://gist.github.com/envisionedbrands/646e94e9c1b95f2b5bb97e95a197a319#file-prep-before-install-md).

You should have:
- GitHub, Cloudflare, Supabase, Anthropic accounts
- Supabase project URL, anon key, service role key, DB password, pooler URL
- Anthropic API key
- Tools: Node 20+, git, gh CLI, psql, wrangler

---

## Steps

### 1. Fork + clone

```bash
gh repo fork envisionedbrands/envisioned-intelligent-websites-backend
gh repo fork envisionedbrands/envisioned-intelligent-websites-frontend
mkdir -p ~/Code/envisioned && cd ~/Code/envisioned
gh repo clone <your-username>/envisioned-intelligent-websites-backend
gh repo clone <your-username>/envisioned-intelligent-websites-frontend
```

### 2. Backend env

```bash
cd ~/Code/envisioned/envisioned-intelligent-websites-backend
cp .env.local.example .env.local
```

Fill `.env.local` with:

```
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
DATABASE_URL=postgresql://postgres.<ref>:<URL-ENCODED-PASSWORD>@aws-0-eu-west-1.pooler.supabase.com:5432/postgres
ANTHROPIC_API_KEY=sk-ant-...
API_SECRET_KEY=<random 32+ char string — generate with: openssl rand -hex 32>
NEXT_PUBLIC_DIGITAL_HOME_URL=https://your-frontend.workers.dev
```

### 3. Run migrations

```bash
psql "$(grep ^DATABASE_URL= .env.local | cut -d= -f2-)" -f supabase/migrations/001_backend_core.sql
```

Run any further migrations in numeric order.

### 4. Local dev

```bash
npm install
npm run dev    # serves on :3001
```

### 5. Deploy backend

```bash
wrangler login   # first time only
npm run deploy
```

This runs `opennextjs-cloudflare build && wrangler deploy`. After deploy, set Cloudflare secrets:

```bash
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put API_SECRET_KEY
wrangler secret put RESEND_API_KEY  # optional
```

Update `wrangler.jsonc` `vars` block with your real Supabase URL + anon key + frontend URL, then `npm run deploy` once more for the values to land.

### 6. Frontend (separate repo)

Same pattern. See the [frontend repo's DETAILED-SETUP.md](https://github.com/envisionedbrands/envisioned-intelligent-websites-frontend/blob/main/DETAILED-SETUP.md).

### 7. Create your admin user

In Supabase dashboard → Authentication → Users → Add user. Set an email + password. There's no public signup — admin users are added here only.

### 8. Log in

Visit your backend URL (`https://envisioned-intelligent-websites-backend.<your-account>.workers.dev`), log in with the user you just created. Click around — Content, Wiki, Leads, Stats. Generate your first article.

---

## Running migrations later

```bash
cd ~/Code/envisioned/envisioned-intelligent-websites-backend
psql "$(grep ^DATABASE_URL= .env.local | cut -d= -f2-)" -f supabase/migrations/<NN>_whatever.sql
```

All migrations are idempotent — safe to re-run.

---

## Pulling upstream changes

`upstream` remote points at this template repo (`envisionedbrands/envisioned-intelligent-websites-backend`).
Pull future improvements with:

```bash
git fetch upstream
git merge upstream/main
```

Resolve any conflicts in customized files, then push to your fork.

---

## Architecture

- **Framework:** Next.js 15 + React 19
- **Runtime:** Cloudflare Workers (via OpenNext)
- **Database:** Supabase (PostgreSQL)
- **AI:** Anthropic API (Claude)
- **Email:** Resend (optional)
- **Auth:** Supabase Auth (admin-only — no public signup)

---

*Part of the Envisioned Intelligent Websites product family by Maria-Ines Design Studio (d/b/a Envisioned).*
