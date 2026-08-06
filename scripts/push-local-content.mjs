#!/usr/bin/env node
/**
 * push-local-content.mjs — push a piece written locally into the backend.
 *
 * The writing happens on a flat-rate Claude subscription; only the finished
 * piece crosses the wire. The backend's own ANTHROPIC_API_KEY stays for small
 * jobs (rewriting a subject line), not for drafting essays.
 *
 * It lands as a DRAFT. Publishing is a separate, deliberate act in /content —
 * nothing here can put anything on the public site.
 *
 *   node scripts/push-local-content.mjs <file.md> [--dry-run]
 *
 * The markdown file needs YAML-ish frontmatter:
 *
 *   ---
 *   title: The piece's title
 *   slug: the-piece-s-title
 *   excerpt: One or two sentences.
 *   content_type: article        # article|case_study|video|guide|landing_page|snippet
 *   semantic_tags: [codification, ai]
 *   target_keyword: founder codification
 *   pillar_topic: Codification
 *   featured_image_url: https://...
 *   ---
 *
 *   Body starts here.
 *
 * Auth: needs API_SECRET_KEY — the HMAC signing secret, shared with the Worker.
 * Read from the environment, or from a gitignored .env.local at the repo root.
 * It is never written to disk by this script and never printed.
 */

import { createHmac } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BACKEND_URL =
  process.env.BACKEND_URL ||
  'https://envisioned-intelligent-websites-backend.wandering-mouse-6d47.workers.dev';

/** Valid enum values. Sending anything else makes Postgres reject the insert
 *  with a type error that reads like a server fault, so we fail early instead.
 *  Kept in sync with src/types/database.ts. */
const ENUMS = {
  content_type: ['article', 'case_study', 'video', 'guide', 'landing_page', 'snippet'],
  intent_type: [
    'how_to', 'comparison', 'definition', 'informational', 'commercial',
    'transactional', 'listicle', 'case_study', 'opinion',
  ],
  priority: ['high', 'medium', 'low'],
};

/** Returns the value if it's a legal member of that enum; exits with a readable
 *  message if not. Frontmatter is hand-written, so a typo here is likely. */
function checkEnum(name, value, fallback) {
  const v = value || fallback;
  if (!ENUMS[name].includes(v)) {
    die(`${name} "${v}" is not valid.\n  Use one of: ${ENUMS[name].join(', ')}`);
  }
  return v;
}

function loadSecret() {
  if (process.env.API_SECRET_KEY) return process.env.API_SECRET_KEY.trim();

  const envPath = resolve(REPO_ROOT, '.env.local');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*API_SECRET_KEY\s*=\s*(.+)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    }
  }

  die(
    'API_SECRET_KEY not found.\n\n' +
      '  Put it in a line of ' + envPath + ' :\n' +
      '      API_SECRET_KEY=your-key-here\n\n' +
      '  That file is gitignored. It must be the SAME value as the Worker secret,\n' +
      '  because the Worker signs with API_REQUEST_SIGNING_SECRET || API_SECRET_KEY.'
  );
}

function die(msg) {
  console.error('\n✘ ' + msg + '\n');
  process.exit(1);
}

/** Minimal frontmatter reader. Handles `key: value` and `key: [a, b]`. */
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) die('No frontmatter found. The file must start with a --- block.');

  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim().replace(/^["']|["']$/g, '');
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
    meta[kv[1]] = value;
  }
  return { meta, body: m[2].trim() };
}

/** HMAC over METHOD:pathname:timestamp:body — must match src/lib/api/auth.ts. */
async function call(method, path, payload, secret, dryRun) {
  const bodyText = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', secret)
    .update([method.toUpperCase(), path, timestamp, bodyText].join(':'))
    .digest('hex');

  if (dryRun) {
    console.log(`  [dry-run] ${method} ${path}`);
    console.log(`            ${bodyText.slice(0, 160)}${bodyText.length > 160 ? '…' : ''}`);
    return { dryRun: true, id: '00000000-dry-run' };
  }

  const res = await fetch(BACKEND_URL + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-api-key': secret,
      'x-timestamp': timestamp,
      'x-signature': signature,
    },
    body: bodyText,
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    die(`${method} ${path} returned non-JSON (HTTP ${res.status}):\n${text.slice(0, 400)}`);
  }
  if (!res.ok) die(`${method} ${path} failed (HTTP ${res.status}): ${json.error || text}`);
  return json;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) die('Usage: node scripts/push-local-content.mjs <file.md> [--dry-run]');
  if (!existsSync(file)) die(`File not found: ${file}`);

  const { meta, body } = parseFrontmatter(readFileSync(file, 'utf8'));
  if (!meta.title) die('Frontmatter needs a `title`.');
  if (!body) die('The file has frontmatter but no body.');

  const slug =
    meta.slug ||
    meta.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

  const contentType = checkEnum('content_type', meta.content_type, 'article');
  const intentType = checkEnum('intent_type', meta.intent_type, 'opinion');
  const priority = checkEnum('priority', meta.priority, 'medium');

  const secret = dryRun ? 'dry-run-placeholder' : loadSecret();
  const words = body.split(/\s+/).filter(Boolean).length;

  console.log(`\n  ${meta.title}`);
  console.log(`  slug: ${slug}   ${words} words   → ${BACKEND_URL}\n`);

  // 1 — the article itself, as a draft.
  //     created_by must be one of human|content_agent|seo_agent; the enum has
  //     no local_push value, so the local origin is recorded on the calendar
  //     entry (free-text) which is what /content actually reads.
  const { article } = await call(
    'POST',
    '/api/articles',
    {
      slug,
      title: meta.title,
      subtitle: meta.subtitle,
      body,
      excerpt: meta.excerpt,
      content_type: contentType,
      status: 'draft',
      created_by: 'human',
      author_name: meta.author_name || 'Maria-Ines',
      featured_image_url: meta.featured_image_url,
      semantic_tags: meta.semantic_tags || [],
      associated_offers: meta.associated_offers || [],
      seo: {
        title: meta.seo_title || meta.title,
        description: meta.excerpt,
        target_keyword: meta.target_keyword,
        keyword_cluster: meta.keyword_cluster,
      },
    },
    secret,
    dryRun
  );
  console.log(`  ✓ article draft created`);

  // 2 — the calendar entry. POST sets status directly, bypassing the PATCH
  //     state machine (planned→approved→writing→draft), so one call does it.
  const { entries } = await call(
    'POST',
    '/api/content-calendar',
    {
      title: meta.title,
      status: 'draft',
      created_by: 'local_push',
      target_keyword: meta.target_keyword,
      keyword_cluster: meta.keyword_cluster,
      pillar_topic: meta.pillar_topic,
      topic_cluster: meta.topic_cluster,
      priority,
      intent_type: intentType,
      notes: `Written locally and pushed from ${file}.`,
    },
    secret,
    dryRun
  );
  const entry = dryRun ? { id: '00000000-dry-run' } : entries[0];
  console.log(`  ✓ calendar entry created (created_by=local_push)`);

  // 3 — link them. POST /api/content-calendar ignores content_object_id;
  //     only PATCH accepts it. No status change here, so no transition check.
  await call(
    'PATCH',
    `/api/content-calendar/${entry.id}`,
    { content_object_id: dryRun ? null : article.id },
    secret,
    dryRun
  );
  console.log(`  ✓ linked`);

  console.log(
    dryRun
      ? '\n  Dry run. Nothing was sent.\n'
      : `\n  Done — sitting as a DRAFT on the Ready board.\n  Review: ${BACKEND_URL}/content\n`
  );
}

main().catch((e) => die(e.stack || String(e)));
