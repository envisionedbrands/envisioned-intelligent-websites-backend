#!/usr/bin/env node
/**
 * studio-ingest.mjs — paste a URL into the Content Studio from the terminal.
 *
 *   node --env-file=.env.local scripts/studio-ingest.mjs <url> [--kind own|competitor|inspiration]
 *        [--notes "..."] [--wait]
 *
 * Creates the source + ingest job via the backend machine API. With --wait it
 * polls until the runner finishes and prints the transcript/analysis summary.
 * (The runner itself is scripts/studio-runner.mjs — launchd runs it every
 * 5 minutes, or run it by hand in a second terminal for an instant pass.)
 */
const BACKEND_URL = process.env.STUDIO_BACKEND_URL || "http://localhost:3000";
const API_KEY = process.env.API_SECRET_KEY;

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--"));
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const wait = args.includes("--wait");

if (!url || !API_KEY) {
  console.error('Usage: node --env-file=.env.local scripts/studio-ingest.mjs <url> [--kind competitor] [--notes "..."] [--wait]');
  process.exit(1);
}

async function api(path, method = "GET", body) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${json.error || "?"}`);
  return json;
}

const { source, job, queued } = await api("/api/studio/ingest", "POST", {
  url,
  kind: flag("kind"),
  notes: flag("notes"),
});
console.log(`source ${source.id.slice(0, 8)} [${source.platform}/${source.kind}] ${queued ? "queued" : "already in flight"} (job ${job.id.slice(0, 8)})`);

if (!wait) process.exit(0);

process.stdout.write("waiting for the runner");
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const { sources } = await api(`/api/studio/ingest?id=${source.id}`);
  const s = sources?.[0];
  if (!s) continue;
  if (s.status === "ready") {
    console.log("\n— READY —");
    console.log(`title:    ${s.title}`);
    console.log(`author:   ${s.author ?? "-"}`);
    console.log(`views:    ${s.engagement?.views ?? "-"}  likes: ${s.engagement?.likes ?? "-"}`);
    if (s.analysis) {
      console.log(`hook:     ${s.analysis.hook ?? "-"}`);
      console.log(`format:   ${s.analysis.format ?? "-"}  tone: ${s.analysis.tone ?? "-"}`);
      console.log(`beats:    ${(s.analysis.structure_beats || []).join(" → ")}`);
      console.log(`why:      ${s.analysis.why_it_worked ?? "-"}`);
    }
    process.exit(0);
  }
  if (s.status === "failed") {
    console.log("\n— FAILED — check studio_ingest_jobs.error");
    process.exit(1);
  }
  process.stdout.write(".");
}
console.log("\ntimed out waiting (runner may not be running — start it: node --env-file=.env.local scripts/studio-runner.mjs)");
