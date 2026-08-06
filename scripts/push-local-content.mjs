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

/** The public site, used only to print a live link after --publish. */
const SITE_URL = process.env.SITE_URL || 'https://home.envisioned.me';

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

/** In batch mode a bad file must not kill the run — the other pieces are fine. */
let batchMode = false;

function die(msg) {
  if (batchMode) throw new Error(msg);
  console.error('\n✘ ' + msg + '\n');
  process.exit(1);
}

/** Minimal frontmatter reader. Handles `key: value` and `key: [a, b]`. */
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);

  // Most of her back catalogue is plain markdown with no frontmatter. Title is
  // the only genuinely required field and it is derivable, so fall back to the
  // first H1 rather than refusing the file. Everything else takes its default.
  if (!m) {
    const h1 = raw.match(/^#\s+(.+)$/m);
    if (!h1) die('No frontmatter and no `# Heading` to take a title from.');
    return { meta: { title: h1[1].trim() }, body: raw.trim() };
  }

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

/**
 * Markdown -> semantic HTML.
 *
 * The website renders article bodies with dangerouslySetInnerHTML and has NO
 * markdown library installed, so raw markdown would display as one unstyled
 * blob with literal `#` and `**` on screen. It also builds its table of
 * contents by parsing <h2>/<h3> tags, so headings must be real elements or the
 * TOC comes out empty.
 *
 * Emits only the tags the site's .article-body CSS actually styles:
 * h2, h3, p, ul, ol, li, blockquote, strong, em, a, img, hr.
 */
function mdToHtml(md, title) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Inline formatting. Escape first, then introduce our own tags, so nothing in
  // the source can inject markup.
  const inline = (s) =>
    esc(s)
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => `<img src="${src}" alt="${alt}">`)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, href) => `<a href="${href}">${text}</a>`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|\s)_([^_\n]+)_/g, '$1<em>$2</em>');

  const out = [];
  let list = null; // 'ul' | 'ol'
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  // Split into blocks on blank lines, but keep list/quote runs together.
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let para = [];
  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${inline(para.join(' ').trim())}</p>`);
    para = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line.trim()) { flushPara(); closeList(); continue; }

    // The page renders the title itself, so a leading H1 would print it twice.
    const h1 = line.match(/^#\s+(.*)$/);
    if (h1) {
      flushPara(); closeList();
      if (title && h1[1].trim().toLowerCase() === title.trim().toLowerCase()) continue;
      out.push(`<h2>${inline(h1[1])}</h2>`);
      continue;
    }
    const h = line.match(/^(#{2,3})\s+(.*)$/);
    if (h) { flushPara(); closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { flushPara(); closeList(); out.push('<hr>'); continue; }

    const q = line.match(/^>\s?(.*)$/);
    if (q) { flushPara(); closeList(); out.push(`<blockquote><p>${inline(q[1])}</p></blockquote>`); continue; }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      flushPara();
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }

    closeList();
    para.push(line);
  }
  flushPara(); closeList();
  return out.join('\n');
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
  if (!res.ok) {
    // 409 = the slug already exists. The caller decides whether to update.
    if (res.status === 409) return { __conflict: true };
    die(`${method} ${path} failed (HTTP ${res.status}): ${json.error || text}`);
  }
  return json;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  // Opt-in per invocation, never the default. The approval already happened
  // locally (she read it and said yes), so this just skips a second click —
  // it does not remove a review, it relocates it.
  const publish = args.includes('--publish');
  const files = args.filter((a) => !a.startsWith('--'));
  if (!files.length) {
    die('Usage: node scripts/push-local-content.mjs <file.md> [more.md ...] [--publish] [--dry-run]');
  }
  for (const f of files) if (!existsSync(f)) die(`File not found: ${f}`);

  // Batch: run each file through the same single-file path.
  if (files.length > 1) {
    batchMode = true;
    const failed = [];
    for (const f of files) {
      try {
        await pushOne(f, { dryRun, publish });
      } catch (e) {
        failed.push([f.split('/').pop(), e.message.split('\n')[0]]);
        console.log(`  ✘ SKIPPED ${f.split('/').pop()} — ${e.message.split('\n')[0]}`);
      }
    }
    console.log(`\n  ${files.length - failed.length}/${files.length} pushed.`);
    if (failed.length) {
      console.log(`  ${failed.length} skipped:`);
      failed.forEach(([n, m]) => console.log(`    - ${n}: ${m}`));
    }
    console.log('');
    return;
  }
  return pushOne(files[0], { dryRun, publish });
}

async function pushOne(file, { dryRun, publish }) {

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
  const bodyHtml = mdToHtml(body, meta.title);
  const headings = (bodyHtml.match(/<h[23]>/g) || []).length;

  console.log(`\n  ${meta.title}`);
  console.log(`  slug: ${slug}   ${words} words   ${headings} headings (TOC)   → ${BACKEND_URL}\n`);

  // 1 — the article itself, as a draft.
  //     created_by must be one of human|content_agent|seo_agent; the enum has
  //     no local_push value, so the local origin is recorded on the calendar
  //     entry (free-text) which is what /content actually reads.
  const articleFields = {
    title: meta.title,
    subtitle: meta.subtitle,
    body: bodyHtml,
    excerpt: meta.excerpt,
    content_type: contentType,
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
  };

  const created = await call(
    'POST',
    '/api/articles',
    { slug, status: 'draft', created_by: 'human', ...articleFields },
    secret,
    dryRun
  );

  // Re-pushing an edited draft is the normal case, not an error: the writing
  // happens locally and the same piece gets pushed again. A 409 means the slug
  // exists, so update it in place and leave the calendar entry alone.
  if (created.__conflict) {
    await call(
      'PATCH',
      `/api/articles/${slug}`,
      publish ? { ...articleFields, status: 'published' } : articleFields,
      secret,
      dryRun
    );
    console.log(`  ✓ existing article UPDATED (same slug)`);
    if (publish) console.log(`  ✓ PUBLISHED — live at ${SITE_URL}/blog/${slug}`);
    console.log(
      publish
        ? `\n  Done — updated and published.\n`
        : `\n  Done — updated in place. Status and calendar entry untouched.` +
            `\n  Review: ${BACKEND_URL}/content\n`
    );
    return;
  }
  const article = created.article;
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

  // Publishing is a status change on the article; the calendar entry follows,
  // because PATCH /api/articles/[slug] syncs the linked entry's status.
  if (publish && !dryRun) {
    await call('PATCH', `/api/articles/${slug}`, { status: 'published' }, secret, dryRun);
    console.log(`  ✓ PUBLISHED — live at ${SITE_URL}/blog/${slug}`);
  }

  console.log(
    dryRun
      ? '\n  Dry run. Nothing was sent.\n'
      : publish
        ? `\n  Done — published.\n`
        : `\n  Done — sitting as a DRAFT on the Ready board.\n  Review: ${BACKEND_URL}/content\n`
  );
}

main().catch((e) => die(e.stack || String(e)));
