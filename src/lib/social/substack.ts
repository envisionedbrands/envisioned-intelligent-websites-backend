/**
 * Substack Notes — post, read back, and measure.
 *
 * Substack has no official API. Everything here uses the endpoints Substack's
 * own web app calls, authenticated by the owner's `substack.sid` session
 * cookie. Probed and verified from a Cloudflare Worker on 2026-10-04:
 *
 *  - Requests MUST carry a browser User-Agent. Without one Substack answers
 *    429 to every call, from a Worker or anywhere else.
 *  - The cookie is a full login to her account. It lives in the Worker secret
 *    SUBSTACK_SID only — never in social_accounts (tokens there are plain text).
 *  - Posting a Note is NOT idempotent. A lost response would make a retry post
 *    twice, so every retry first looks for the same text on her profile
 *    (findPostedNote) and adopts it instead of posting again.
 *  - Note ids are stored in Substack's own prefixed form, "c-<commentId>":
 *    unambiguous next to IG/FB/YT ids under the one external_id unique index,
 *    and exactly what the stats and permalink URLs take.
 *  - Per-Note stats come from `note_stats/c-<id>`, the payload behind
 *    Substack's own Note stats screen, including new free/paid subscribers.
 *    Young Notes (a few hours) only return likes/restacks/replies.
 */
import type { MetricSnapshot } from "./types";

const API = "https://substack.com/api/v1";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

/** The session is missing, expired or revoked: only the owner can fix it. */
export class SubstackAuthError extends Error {}

export function substackConfigured(): boolean {
  return Boolean(process.env.SUBSTACK_SID?.trim());
}

function sid(): string {
  const value = process.env.SUBSTACK_SID?.trim();
  if (!value) throw new SubstackAuthError("SUBSTACK_SID is not set on the Worker");
  // Accept either the bare value or a pasted "substack.sid=…" pair.
  return value.replace(/^substack\.sid=/, "");
}

async function sbFetch(url: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const res = await fetch(url, {
    method: init.method || "GET",
    headers: {
      Cookie: `substack.sid=${sid()}`,
      "User-Agent": BROWSER_UA,
      Accept: "application/json",
      ...(init.body !== undefined
        ? { "Content-Type": "application/json", Origin: "https://substack.com", Referer: "https://substack.com/" }
        : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new SubstackAuthError(`Substack refused the login (HTTP ${res.status}) — reconnect Substack`);
  }
  if (!res.ok) {
    throw new Error(`Substack ${res.status} on ${new URL(url).pathname}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Substack returned non-JSON on ${new URL(url).pathname}`);
  }
}

// ── profile ──────────────────────────────────────────────────────────────────

export interface SubstackProfile {
  userId: number;
  handle: string;
  name: string;
  publication: { id: number; subdomain: string; name: string } | null;
}

/** Who the session belongs to. Also the cheapest "is the login still good" check. */
export async function substackProfileSelf(): Promise<SubstackProfile> {
  const p = (await sbFetch(`${API}/user/profile/self`)) as {
    id: number;
    handle: string;
    name: string;
    primaryPublication?: { id: number; subdomain: string; name: string } | null;
  };
  const pub = p.primaryPublication;
  return {
    userId: p.id,
    handle: p.handle,
    name: p.name,
    publication: pub ? { id: pub.id, subdomain: pub.subdomain, name: pub.name } : null,
  };
}

/** "352843879" or "c-352843879" → "c-352843879". */
export function noteExternalId(id: string | number): string {
  const s = String(id);
  return s.startsWith("c-") ? s : `c-${s}`;
}

export function noteUrl(handle: string | null | undefined, externalId: string): string {
  const id = noteExternalId(externalId);
  return handle ? `https://substack.com/@${handle}/note/${id}` : `https://substack.com/note/${id}`;
}

// ── Markdown → ProseMirror ───────────────────────────────────────────────────

type PMText = { type: "text"; text: string; marks?: Array<{ type: string; attrs?: Record<string, string> }> };
type PMNode = PMText | { type: "hard_break" };

const INLINE = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|_[^_\n]+_|https?:\/\/[^\s)]+)/g;

function inline(line: string): PMNode[] {
  const out: PMNode[] = [];
  let last = 0;
  for (const m of line.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ type: "text", text: line.slice(last, idx) });
    const tok = m[0];
    if (tok.startsWith("**")) out.push({ type: "text", text: tok.slice(2, -2), marks: [{ type: "strong" }] });
    else if (tok.startsWith("http")) {
      // Trailing punctuation belongs to the sentence, not the URL.
      const url = tok.replace(/[.,;:!?]+$/, "");
      out.push({ type: "text", text: url, marks: [{ type: "link", attrs: { href: url } }] });
      if (url.length < tok.length) out.push({ type: "text", text: tok.slice(url.length) });
    } else out.push({ type: "text", text: tok.slice(1, -1), marks: [{ type: "em" }] });
    last = idx + tok.length;
  }
  if (last < line.length) out.push({ type: "text", text: line.slice(last) });
  return out;
}

/** Blank lines split paragraphs; single newlines become hard breaks. */
export function markdownToDoc(markdown: string): Record<string, unknown> {
  const paragraphs = markdown
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    type: "doc",
    attrs: { schemaVersion: "v1" },
    content: paragraphs.map((p) => {
      const content: PMNode[] = [];
      p.split("\n").forEach((line, i) => {
        if (i > 0) content.push({ type: "hard_break" });
        content.push(...inline(line));
      });
      return { type: "paragraph", content };
    }),
  };
}

/** Comparison key for duplicate detection: text only, no markup, no spacing. */
export function normalizeNoteText(text: string): string {
  return text
    .replace(/\*\*|__|[*_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ── post + read back ─────────────────────────────────────────────────────────

/** Publish one Note now. Returns its external id ("c-<commentId>"). */
export async function postNote(markdown: string): Promise<{ id: string }> {
  const res = (await sbFetch(`${API}/comment/feed`, {
    method: "POST",
    body: {
      bodyJson: markdownToDoc(markdown),
      tabId: "for-you",
      surface: "feed",
      replyMinimumRole: "everyone",
    },
  })) as { id?: number | string; comment?: { id?: number | string } };
  const id = res.id ?? res.comment?.id;
  if (id === undefined || id === null) throw new Error("Substack accepted the Note but returned no id");
  return { id: noteExternalId(id) };
}

export interface OwnNote {
  id: string;
  body: string;
  date: string;
}

/** Her own top-level Notes, newest first (replies and restacks excluded). */
export async function listOwnNotes(userId: number | string, pages = 1): Promise<OwnNote[]> {
  const notes: OwnNote[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < pages; page++) {
    const url = new URL(`${API}/reader/feed/profile/${userId}`);
    url.searchParams.append("types[]", "note");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = (await sbFetch(url.toString())) as {
      items?: Array<{
        context?: { type?: string };
        comment?: { id: number; body?: string; date: string; user_id: number; ancestor_path?: string };
      }>;
      nextCursor?: string | null;
    };
    for (const item of res.items || []) {
      const c = item.comment;
      if (!c || item.context?.type !== "note") continue;
      if (String(c.user_id) !== String(userId) || c.ancestor_path) continue;
      notes.push({ id: noteExternalId(c.id), body: c.body || "", date: c.date });
    }
    cursor = res.nextCursor || null;
    if (!cursor) break;
  }
  return notes;
}

/**
 * Has this exact text already gone out since `sinceIso`? Used before every
 * retry so a timed-out-but-successful post is adopted, not posted twice.
 */
export async function findPostedNote(
  userId: number | string,
  markdown: string,
  sinceIso: string
): Promise<string | null> {
  const want = normalizeNoteText(markdown);
  const since = new Date(sinceIso).getTime() - 5 * 60 * 1000;
  const notes = await listOwnNotes(userId, 2);
  const hit = notes.find(
    (n) => new Date(n.date).getTime() >= since && normalizeNoteText(n.body) === want
  );
  return hit ? hit.id : null;
}

// ── stats ────────────────────────────────────────────────────────────────────

type Card = {
  type?: string;
  cardId?: string;
  headers?: Array<{ title?: string; value?: number }>;
  items?: Array<{ title?: string; value?: number }>;
  note?: { note?: { like_count?: number; restack_count?: number; reply_count?: number } };
};

const headerValue = (card: Card | undefined, title?: string): number => {
  if (!card?.headers?.length) return 0;
  const h = title ? card.headers.find((x) => x.title === title) : card.headers[0];
  return Number(h?.value) || 0;
};

const itemMap = (card: Card | undefined): Record<string, number> =>
  Object.fromEntries((card?.items || []).map((i) => [i.title || "?", Number(i.value) || 0]));

/**
 * One Note's numbers, normalised onto the shared snapshot shape:
 * views = impressions, reach = unique accounts reached, comments = replies,
 * shares = restacks + shares. Subscriber attribution and link clicks ride in
 * `raw` — subscriber *names* are deliberately not stored.
 */
export async function fetchNoteMetrics(externalId: string): Promise<MetricSnapshot> {
  const res = (await sbFetch(`${API}/note_stats/${noteExternalId(externalId)}`)) as {
    cards?: Card[];
    lastUpdatedAt?: string;
  };
  const cards = res.cards || [];
  const byId = (id: string) => cards.find((c) => c.cardId === id);
  const base = byId("note")?.note?.note || {};
  const interactions = itemMap(byId("interactions"));
  const audience = itemMap(byId("audience"));
  const surfaces = itemMap(byId("surfaces"));
  const newSubs = byId("new_subscribers");
  const restacks = Number(base.restack_count) || 0;

  return {
    views: headerValue(byId("impressions")),
    likes: Number(base.like_count) || interactions["Like"] || 0,
    comments: Number(base.reply_count) || 0,
    shares: restacks + headerValue(byId("shareValues")),
    saves: interactions["Save"] || 0,
    reach: Object.values(audience).reduce((a, b) => a + b, 0),
    raw: {
      source: "substack_note_stats",
      new_free_subscribers: headerValue(newSubs, "New free subs"),
      new_paid_subscribers: headerValue(newSubs, "New paid subs"),
      link_clicks: interactions["Link click"] || 0,
      restacks,
      interactions,
      audience,
      surfaces,
      cards: cards.map((c) => c.cardId || c.type || "?"),
      last_updated_at: res.lastUpdatedAt || null,
    },
  };
}
