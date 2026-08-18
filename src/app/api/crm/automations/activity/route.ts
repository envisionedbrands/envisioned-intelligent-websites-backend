/**
 * GET /api/crm/automations/activity — one merged timeline of everything the DM
 * layer has seen.
 *
 * The point of this route is a specific failure it makes impossible. Four
 * separate tables have to be read in order to answer "did my message arrive and
 * what happened to it":
 *
 *   meta_webhook_events  Instagram called us               (incl. `unmatched`)
 *   dm_messages          a message was recorded, in or out
 *   dm_funnel_runs       a conversation changed state
 *
 * Read separately, a gap in any one of them looks like a gap in all of them —
 * which is exactly how "Meta isn't delivering" and "we dropped it on the floor"
 * became indistinguishable. Merged into a single time-ordered list, the two
 * failures look completely different: the first has no rows at all, the second
 * has a webhook row with nothing after it.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const t = (c: ReturnType<typeof createAdminClient>) => c as any;

type Item = {
  at: string;
  kind: "webhook" | "inbound" | "outbound" | "run";
  label: string;
  detail: string | null;
  ok: boolean;
};

/**
 * Why a delivery matched no handler.
 *
 * Instagram sends far more than messages down the same webhook: every time you
 * open the thread it reports a read receipt, every reaction and every reply we
 * send comes back as an echo. All of them legitimately match no funnel.
 *
 * While the funnel was broken those rows were the only evidence Meta was
 * calling at all, so they were surfaced loudly. Now that it works they are
 * noise wearing a warning colour — a row saying "nothing matched" reads like a
 * fault every time you read your own DMs. So they are classified here, at read
 * time rather than at write time: that way the explanation also applies to the
 * rows already stored, and no existing data has to be rewritten to get it.
 *
 * `null` means genuinely unexplained — the only case still worth flagging.
 */
function explainMiss(payload: unknown): string | null {
  const entries = (payload as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return null;

  for (const entry of entries) {
    for (const m of (entry as { messaging?: unknown[] })?.messaging ?? []) {
      const e = m as {
        read?: unknown;
        delivery?: unknown;
        reaction?: unknown;
        message?: { is_echo?: boolean; is_deleted?: boolean; text?: string; attachments?: unknown[] };
      };
      if (e.read) return "They opened the conversation — Instagram tells us when a message is read.";
      if (e.delivery) return "Instagram confirming one of our replies was delivered.";
      if (e.reaction) return "Someone reacted to a message with an emoji.";
      if (e.message?.is_echo) return "An echo of a reply we sent. Answering it is how a bot talks to itself.";
      if (e.message?.is_deleted) return "A message was unsent.";
      if (e.message && !e.message.text) return "A message with no text — a photo, voice note, or sticker.";
    }
  }
  return null;
}

export async function GET(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const limit = Math.min(Number(request.nextUrl.searchParams.get("limit")) || 60, 200);
  // Housekeeping traffic is hidden by default. `?verbose=1` puts it back, which
  // is what you want when the funnel has gone quiet and you need to know
  // whether Instagram is calling at all.
  const verbose = request.nextUrl.searchParams.get("verbose") === "1";
  const supabase = createAdminClient();

  const [events, messages, runs, subs] = await Promise.all([
    t(supabase)
      .from("meta_webhook_events")
      .select("received_at, object_type, event_key, payload")
      .order("received_at", { ascending: false })
      .limit(limit),
    t(supabase)
      .from("dm_messages")
      .select("created_at, direction, body, simulated, error, subscriber_id")
      .order("created_at", { ascending: false })
      .limit(limit),
    t(supabase)
      .from("dm_funnel_runs")
      .select("created_at, updated_at, state, trigger_source, last_error, subscriber_id")
      .order("updated_at", { ascending: false })
      .limit(limit),
    t(supabase).from("dm_subscribers").select("id, igsid, username"),
  ]);

  const who = new Map<string, string>();
  for (const s of subs.data || []) {
    who.set(s.id, s.username ? `@${s.username}` : s.igsid);
  }

  const items: Item[] = [];

  for (const e of events.data || []) {
    if (e.object_type !== "unmatched") {
      items.push({
        at: e.received_at,
        kind: "webhook",
        label: `Instagram sent a ${e.object_type}`,
        detail: null,
        ok: true,
      });
      continue;
    }

    const explained = explainMiss(e.payload);
    // Explained housekeeping is ordinary background chatter, not a fault. It
    // stays out of the feed unless asked for.
    if (explained && !verbose) continue;

    items.push({
      at: e.received_at,
      kind: "webhook",
      label: explained ? "Instagram housekeeping — nothing to do" : "Instagram called — we ignored it",
      detail:
        explained ??
        "Delivered and signature-verified, but nothing handled it and we can't tell why. Worth a look if a funnel has gone quiet.",
      ok: Boolean(explained),
    });
  }

  for (const m of messages.data || []) {
    items.push({
      at: m.created_at,
      kind: m.direction === "inbound" ? "inbound" : "outbound",
      label:
        m.direction === "inbound"
          ? `${who.get(m.subscriber_id) || "someone"} said "${m.body}"`
          : m.simulated
            ? "Reply written but NOT sent (safe mode)"
            : `Replied to ${who.get(m.subscriber_id) || "them"}`,
      detail: m.direction === "outbound" ? m.body : null,
      ok: !m.error,
    });
  }

  for (const r of runs.data || []) {
    items.push({
      at: r.updated_at || r.created_at,
      kind: "run",
      label: `Conversation with ${who.get(r.subscriber_id) || "someone"} → ${r.state}`,
      detail: r.last_error || `started from a ${r.trigger_source}`,
      ok: r.state !== "failed" && !r.last_error,
    });
  }

  items.sort((a, b) => (a.at < b.at ? 1 : -1));

  return NextResponse.json({ items: items.slice(0, limit) });
}
