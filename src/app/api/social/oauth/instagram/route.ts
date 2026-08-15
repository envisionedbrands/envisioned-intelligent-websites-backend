/**
 * GET /api/social/oauth/instagram — Instagram Login, for messaging only.
 *
 * Deliberately a separate route from /api/social/oauth/meta rather than a flag
 * on it. They are different apps, different hosts, different secrets and
 * different scopes; the one thing they share is the word "Instagram". Folding
 * them together would produce exactly the confusion that made DM webhooks
 * silently undeliverable in the first place.
 *
 * No ?code → set a state cookie, bounce to Instagram's dialog.
 * ?code   → exchange, upgrade to a 60-day token, subscribe the account to
 *           webhooks, and store the token BESIDE the publishing token.
 *
 * Publishing is untouched by this route. It never writes `access_token`.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { authenticateSession, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import {
  igLoginAuthorizeUrl,
  igLoginConfigured,
  igLoginExchangeCode,
  igLoginLongLivedToken,
  igLoginMe,
  igLoginSubscribeWebhooks,
  igLoginSubscriptions,
} from "@/lib/social/instagram-login";

const STATE_COOKIE = "ig_login_oauth_state";

export async function GET(request: NextRequest) {
  const auth = await authenticateSession(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  if (!igLoginConfigured()) {
    return NextResponse.json(
      { error: "Instagram Login is not configured — set META_IG_APP_ID and META_IG_APP_SECRET" },
      { status: 503 }
    );
  }

  const { searchParams, origin } = request.nextUrl;
  const redirectUri = `${origin}/api/social/oauth/instagram`;
  const accountsUrl = new URL("/social/accounts", origin);

  if (searchParams.get("error")) {
    accountsUrl.searchParams.set(
      "error",
      searchParams.get("error_description") || "Instagram connection was canceled"
    );
    return NextResponse.redirect(accountsUrl);
  }

  const code = searchParams.get("code");
  if (!code) {
    const state = randomUUID();
    const res = NextResponse.redirect(igLoginAuthorizeUrl(redirectUri, state));
    res.cookies.set(STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 600,
      path: "/api/social/oauth",
    });
    return res;
  }

  if (searchParams.get("state") !== request.cookies.get(STATE_COOKIE)?.value) {
    accountsUrl.searchParams.set("error", "OAuth state mismatch — try connecting again");
    return NextResponse.redirect(accountsUrl);
  }

  try {
    const { token: shortToken } = await igLoginExchangeCode(code, redirectUri);
    const { token, expiresAt } = await igLoginLongLivedToken(shortToken);
    const me = await igLoginMe(token);
    if (!me.userId) throw new Error("Instagram did not return an account id");

    // Turn webhooks on, then read them back. The subscribe call answering 200 is
    // not proof — the read is. A connected-looking account that receives nothing
    // is the failure this whole route exists to eliminate, so it gets surfaced
    // in the redirect rather than buried in a metadata field nobody opens.
    let subscribed: string[] = [];
    let subscribeError: string | null = null;
    try {
      await igLoginSubscribeWebhooks(token);
      const subs = await igLoginSubscriptions(token);
      subscribed = subs.flatMap((s) => s.subscribed_fields ?? []);
    } catch (e) {
      subscribeError = e instanceof Error ? e.message : "webhook subscription failed";
    }

    const supabase = createAdminClient();
    const dmFields = {
      dm_access_token: token,
      dm_token_expires_at: expiresAt,
      status: "active" as const,
    };

    // Update the existing row if this account is already connected for
    // publishing, so the Page token in `access_token` survives untouched.
    const { data: existing } = await supabase
      .from("social_accounts")
      .select("id")
      .eq("platform", "instagram")
      .eq("external_id", me.userId)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("social_accounts")
        .update(dmFields as never)
        .eq("id", existing.id);
    } else {
      await supabase.from("social_accounts").insert({
        platform: "instagram",
        external_id: me.userId,
        name: me.name || me.username || "Instagram",
        username: me.username,
        connected_at: new Date().toISOString(),
        metadata: { avatar: me.profilePictureUrl } as never,
        ...dmFields,
      } as never);
    }

    if (subscribeError) {
      accountsUrl.searchParams.set("error", `Connected, but webhooks failed: ${subscribeError}`);
    } else if (!subscribed.length) {
      accountsUrl.searchParams.set(
        "error",
        "Connected, but the account reports no webhook subscriptions — DMs will not arrive"
      );
    } else {
      accountsUrl.searchParams.set("connected", "1");
      accountsUrl.searchParams.set("webhooks", subscribed.join(","));
    }
  } catch (e) {
    accountsUrl.searchParams.set(
      "error",
      e instanceof Error ? e.message : "Instagram connection failed"
    );
  }

  const res = NextResponse.redirect(accountsUrl);
  res.cookies.delete(STATE_COOKIE);
  return res;
}
