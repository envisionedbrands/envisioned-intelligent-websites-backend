/**
 * GET    /api/crm/automations — every DM funnel, with its live counters
 * PATCH  /api/crm/automations — update one funnel (status, copy, gates)
 * DELETE /api/crm/automations — soft-delete (archive) a funnel
 *
 * The DM funnels were built before they had a screen, which meant the only way
 * to read the words the account says to a stranger — or to take one live — was
 * a database client. This route is what makes them ordinary CRM objects.
 *
 * `dm_funnels` is not in `src/types/database.ts` (it arrived in migration 30x
 * and the generated types have not been regenerated since), so the queries go
 * through an `any`-cast client the same way `lib/social/dm-funnel.ts` does.
 * Regenerating the types is the real fix; until then this stays consistent with
 * the runner rather than inventing a second pattern.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { keywordVariants } from "@/lib/social/messaging";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const t = (c: ReturnType<typeof createAdminClient>) => c as any;

/**
 * The only fields the screen may write. An allowlist rather than a spread of
 * the request body: `stat_*` are counters the runner owns, and `account_id`
 * decides which Instagram account speaks — neither should be settable by a
 * form post that happens to include them.
 */
const EDITABLE = [
  "name",
  "keyword",
  "status",
  "trigger_source",
  "public_comment_reply",
  "opening_dm",
  "welcome_dm",
  "follow_prompt_dm",
  "email_prompt_dm",
  "delivery_dm",
  "already_done_dm",
  "require_follow",
  "ask_email",
  "skip_email_if_known",
  "delivery_link",
  "delivery_card_title",
  "delivery_card_subtitle",
  "delivery_card_image",
  "delivery_button_label",
] as const;

/** Added by migration 303 — may not exist yet on a database mid-upgrade. */
const CARD_FIELDS = [
  "delivery_card_title",
  "delivery_card_subtitle",
  "delivery_card_image",
  "delivery_button_label",
] as const;

/** Meta's hard limits. Overrunning either is a 400 that costs a delivery. */
const CARD_LIMITS: Record<string, number> = {
  delivery_card_title: 80,
  delivery_card_subtitle: 80,
};

const STATUSES = ["draft", "active", "paused"];

export async function GET(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const supabase = createAdminClient();

  const includeArchived = request.nextUrl.searchParams.get("include_archived") === "1";

  let query = t(supabase)
    .from("dm_funnels")
    .select("*")
    .order("created_at", { ascending: false });
  if (!includeArchived) {
    query = query.neq("status", "archived");
  }
  const { data: funnels, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // In-flight runs per funnel — someone mid-conversation right now. This is the
  // number that tells you whether pausing a funnel will strand anyone.
  const { data: runs } = await t(supabase)
    .from("dm_funnel_runs")
    .select("funnel_id, state")
    .in("state", ["opened", "awaiting_follow", "awaiting_email"]);

  const inFlight = new Map<string, number>();
  for (const r of runs || []) {
    inFlight.set(r.funnel_id, (inFlight.get(r.funnel_id) || 0) + 1);
  }

  // Safe mode is reported alongside, because "active" on its own is misleading:
  // an active funnel under safe mode receives, branches and logs, but sends
  // nothing. That gap cost an evening of "why is nothing happening".
  const { data: safeRow } = await supabase
    .from("backend_settings")
    .select("value")
    .eq("key", "crm_safe_mode")
    .maybeSingle();

  const { data: account } = await t(supabase)
    .from("social_accounts")
    .select("username, status, dm_access_token, dm_token_expires_at")
    .eq("platform", "instagram")
    .maybeSingle();

  return NextResponse.json({
    funnels: (funnels || []).map((f: Record<string, unknown>) => ({
      ...f,
      in_flight: inFlight.get(f.id as string) || 0,
    })),
    safe_mode: safeRow?.value !== false,
    account: account
      ? {
          username: account.username,
          status: account.status,
          dms_connected: Boolean(account.dm_access_token),
          dm_token_expires_at: account.dm_token_expires_at,
        }
      : null,
  });
}

export async function PATCH(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const body = await request.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const patch: Record<string, unknown> = {};
  for (const key of EDITABLE) {
    if (key in body) patch[key] = body[key];
  }
  if (!Object.keys(patch).length) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  if (patch.status !== undefined && !STATUSES.includes(patch.status as string)) {
    return NextResponse.json({ error: `status must be one of ${STATUSES.join(", ")}` }, { status: 400 });
  }

  // A funnel is matched by keyword against inbound text, so an empty or
  // whitespace keyword would match nothing and quietly never fire. Reject it
  // here rather than let someone save a funnel that cannot possibly run.
  //
  // The field is a list, so it is normalised through the same parser the runner
  // uses: lowercased, de-duplicated, blanks dropped, stored back in a tidy form.
  // Saving "Behind, behind ,, BEHIND" should not create three variations that
  // are really one.
  if (patch.keyword !== undefined) {
    const variants = keywordVariants(String(patch.keyword));
    if (!variants.length) {
      return NextResponse.json({ error: "keyword cannot be empty" }, { status: 400 });
    }
    patch.keyword = variants.join(", ");
  }

  // Blank card fields are stored as NULL rather than "", because the runner
  // treats a missing title as "send the old plain text" and an empty string
  // would be a card with no headline — accepted by us, rejected by Meta.
  for (const key of CARD_FIELDS) {
    if (patch[key] === undefined) continue;
    const v = String(patch[key] ?? "").trim();
    if (!v) {
      patch[key] = null;
      continue;
    }
    const max = CARD_LIMITS[key];
    if (max && v.length > max) {
      return NextResponse.json(
        { error: `${key.replace(/_/g, " ")} must be ${max} characters or fewer — Instagram's limit` },
        { status: 400 }
      );
    }
    patch[key] = v;
  }

  const supabase = createAdminClient();

  const save = (p: Record<string, unknown>) =>
    t(supabase).from("dm_funnels").update(p).eq("id", id).select("*").single();

  let { data, error } = await save(patch);

  /**
   * Migration 303 adds the card columns. This route is deployed by pushing to
   * Cloudflare and the migration is run by hand in the SQL editor, so for a
   * window of minutes — or, for anyone else installing this backend, days —
   * the code knows about columns the database does not have.
   *
   * Postgres 42703 is "undefined column". Rather than make saving *any* reply
   * fail during that window, the card fields are dropped and the rest of the
   * edit goes through, with the reason returned so it shows up in the UI
   * instead of being swallowed.
   */
  if (error?.code === "42703" && CARD_FIELDS.some((k) => k in patch)) {
    const withoutCard = { ...patch };
    for (const k of CARD_FIELDS) delete withoutCard[k];
    if (Object.keys(withoutCard).length) {
      ({ data, error } = await save(withoutCard));
      if (!error) {
        return NextResponse.json({
          funnel: data,
          warning:
            "Saved — but the card fields were skipped. Run migration 303_dm_delivery_card.sql, then save again.",
        });
      }
    }
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ funnel: data });
}


export async function DELETE(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const body = await request.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const supabase = createAdminClient();

  // Verify the funnel exists and isn't already archived
  const { data: existing, error: lookupErr } = await t(supabase)
    .from("dm_funnels")
    .select("id, name, status")
    .eq("id", id)
    .maybeSingle();

  if (lookupErr) return NextResponse.json({ error: lookupErr.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: "Funnel not found" }, { status: 404 });
  if (existing.status === "archived") {
    return NextResponse.json({ error: "Already archived" }, { status: 400 });
  }

  // Soft-delete: set status to "archived". The funnel stays in the database
  // with all its stats and history intact, but is hidden from the GET list
  // and will not match any incoming keywords (the runner only queries active
  // funnels). This is reversible — a direct database update can restore it.
  const { error } = await t(supabase)
    .from("dm_funnels")
    .update({ status: "archived" })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ archived: true, id, name: existing.name });
}
