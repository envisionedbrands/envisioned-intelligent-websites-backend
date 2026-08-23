/**
 * Seed the two Interview App nurture workflows into the CRM.
 *
 * Usage:
 *   node scripts/seed-interview-app-workflows.mjs
 *
 * Requires: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local
 *
 * Workflow 1: "Interview App — Didn't Use" (nudge)
 *   Trigger: tag_added → "interview-app-signup"
 *   Logic: the tag is added at signup. If the lead later completes a session,
 *          they get the "used-free-trial" tag which enrolls them in Workflow 2.
 *
 * Workflow 2: "Interview App — Used Free Trial" (conversion)
 *   Trigger: tag_added → "used-free-trial"
 *   Logic: fired when the Interview App backend tags a lead after their first
 *          session. Day 3 email includes self-identifier buttons that hit the
 *          /api/crm/leads/tag-click endpoint.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env.local
const envPath = resolve(__dirname, "..", ".env.local");
try {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
} catch {
  console.error("Could not read .env.local — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY manually");
}

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey);

// ── Backend base URL for tag-click links ──────────────────────────────────────
// The tag-click endpoint lives on the backend, not the frontend.
// In emails, {{email}} is replaced by the CRM merge-tag engine at send time.

const BACKEND_BASE = process.env.DIGITAL_HOME_BACKEND_URL || "https://backend.envisioned.me";

function tagClickUrl(tag, redirectUrl) {
  // {{email}} is a CRM merge tag — rendered at send time by renderMergeTags()
  return `${BACKEND_BASE}/api/crm/leads/tag-click?email={{email}}&tag=${encodeURIComponent(tag)}&redirect=${encodeURIComponent(redirectUrl)}`;
}

// ── Email content ─────────────────────────────────────────────────────────────

const NUDGE_EMAIL_1_SUBJECT = "The hardest part is pressing record";
const NUDGE_EMAIL_1_BODY = `Hi {{first_name|there}},

I noticed you signed up but haven't recorded your free video yet.

The hardest part is pressing record — after that, the system does the rest.

You get one free video. No card, no pitch, no sales call. Just a 90-second recording and a finished video that looks like you hired a team.

[Record your free video →](https://interview.envisioned.me/app)

— Maria-Ines`;

const NUDGE_EMAIL_2_SUBJECT = "90 seconds of your real voice";
const NUDGE_EMAIL_2_BODY = `Hi {{first_name|there}},

Your first video doesn't need to be perfect. It needs to be 90 seconds of you saying something you actually believe.

The system handles the rest — structure, editing, branding, format. You handle the one thing no system can fake: your voice.

[Record your free video →](https://interview.envisioned.me/app)

— Maria-Ines`;

const CONVERSION_EMAIL_1_SUBJECT = "How was your first one?";
const CONVERSION_EMAIL_1_BODY = `Hi {{first_name|there}},

You just recorded your first video. I'd genuinely love to know — how did it feel?

Most people are surprised. Not by the quality (though that tends to land), but by how little effort it took to say something real.

That's the point. The system isn't here to make you perform. It's here to make your actual thinking visible.

Just reply to this email if you want to tell me. I read every one.

— Maria-Ines`;

const CONVERSION_EMAIL_2_SUBJECT = "What's your AI level?";
const CONVERSION_EMAIL_2_BODY = `Hi {{first_name|there}},

Now that you've tried it, I'm curious — where are you with AI in your business?

Not a quiz. Not a funnel. I just want to send you the right thing next.

Pick the one that fits:

[I use AI — it helps, but I'm driving →](${tagClickUrl("ai-level-1", "https://interview.envisioned.me/resources/level-1")})

[I'm on Cowork — AI is my working partner →](${tagClickUrl("ai-level-2", "https://interview.envisioned.me/resources/level-2")})

[I live in the Code — I build with AI daily →](${tagClickUrl("ai-level-3", "https://interview.envisioned.me/resources/level-3")})

Each one leads to a short resource page matched to where you are.

— Maria-Ines`;

const CONVERSION_EMAIL_3_SUBJECT = "What would 30 videos a month do for you?";
const CONVERSION_EMAIL_3_BODY = `Hi {{first_name|there}},

You've seen what one video feels like. Now imagine 30 a month.

Not 30 performances. Not 30 production days. 30 moments where you said something true, and the system turned it into content that looks like you have a team behind you.

That's what the full Interview App does. Same process you already tried — just without the one-video limit.

[See the plans →](https://interview.envisioned.me/)

— Maria-Ines`;

// ── Workflow definitions ──────────────────────────────────────────────────────

const workflow1 = {
  name: "Interview App — Didn't Use (nudge)",
  description:
    "Nudge sequence for Interview App signups who haven't recorded their free video. " +
    "Triggered when a lead gets the 'interview-app-signup' tag. " +
    "Day 1: 'The hardest part is pressing record'. Day 3: '90 seconds of your real voice'.",
  trigger_type: "tag_added",
  trigger_config: { tag: "interview-app-signup" },
  allow_reenrollment: false,
  steps: [
    {
      id: randomUUID(),
      type: "wait",
      config: { days: 1 },
    },
    {
      id: randomUUID(),
      type: "send_email",
      config: {
        subject: NUDGE_EMAIL_1_SUBJECT,
        body_md: NUDGE_EMAIL_1_BODY,
        preheader: "You signed up. The system is ready. Just press record.",
      },
    },
    {
      id: randomUUID(),
      type: "wait",
      config: { days: 2 },
    },
    {
      id: randomUUID(),
      type: "send_email",
      config: {
        subject: NUDGE_EMAIL_2_SUBJECT,
        body_md: NUDGE_EMAIL_2_BODY,
        preheader: "Your first video doesn't need to be perfect.",
      },
    },
  ],
  status: "active",
};

const workflow2 = {
  name: "Interview App — Used Free Trial (conversion)",
  description:
    "Conversion sequence for Interview App users who completed their first session. " +
    "Triggered when a lead gets the 'used-free-trial' tag. " +
    "Day 1: 'How was your first one?'. Day 3: 'What's your AI level?' with self-identifier buttons. " +
    "Day 7: 'What would 30 videos a month do for you?' — pricing push.",
  trigger_type: "tag_added",
  trigger_config: { tag: "used-free-trial" },
  allow_reenrollment: false,
  steps: [
    {
      id: randomUUID(),
      type: "wait",
      config: { days: 1 },
    },
    {
      id: randomUUID(),
      type: "send_email",
      config: {
        subject: CONVERSION_EMAIL_1_SUBJECT,
        body_md: CONVERSION_EMAIL_1_BODY,
        preheader: "You just recorded your first video.",
      },
    },
    {
      id: randomUUID(),
      type: "wait",
      config: { days: 2 },
    },
    {
      id: randomUUID(),
      type: "send_email",
      config: {
        subject: CONVERSION_EMAIL_2_SUBJECT,
        body_md: CONVERSION_EMAIL_2_BODY,
        preheader: "Not a quiz. Just want to send you the right thing next.",
      },
    },
    {
      id: randomUUID(),
      type: "wait",
      config: { days: 4 },
    },
    {
      id: randomUUID(),
      type: "send_email",
      config: {
        subject: CONVERSION_EMAIL_3_SUBJECT,
        body_md: CONVERSION_EMAIL_3_BODY,
        preheader: "You've seen what one video feels like.",
      },
    },
  ],
  status: "active",
};

// ── Seed ──────────────────────────────────────────────────────────────────────

async function seed() {
  console.log("Seeding Interview App nurture workflows...\n");

  for (const wf of [workflow1, workflow2]) {
    // Check if workflow already exists by name
    const { data: existing } = await supabase
      .from("workflows")
      .select("id, name, status")
      .eq("name", wf.name)
      .maybeSingle();

    if (existing) {
      console.log(`  Already exists: "${wf.name}" (id: ${existing.id}, status: ${existing.status}) — skipping`);
      continue;
    }

    const { data, error } = await supabase
      .from("workflows")
      .insert(wf)
      .select("id, name, status")
      .single();

    if (error) {
      console.error(`  Failed to create "${wf.name}":`, error.message);
      continue;
    }

    console.log(`  Created "${data.name}" (id: ${data.id}, status: ${data.status})`);
  }

  // Register the self-identifier tags in the tag registry
  console.log("\nRegistering tags...\n");
  const tags = [
    { name: "interview-app-signup", color: "#6366f1" },
    { name: "used-free-trial", color: "#22c55e" },
    { name: "ai-level-1", color: "#22c55e" },
    { name: "ai-level-2", color: "#eab308" },
    { name: "ai-level-3", color: "#ef4444" },
  ];

  for (const tag of tags) {
    const { error } = await supabase
      .from("crm_tags")
      .upsert(tag, { onConflict: "name" });
    if (error) {
      console.error(`  Tag "${tag.name}": ${error.message}`);
    } else {
      console.log(`  Tag "${tag.name}" registered`);
    }
  }

  console.log("\n── Done ─────────────────────────────────────────────────────");
  console.log("");
  console.log("Both workflows are ACTIVE and will fire on tag_added triggers.");
  console.log("");
  console.log("Integration contract:");
  console.log("  1. Interview App signup → add tag 'interview-app-signup' to the lead");
  console.log("  2. First session complete → add tag 'used-free-trial' to the lead");
  console.log("  3. Self-identifier clicks (Day 3 conversion email) hit:");
  console.log(`     GET ${BACKEND_BASE}/api/crm/leads/tag-click?email=<email>&tag=ai-level-<N>&redirect=<url>`);
  console.log("");
  console.log("The tag-click endpoint is public (no auth), validates email exists + tag allowed,");
  console.log("logs activity, fires tag_added trigger, and 302-redirects the browser.");
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
