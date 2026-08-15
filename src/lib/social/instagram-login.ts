/**
 * Instagram Login — the messaging half of the Meta connection.
 *
 * NOT the same thing as `meta.ts`, and the near-identical vocabulary is the
 * whole trap. Meta ships two Instagram architectures with the same nouns:
 *
 *                     Facebook Login for Business      Instagram Login
 *   host              graph.facebook.com               graph.instagram.com
 *   app id/secret     META_APP_ID / _SECRET            META_IG_APP_ID / _SECRET
 *   scopes            instagram_manage_messages        instagram_business_manage_messages
 *   subscribe         POST /{page-id}/subscribed_apps  POST /me/subscribed_apps
 *   Facebook Page     required                         not involved at all
 *   webhook signed by the Facebook app secret          the Instagram app secret
 *
 * This app uses BOTH, on purpose. Publishing runs on the first (see meta.ts) and
 * is not being migrated — it works. Messaging runs on this one, because receiving
 * DMs on the Facebook-Login path needs the Page subscribed to the app, which
 * needs `pages_messaging`, which is in none of this app's use cases. Measured,
 * not inferred: POST /{page-id}/subscribed_apps returns
 * "(#200) To subscribe to the messages field, one of these permissions is
 * needed: pages_messaging".
 *
 * Tokens here live 60 days and must be refreshed. The Page token in
 * `social_accounts.access_token` never expires. Do not reason about one from the
 * other.
 */

const AUTHORIZE = "https://www.instagram.com/oauth/authorize";
const TOKEN = "https://api.instagram.com/oauth/access_token";
const GRAPH = "https://graph.instagram.com/v23.0";

/**
 * What we ask for, and nothing more. Every extra scope is another thing a
 * reviewer has to be talked into, and App Review is the long pole here — not
 * code. Content publishing is deliberately absent: that already works over
 * Facebook Login, and asking twice for the same capability invites a rejection.
 */
const SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
].join(",");

/** Webhook fields the connected account is subscribed to on connect. */
const WEBHOOK_FIELDS = "messages,comments";

export function igLoginConfigured(): boolean {
  return Boolean(process.env.META_IG_APP_ID && process.env.META_IG_APP_SECRET);
}

interface IgError {
  error?: { message?: string; code?: number };
  error_message?: string;
  error_type?: string;
}

/** Instagram's OAuth host and its Graph host disagree about error shapes. */
function igErrorText(data: IgError, status: number): string | null {
  const msg = data.error?.message || data.error_message;
  if (msg) return msg;
  return status >= 400 ? `HTTP ${status}` : null;
}

export function igLoginAuthorizeUrl(redirectUri: string, state: string): string {
  const url = new URL(AUTHORIZE);
  url.searchParams.set("client_id", process.env.META_IG_APP_ID!);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Code → short-lived token. Note this one is a POST with a form body against
 * api.instagram.com, not a GET against the Graph host — the only call in the
 * flow shaped that way.
 */
export async function igLoginExchangeCode(
  code: string,
  redirectUri: string
): Promise<{ token: string; userId: string }> {
  const res = await fetch(TOKEN, {
    method: "POST",
    body: new URLSearchParams({
      client_id: process.env.META_IG_APP_ID!,
      client_secret: process.env.META_IG_APP_SECRET!,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as IgError & {
    access_token?: string;
    user_id?: number | string;
  };
  const err = igErrorText(data, res.status);
  if (err || !data.access_token) {
    throw new Error(`Instagram code exchange failed: ${err || "no access_token returned"}`);
  }
  return { token: data.access_token, userId: String(data.user_id ?? "") };
}

/** Short-lived (1 hour) → long-lived (60 days). Skipping this is a funnel that dies at lunchtime. */
export async function igLoginLongLivedToken(
  shortToken: string
): Promise<{ token: string; expiresAt: string | null }> {
  const url = new URL(`${GRAPH.replace(/\/v[\d.]+$/, "")}/access_token`);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", process.env.META_IG_APP_SECRET!);
  url.searchParams.set("access_token", shortToken);
  const res = await fetch(url.toString());
  const data = (await res.json().catch(() => ({}))) as IgError & {
    access_token?: string;
    expires_in?: number;
  };
  const err = igErrorText(data, res.status);
  if (err || !data.access_token) {
    throw new Error(`Instagram long-lived exchange failed: ${err || "no access_token returned"}`);
  }
  return {
    token: data.access_token,
    expiresAt: data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : null,
  };
}

export interface IgLoginProfile {
  userId: string;
  username: string | null;
  name: string | null;
  profilePictureUrl: string | null;
}

export async function igLoginMe(token: string): Promise<IgLoginProfile> {
  const url = new URL(`${GRAPH}/me`);
  url.searchParams.set("fields", "user_id,username,name,profile_picture_url");
  url.searchParams.set("access_token", token);
  const res = await fetch(url.toString());
  const data = (await res.json().catch(() => ({}))) as IgError & {
    user_id?: string;
    id?: string;
    username?: string;
    name?: string;
    profile_picture_url?: string;
  };
  const err = igErrorText(data, res.status);
  if (err) throw new Error(`Instagram profile lookup failed: ${err}`);
  return {
    // `user_id` is the Instagram professional account id; `id` is the app-scoped
    // one. The funnel compares inbound comment authors against this to avoid
    // replying to itself, so the professional id is the one that matters.
    userId: String(data.user_id || data.id || ""),
    username: data.username ?? null,
    name: data.name ?? null,
    profilePictureUrl: data.profile_picture_url ?? null,
  };
}

/**
 * The step that actually turns webhooks on for this account.
 *
 * On the Facebook-Login path the equivalent call is against the Page and is
 * blocked by `pages_messaging`. Here it is against the Instagram account itself
 * and needs nothing beyond the scopes already granted — which is the entire
 * reason for this file's existence.
 *
 * Throws rather than failing soft: an account connected for DMs that is not
 * subscribed is deaf, and a green "connected" badge over a deaf account is the
 * exact failure mode that cost a day.
 */
export async function igLoginSubscribeWebhooks(token: string): Promise<void> {
  const res = await fetch(`${GRAPH}/me/subscribed_apps`, {
    method: "POST",
    body: new URLSearchParams({
      subscribed_fields: WEBHOOK_FIELDS,
      access_token: token,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as IgError & { success?: boolean };
  const err = igErrorText(data, res.status);
  if (err) throw new Error(`Instagram webhook subscription failed: ${err}`);
  if (data.success === false) throw new Error("Instagram webhook subscription returned success:false");
}

/** Reads back what the account is actually subscribed to. The only honest check. */
export async function igLoginSubscriptions(
  token: string
): Promise<Array<{ subscribed_fields?: string[] }>> {
  const url = new URL(`${GRAPH}/me/subscribed_apps`);
  url.searchParams.set("access_token", token);
  const res = await fetch(url.toString());
  const data = (await res.json().catch(() => ({}))) as IgError & {
    data?: Array<{ subscribed_fields?: string[] }>;
  };
  const err = igErrorText(data, res.status);
  if (err) throw new Error(`Instagram subscription read failed: ${err}`);
  return data.data ?? [];
}
