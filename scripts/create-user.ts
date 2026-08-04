/**
 * Create (or re-role) a dashboard user in Supabase Auth.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/create-user.ts <password> <email> [role]
 *
 * role: 'admin' (default — full dashboard) or 'social' (social media manager —
 * /social only; middleware + API auth enforce the boundary).
 *
 * If the email already exists, the script updates its role instead of failing,
 * so promoting/demoting an account is the same command.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  console.error("Run with: npx tsx --env-file=.env.local scripts/create-user.ts <password> <email> [role]");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PASSWORD = process.argv[2];
const EMAIL = process.argv[3] || "admin@yourdomain.com";
const ROLE = (process.argv[4] || "admin").toLowerCase();

if (!PASSWORD) {
  console.error("Usage: npx tsx --env-file=.env.local scripts/create-user.ts <password> <email> [admin|social]");
  process.exit(1);
}
if (!["admin", "social"].includes(ROLE)) {
  console.error(`Unknown role '${ROLE}' — use 'admin' or 'social'`);
  process.exit(1);
}

async function main() {
  const { data, error } = await supabase.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: { role: ROLE },
  });

  if (!error) {
    console.log(`User created: ${data.user.email} (${data.user.id}) — role: ${ROLE}`);
    return;
  }

  if (!/already.*(registered|exists)/i.test(error.message)) {
    console.error("Failed to create user:", error.message);
    process.exit(1);
  }

  // Existing account — update its role (and password) instead.
  const { data: list, error: listError } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  const existing = list?.users.find((u) => u.email?.toLowerCase() === EMAIL.toLowerCase());
  if (listError || !existing) {
    console.error("User exists but could not be found to update:", listError?.message || EMAIL);
    process.exit(1);
  }
  const { error: updateError } = await supabase.auth.admin.updateUserById(existing.id, {
    password: PASSWORD,
    app_metadata: { role: ROLE },
  });
  if (updateError) {
    console.error("Failed to update user:", updateError.message);
    process.exit(1);
  }
  console.log(`User updated: ${EMAIL} (${existing.id}) — role: ${ROLE}`);
}

main();
