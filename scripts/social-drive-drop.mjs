#!/usr/bin/env node
/**
 * social-drive-drop.mjs — the Google Drive → social calendar bridge.
 *
 * Watch target: "My Drive/Envisioned Drop/Ready for Social" (Drive for
 * desktop syncs it locally, so "in Drive" already means "on this Mac").
 * Any finished video or image that lands there is uploaded through the
 * backend's own multipart route and becomes a DRAFT social post — nothing
 * schedules or publishes without a human in the dashboard. Delivery is
 * `scripts/social-post.mjs create` (upload + draft in one call); this file
 * only decides WHEN a file is ready and keeps the folder tidy.
 *
 * Ready means: mtime > 60s old AND size unchanged across a 10s recheck —
 * Drive materialises files progressively and a half-synced video must never
 * be uploaded. Success moves the file (and its optional .txt caption
 * sidecar) into uploaded/, which Drive mirrors back to the cloud, so the
 * drop folder always shows only what is pending. Failure leaves the file in
 * place with a <name>.upload-error.txt beside it and will not retry until
 * the file itself changes (size/mtime keyed), so a broken file cannot loop.
 *
 * Runs as a launchd run-to-completion job (WatchPaths + StartInterval), not
 * a daemon. A lock file makes overlapping triggers exit early.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DROP = join(homedir(), 'Library/CloudStorage/GoogleDrive-hello@mariaines.co/My Drive/Envisioned Drop/Ready for Social');
const DONE = join(DROP, 'uploaded');
const STATE_DIR = join(homedir(), '.config/digital-home/social-drive-drop');
const LOCK = join(STATE_DIR, 'lock');
const STATE = join(STATE_DIR, 'attempted.json');
const LOG = join(STATE_DIR, 'drop.log');
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'social-post.mjs');
const BASE = process.env.BASE || 'https://app.envisioned.me';
const EXT = new Set(['.mp4', '.mov', '.webm', '.jpg', '.jpeg', '.png', '.webp']);

mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(DONE, { recursive: true });
const log = (m) => writeFileSync(LOG, `${new Date().toISOString()} ${m}\n`, { flag: 'a' });

// Overlap guard: stale locks (>15 min) are broken, a crashed run must not wedge the bridge.
if (existsSync(LOCK)) {
  const age = Date.now() - statSync(LOCK).mtimeMs;
  if (age < 15 * 60 * 1000) process.exit(0);
  rmSync(LOCK, { force: true });
}
writeFileSync(LOCK, String(process.pid));

const attempted = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const fileKey = (p, st) => `${basename(p)}:${st.size}:${Math.floor(st.mtimeMs)}`;
const pretty = (name) =>
  name.replace(extname(name), '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

try {
  const candidates = readdirSync(DROP)
    .filter((f) => !f.startsWith('.') && EXT.has(extname(f).toLowerCase()))
    .map((f) => join(DROP, f))
    .filter((p) => statSync(p).isFile())
    .filter((p) => Date.now() - statSync(p).mtimeMs > 60 * 1000);

  if (candidates.length) {
    // Size-stability recheck — one shared 10s wait for the whole batch.
    const before = new Map(candidates.map((p) => [p, statSync(p).size]));
    execFileSync('/bin/sleep', ['10']);
    for (const p of candidates) {
      const name = basename(p);
      let st;
      try { st = statSync(p); } catch { continue; } // vanished mid-wait
      if (st.size !== before.get(p)) { log(`still syncing, skipped: ${name}`); continue; }
      const key = fileKey(p, st);
      if (attempted[key]) continue; // failed before and unchanged since

      const sidecar = join(DROP, name.replace(extname(name), '') + '.txt');
      const caption = existsSync(sidecar) ? readFileSync(sidecar, 'utf8').trim() : pretty(name);
      const args = ['create', '--media', p, '--title', pretty(name), '--caption', caption || pretty(name)];
      try {
        execFileSync(process.execPath, [CLI, ...args], {
          env: { ...process.env, BASE, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}` },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30 * 60 * 1000,
        });
        renameSync(p, join(DONE, name));
        if (existsSync(sidecar)) renameSync(sidecar, join(DONE, basename(sidecar)));
        rmSync(join(DROP, name + '.upload-error.txt'), { force: true });
        log(`uploaded as draft: ${name}`);
      } catch (e) {
        attempted[key] = new Date().toISOString();
        const detail = [e.stdout, e.stderr].map((b) => (b ? String(b) : '')).join('\n').slice(-1500);
        writeFileSync(join(DROP, name + '.upload-error.txt'),
          `Upload failed ${new Date().toISOString()}\nFix the cause (or re-export the file) and it will retry when the file changes.\n\n${detail}\n`);
        log(`FAILED: ${name} — ${String(e.message).slice(0, 200)}`);
      }
    }
    writeFileSync(STATE, JSON.stringify(attempted, null, 1));
  }
} finally {
  rmSync(LOCK, { force: true });
}
