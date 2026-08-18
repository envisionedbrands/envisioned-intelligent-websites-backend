/**
 * Instagram / Facebook messaging client — the send half of the DM funnel layer.
 *
 * Separate from meta.ts (which owns *publishing*) because the two use different
 * permissions, different windows and different failure modes. Publishing is a
 * state machine over an upload; messaging is a conversation with a clock on it.
 *
 * The clocks, which drive every decision in here:
 *   * PRIVATE REPLY — one per comment, within 7 days of the comment. This is
 *     the only way to open a thread with someone who has never messaged you.
 *   * 24-HOUR WINDOW — free-form messages only within 24h of *their* last
 *     message. Outside it, an ordinary send fails. There is no automation
 *     escape hatch (HUMAN_AGENT is for a human answering an inquiry, 7 days).
 *
 * HOST: graph.instagram.com, not graph.facebook.com. This layer runs on
 * *Instagram Login*, while publishing (meta.ts) runs on *Facebook Login for
 * Business*. Same Instagram account, two different rails — see
 * lib/social/instagram-login.ts for why, and docs/dm-funnels.md §5 for the day
 * it cost to find out. The paths below (/{ig-id}/messages, /{comment}/replies)
 * happen to be identical on both hosts; the auth is not. The token used here
 * must be `social_accounts.dm_access_token`, never `access_token`.
 *
 * Required permissions: instagram_business_basic,
 * instagram_business_manage_messages, instagram_business_manage_comments.
 * All of these need Meta App Review — see docs/dm-funnels.md.
 */

const GRAPH = "https://graph.instagram.com/v23.0";

interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number; error_user_msg?: string };
}

/** Meta error codes worth handling rather than merely logging. */
export const META_ERRORS = {
  /** Outside the 24-hour window, or the person never messaged us. */
  OUTSIDE_WINDOW: 10,
  /** This comment already got its one private reply. */
  DUPLICATE_PRIVATE_REPLY: 100,
  RATE_LIMITED: 613,
} as const;

export class MetaSendError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly subcode?: number
  ) {
    super(message);
    this.name = "MetaSendError";
  }

  /** True when retrying is pointless — the window is shut or the reply is spent. */
  get isTerminal(): boolean {
    return (
      this.code === META_ERRORS.OUTSIDE_WINDOW ||
      this.code === META_ERRORS.DUPLICATE_PRIVATE_REPLY
    );
  }
}

async function graphPost<T>(path: string, token: string, body: unknown): Promise<T> {
  const res = await fetch(`${GRAPH}${path}?access_token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & GraphError;
  if (!res.ok || data.error) {
    const e = data.error;
    throw new MetaSendError(
      `Graph POST ${path}: ${e?.error_user_msg || e?.message || `HTTP ${res.status}`}`,
      e?.code,
      e?.error_subcode
    );
  }
  return data;
}

async function graphGet<T>(
  path: string,
  token: string,
  params: Record<string, string> = {}
): Promise<T> {
  const url = new URL(`${GRAPH}${path}`);
  url.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  const data = (await res.json().catch(() => ({}))) as T & GraphError;
  if (!res.ok || data.error) {
    const e = data.error;
    throw new MetaSendError(
      `Graph GET ${path}: ${e?.error_user_msg || e?.message || `HTTP ${res.status}`}`,
      e?.code,
      e?.error_subcode
    );
  }
  return data;
}

// ── Profile ─────────────────────────────────────────────────────────────────

export interface DmUserProfile {
  name?: string;
  username?: string;
  profile_pic?: string;
  follower_count?: number;
  /** THE follow gate. Whether this person follows the business account. */
  is_user_follow_business?: boolean;
  is_business_follow_user?: boolean;
}

/**
 * Looks up the person behind an Instagram-scoped ID. Only works for someone
 * already in a conversation with the account — which is the only time we ask.
 *
 * Fails soft: a profile lookup that errors must not sink the funnel run. We
 * would rather deliver the thing without knowing their follower count than
 * drop a lead over a metadata call.
 */
export async function getDmUserProfile(
  igsid: string,
  pageToken: string
): Promise<DmUserProfile | null> {
  try {
    return await graphGet<DmUserProfile>(`/${igsid}`, pageToken, {
      fields:
        "name,username,profile_pic,follower_count,is_user_follow_business,is_business_follow_user",
    });
  } catch {
    return null;
  }
}

// ── Sending ─────────────────────────────────────────────────────────────────

export interface SendResult {
  messageId?: string;
  recipientId?: string;
}

/**
 * A tappable chip under a message. `user_email` is the interesting one: rather
 * than asking someone to type their address, Instagram offers the address on
 * their profile as a single tap. Typing an email into a phone keyboard is the
 * largest drop-off in the whole funnel, and this removes it.
 *
 * Their tap arrives back as an ordinary `messages` webhook whose text is the
 * chosen value, with `quick_reply.payload` alongside — so it needs no extra
 * webhook subscription and no new permission.
 */
export interface QuickReply {
  /** `text` shows `title`; `user_email` / `user_phone_number` are prefilled. */
  content_type: "text" | "user_email" | "user_phone_number";
  /** Up to 20 characters. Instagram truncates anything longer. Text chips only. */
  title?: string;
  payload: string;
}

export const MAX_QUICK_REPLIES = 13;
export const QUICK_REPLY_TITLE_MAX = 20;

/**
 * Free-form DM. Requires an open 24-hour window — check before calling; this
 * throws MetaSendError with code 10 if the window has shut.
 */
export async function sendDm(
  igUserId: string,
  pageToken: string,
  recipientIgsid: string,
  text: string,
  quickReplies?: QuickReply[]
): Promise<SendResult> {
  const message: Record<string, unknown> = { text };
  if (quickReplies?.length) {
    message.quick_replies = quickReplies.slice(0, MAX_QUICK_REPLIES).map((q) => ({
      ...q,
      ...(q.title ? { title: q.title.slice(0, QUICK_REPLY_TITLE_MAX) } : {}),
    }));
  }
  const res = await graphPost<{ message_id?: string; recipient_id?: string }>(
    `/${igUserId}/messages`,
    pageToken,
    { recipient: { id: recipientIgsid }, message }
  );
  return { messageId: res.message_id, recipientId: res.recipient_id };
}

// ── Cards ───────────────────────────────────────────────────────────────────

/**
 * A link card: image, headline, and up to three tappable buttons.
 *
 * This exists because of how Instagram renders a plain text message containing
 * a URL. It draws the link preview — image, headline, domain — as a panel
 * ABOVE the text, and leaves the raw `https://…` in the text underneath. One
 * message, but it reads as the same link sent twice, and the second copy is a
 * naked URL sitting in the middle of the sentence.
 *
 * A generic template is the same panel with the URL moved into a button, so
 * the picture stays and the duplicate disappears. There is no way to suppress
 * the preview on a text message and no way to attach a button to one, which is
 * why this is a different call rather than a flag on `sendDm`.
 *
 * Limits are Meta's and are enforced here rather than trusted: 80 characters of
 * title, 80 of subtitle, 3 buttons, 10 cards. Overrunning any of them is a 400
 * that costs a delivery.
 */
export interface CardButton {
  type: "web_url" | "postback";
  title: string;
  /** web_url only. */
  url?: string;
  /** postback only — comes back as a `messaging_postbacks` webhook. */
  payload?: string;
}

export interface DmCard {
  title: string;
  subtitle?: string | null;
  image_url?: string | null;
  /** Tapping the card body itself. Usually the same URL as the button. */
  default_action_url?: string | null;
  buttons?: CardButton[];
}

export const CARD_TITLE_MAX = 80;
export const CARD_SUBTITLE_MAX = 80;
export const MAX_CARD_BUTTONS = 3;

/**
 * Renders a card the way it will read in a transcript. The DM transcript stores
 * text, and a row that said only "[card]" would make the activity feed useless
 * for the one job it has — showing what a stranger was actually told.
 */
export function describeCard(card: DmCard): string {
  const bits = [card.title];
  if (card.subtitle) bits.push(card.subtitle);
  for (const b of card.buttons ?? []) {
    bits.push(b.type === "web_url" ? `[${b.title} → ${b.url}]` : `[${b.title}]`);
  }
  return bits.join("\n");
}

export async function sendDmCard(
  igUserId: string,
  pageToken: string,
  recipientIgsid: string,
  cards: DmCard[]
): Promise<SendResult> {
  const elements = cards.slice(0, 10).map((c) => ({
    title: c.title.slice(0, CARD_TITLE_MAX),
    ...(c.subtitle ? { subtitle: c.subtitle.slice(0, CARD_SUBTITLE_MAX) } : {}),
    ...(c.image_url ? { image_url: c.image_url } : {}),
    ...(c.default_action_url
      ? { default_action: { type: "web_url", url: c.default_action_url } }
      : {}),
    ...(c.buttons?.length ? { buttons: c.buttons.slice(0, MAX_CARD_BUTTONS) } : {}),
  }));

  const res = await graphPost<{ message_id?: string; recipient_id?: string }>(
    `/${igUserId}/messages`,
    pageToken,
    {
      recipient: { id: recipientIgsid },
      message: {
        attachment: { type: "template", payload: { template_type: "generic", elements } },
      },
    }
  );
  return { messageId: res.message_id, recipientId: res.recipient_id };
}

/**
 * The comment→DM opener. Sends a private message to whoever left a comment,
 * addressing the *comment* rather than the person — which is what makes it
 * legal without them having messaged first.
 *
 * ONE per comment, ever. Meta rejects the second with code 100. Seven days
 * from the comment; Instagram Live is the exception (broadcast only).
 */
export async function sendPrivateReply(
  igUserId: string,
  pageToken: string,
  commentId: string,
  text: string
): Promise<SendResult> {
  const res = await graphPost<{ message_id?: string; recipient_id?: string }>(
    `/${igUserId}/messages`,
    pageToken,
    { recipient: { comment_id: commentId }, message: { text } }
  );
  return { messageId: res.message_id, recipientId: res.recipient_id };
}

/**
 * Public reply under their comment — the visible "check your DMs 💌" half.
 * Optional; a funnel with no public_comment_reply just skips it.
 */
export async function replyToComment(
  commentId: string,
  pageToken: string,
  text: string
): Promise<{ id?: string }> {
  return graphPost<{ id?: string }>(`/${commentId}/replies`, pageToken, { message: text });
}

// ── Windows ─────────────────────────────────────────────────────────────────

export const DM_WINDOW_MS = 24 * 60 * 60 * 1000;
export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Whether a free-form DM is currently allowed to this person. */
export function isWindowOpen(lastInboundAt: string | Date | null | undefined): boolean {
  if (!lastInboundAt) return false;
  const last = new Date(lastInboundAt).getTime();
  if (Number.isNaN(last)) return false;
  return Date.now() - last < DM_WINDOW_MS;
}

export function windowExpiresAt(lastInboundAt: string | Date): Date {
  return new Date(new Date(lastInboundAt).getTime() + DM_WINDOW_MS);
}

// ── Copy interpolation ──────────────────────────────────────────────────────

/**
 * {{first_name}} style tokens. Deliberately tiny — DM copy that needs a
 * template engine is copy that should be an email.
 *
 * Unknown tokens collapse to empty rather than rendering "{{whatever}}" at a
 * stranger, and a greeting left dangling by a missing name gets tidied.
 */
export function renderDmCopy(template: string, vars: Record<string, string | null | undefined>) {
  const filled = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    const v = vars[key];
    return v == null ? "" : String(v);
  });
  // "Hey ," → "Hey," and collapse the double spaces an empty token leaves.
  return filled
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// ── Inbound parsing ─────────────────────────────────────────────────────────

const EMAIL_RE = /[^\s<>()[\],;:@"]+@[^\s<>()[\],;:@"]+\.[a-z]{2,}/i;

/**
 * Pulls an email address out of whatever they typed. People send
 * "sure it's maria@example.com thanks!" far more often than a bare address.
 */
export function extractEmail(text: string): string | null {
  const match = text.match(EMAIL_RE);
  if (!match) return null;
  return match[0].replace(/[.,;:]+$/, "").toLowerCase();
}

// ── Keyword matching ────────────────────────────────────────────────────────

/**
 * A funnel's keyword field holds a comma-separated list, not one word. People
 * do not type the word on the poster: they capitalise it, pluralise it, wrap it
 * in emoji, and fat-finger it. Every one of those is a person who asked for the
 * thing and got silence.
 *
 * The FIRST entry is canonical — it is what gets written into lead sources,
 * tags and notes. The rest exist only to be matched, so adding variations never
 * changes how a lead is filed.
 */
export function keywordVariants(keyword: string): string[] {
  const seen = new Set<string>();
  for (const raw of (keyword || "").split(/[,\n]/)) {
    const v = raw.trim().toLowerCase();
    if (v) seen.add(v);
  }
  return [...seen];
}

/** The one to display and to file leads under. */
export function primaryKeyword(keyword: string): string {
  return keywordVariants(keyword)[0] || (keyword || "").trim().toLowerCase();
}

/**
 * True if `a` and `b` are one typo apart: one insertion, one deletion, one
 * substitution, or one swap of adjacent letters.
 *
 * The swap case is the reason this isn't plain Levenshtein. "behnid" for
 * "behind" is the single most common way a word gets mistyped, and by strict
 * edit distance it is 2 — far enough away to be rejected, close enough that any
 * human reading it knows what was meant.
 */
function oneTypoApart(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;

  if (la === lb) {
    let first = -1;
    for (let i = 0; i < la; i++) {
      if (a[i] === b[i]) continue;
      if (first === -1) {
        first = i;
        continue;
      }
      // A second difference is only forgivable as a swap of two adjacent
      // letters, with everything after it identical.
      return (
        first === i - 1 &&
        a[first] === b[i] &&
        a[i] === b[first] &&
        a.slice(i + 1) === b.slice(i + 1)
      );
    }
    return first !== -1; // exactly one substitution
  }

  // One letter added or dropped: walk both, allowing a single skip.
  const short = la < lb ? a : b;
  const long = la < lb ? b : a;
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    j++;
  }
  return true;
}

/**
 * Short words are not typo-corrected. At four letters or fewer the near-misses
 * are other real words — "map" would fire on "man", "may", "cap" — and a funnel
 * that answers the wrong comment in public is worse than one that misses.
 */
const MIN_FUZZY_LENGTH = 5;

/**
 * Keyword match on an inbound comment or DM.
 *
 * Word-boundary rather than substring: "MAP" must not fire on "roadmap", which
 * is exactly the sort of thing that makes an automation look unhinged in
 * public. Punctuation and emoji around the word are fine.
 *
 * Exact matching runs first across every variation, because it carries no risk
 * of a false positive. Only if nothing matched does it look for a near-miss.
 */
export function matchesKeyword(text: string, keyword: string): boolean {
  if (!text || !keyword) return false;
  const variants = keywordVariants(keyword);
  if (!variants.length) return false;

  for (const v of variants) {
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "iu").test(text)) {
      return true;
    }
  }

  const fuzzy = variants.filter((v) => v.length >= MIN_FUZZY_LENGTH && !/\s/.test(v));
  if (!fuzzy.length) return false;

  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.some((w) => fuzzy.some((v) => oneTypoApart(w, v)));
}
