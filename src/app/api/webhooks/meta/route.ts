/**
 * Meta webhook — Instagram comments and direct messages.
 *
 * Configure at developers.facebook.com → your app → Webhooks → Instagram:
 *   Callback URL:  https://app.envisioned.me/api/webhooks/meta
 *   Verify token:  the value of META_WEBHOOK_VERIFY_TOKEN
 *   Fields:        messages, comments
 * Then subscribe the Page under Instagram → Configuration.
 *
 * Three secrets, doing different jobs:
 *   META_WEBHOOK_VERIFY_TOKEN — a string you invent; Meta echoes it back once,
 *     on the GET handshake, to prove you own the endpoint.
 *   META_APP_SECRET — the *Facebook* app secret, used for OAuth code exchange.
 *   META_IG_APP_SECRET — the *Instagram* app secret, shown on Use cases →
 *     Instagram API → API setup with Instagram login. Meta's Instagram product
 *     mints its own credential pair, and signs Instagram-object webhooks with
 *     that one. Verifying only against META_APP_SECRET rejects every real
 *     delivery with a 401 that looks, from the tables, exactly like silence.
 *     Both are accepted below because which one signs depends on how the
 *     subscription was created, and guessing here costs a day.
 *
 * ALWAYS RETURNS 200. Meta retries anything else, and a retry storm against a
 * funnel that is half-working sends people duplicate DMs. Failures are recorded
 * and swallowed; the dedupe table is what makes that safe.
 */
import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { createAdminClient } from "@/lib/supabase/server";
import { handleComment, handleMessage } from "@/lib/social/dm-funnel";

function signedWith(secret: string, body: string, header: string): boolean {
  try {
    const signature = header.startsWith("sha256=") ? header.slice(7) : header;
    const expected = createHmac("sha256", secret).update(body).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(signature.trim().toLowerCase());
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * True if the payload was signed by either app credential. Still a real check —
 * both secrets are ours, and an attacker holding one has already won.
 */
function verifySignature(body: string, header: string): string | null {
  if (!header) return null;
  const candidates: Array<[string, string | undefined]> = [
    ["facebook", process.env.META_APP_SECRET],
    ["instagram", process.env.META_IG_APP_SECRET],
  ];
  for (const [name, secret] of candidates) {
    if (secret && signedWith(secret, body, header)) return name;
  }
  return null;
}

/** GET — the one-time subscription handshake. */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;

  if (
    params.get("hub.mode") === "subscribe" &&
    verifyToken &&
    params.get("hub.verify_token") === verifyToken
  ) {
    // Must be the bare challenge string, not JSON — Meta string-compares it.
    return new NextResponse(params.get("hub.challenge") ?? "", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }
  return new NextResponse("Forbidden", { status: 403 });
}

interface MetaEntry {
  id?: string;
  time?: number;
  messaging?: Array<{
    sender?: { id?: string };
    recipient?: { id?: string };
    timestamp?: number;
    message?: {
      mid?: string;
      text?: string;
      is_echo?: boolean;
      is_deleted?: boolean;
      attachments?: unknown[];
    };
  }>;
  changes?: Array<{
    field?: string;
    value?: {
      id?: string;
      text?: string;
      media?: { id?: string };
      from?: { id?: string; username?: string };
      parent_id?: string;
    };
  }>;
}

export async function POST(request: NextRequest) {
  const body = await request.text();

  if (!process.env.META_APP_SECRET && !process.env.META_IG_APP_SECRET) {
    console.error("meta webhook: no app secret configured");
    return NextResponse.json({ ok: true, skipped: "not configured" });
  }

  const header = request.headers.get("x-hub-signature-256") || "";
  const signer = verifySignature(body, header);
  if (!signer) {
    // The one case worth refusing outright — an unsigned payload is not Meta.
    // Name which secrets were even available, so a 401 caused by a *missing*
    // secret is never mistaken for one caused by a forged payload.
    console.error("meta webhook: signature rejected", {
      hasHeader: Boolean(header),
      bytes: body.length,
      tried: [
        process.env.META_APP_SECRET && "facebook",
        process.env.META_IG_APP_SECRET && "instagram",
      ].filter(Boolean),
    });
    return new NextResponse("Invalid signature", { status: 401 });
  }

  let payload: { object?: string; entry?: MetaEntry[] };
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ ok: true, skipped: "invalid json" });
  }

  // Shape log. A delivery that matches no branch below is indistinguishable from
  // no delivery at all when you are only reading tables, which is exactly the
  // failure that cost a day here. One line per POST, no payload contents.
  console.log(
    "meta webhook in:",
    JSON.stringify({
      signer,
      object: payload.object,
      entries: (payload.entry ?? []).map((e) => ({
        messaging: e.messaging?.length ?? 0,
        changes: e.changes?.map((c) => c.field) ?? [],
      })),
    })
  );

  const supabase = createAdminClient();
  const results: unknown[] = [];

  /**
   * Claims an event id, returning false if it has been seen. The primary-key
   * conflict IS the lock — no read-then-write race, which matters because Meta
   * happily delivers the same event to two invocations at once.
   */
  async function claim(key: string, objectType: string, data: unknown): Promise<boolean> {
    const { error } = await supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from("meta_webhook_events" as any)
      .insert({ event_key: key, object_type: objectType, payload: data as never });
    return !error;
  }

  try {
    for (const entry of payload.entry ?? []) {
      // Real Instagram DMs arrive as entry[].messaging[]. Meta's own "Test"
      // button in the dashboard instead sends entry[].changes[] with
      // field="messages" and the same object under `value`. Folding the second
      // into the first costs four lines and makes that button a usable
      // diagnostic — otherwise it reports "delivered" while we drop it.
      const messaging = [
        ...(entry.messaging ?? []),
        ...(entry.changes ?? [])
          .filter((c) => c.field === "messages")
          .map((c) => c.value as unknown as NonNullable<MetaEntry["messaging"]>[number]),
      ];

      // ── Direct messages ──────────────────────────────────────────────────
      for (const m of messaging) {
        const msg = m.message;
        // Echoes are our own outbound messages coming back. Answering them is
        // how a bot ends up talking to itself.
        if (!msg || msg.is_echo || msg.is_deleted) continue;
        const text = msg.text?.trim();
        const senderId = m.sender?.id;
        if (!text || !senderId) continue;
        if (senderId === entry.id) continue; // the account itself

        if (!(await claim(msg.mid ?? `msg:${senderId}:${m.timestamp}`, "message", m))) {
          results.push({ skipped: "duplicate", mid: msg.mid });
          continue;
        }

        try {
          results.push(await handleMessage(supabase, { igsid: senderId, text, messageId: msg.mid }));
        } catch (e) {
          console.error("meta webhook message:", e);
          results.push({ error: e instanceof Error ? e.message : "message failed" });
        }
      }

      // ── Comments ─────────────────────────────────────────────────────────
      for (const change of entry.changes ?? []) {
        if (change.field !== "comments") continue;
        const v = change.value;
        const commentId = v?.id;
        const text = v?.text?.trim();
        if (!commentId || !text || !v?.from?.id) continue;

        if (!(await claim(`comment:${commentId}`, "comment", change))) {
          results.push({ skipped: "duplicate", comment: commentId });
          continue;
        }

        try {
          results.push(
            await handleComment(supabase, {
              commentId,
              mediaId: v.media?.id ?? null,
              text,
              fromId: v.from.id,
              username: v.from.username,
            })
          );
        } catch (e) {
          console.error("meta webhook comment:", e);
          results.push({ error: e instanceof Error ? e.message : "comment failed" });
        }
      }
    }
  } catch (e) {
    console.error("meta webhook:", e);
  }

  if (!results.length) console.warn("meta webhook: delivery matched no handler");

  return NextResponse.json({ ok: true, results });
}
