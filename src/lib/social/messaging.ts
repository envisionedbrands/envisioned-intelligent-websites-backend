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
 * Free-form DM. Requires an open 24-hour window — check before calling; this
 * throws MetaSendError with code 10 if the window has shut.
 */
export async function sendDm(
  igUserId: string,
  pageToken: string,
  recipientIgsid: string,
  text: string
): Promise<SendResult> {
  const res = await graphPost<{ message_id?: string; recipient_id?: string }>(
    `/${igUserId}/messages`,
    pageToken,
    { recipient: { id: recipientIgsid }, message: { text } }
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

/**
 * Keyword match on an inbound comment or DM.
 *
 * Word-boundary rather than substring: "MAP" must not fire on "roadmap", which
 * is exactly the sort of thing that makes an automation look unhinged in
 * public. Punctuation and emoji around the word are fine.
 */
export function matchesKeyword(text: string, keyword: string): boolean {
  if (!text || !keyword) return false;
  const escaped = keyword.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "iu").test(text);
}
