/**
 * GET  /api/social/substack — is Substack wired up, and does the login work?
 * POST /api/social/substack — connect (or re-check) the Substack account.
 *
 * The session cookie is never sent to or stored by this route. It lives in
 * the Worker secret SUBSTACK_SID (`wrangler secret put SUBSTACK_SID`); this
 * route asks Substack who that login belongs to and records the profile +
 * publication as the social_accounts row the publisher targets.
 * POST is owner-only (admin session): it decides whose name Notes go out under.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSession, authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { substackConfigured, substackProfileSelf, SubstackAuthError } from "@/lib/social/substack";

export async function GET(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request, { allowRoles: ["admin", "social"] });
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const supabase = createAdminClient();
  const { data: account } = await supabase
    .from("social_accounts")
    .select("id, name, username, status, metadata, connected_at")
    .eq("platform", "substack")
    .maybeSingle();
  return NextResponse.json({ secret_set: substackConfigured(), account });
}

export async function POST(request: NextRequest) {
  const auth = await authenticateSession(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  if (!substackConfigured()) {
    return NextResponse.json(
      { error: "The Substack login isn't on the server yet. Ask Simon to set the SUBSTACK_SID secret." },
      { status: 400 }
    );
  }

  let profile;
  try {
    profile = await substackProfileSelf();
  } catch (e) {
    const status = e instanceof SubstackAuthError ? 401 : 502;
    return NextResponse.json({ error: e instanceof Error ? e.message : "Substack check failed" }, { status });
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("social_accounts")
    .upsert(
      {
        platform: "substack",
        external_id: String(profile.userId),
        name: profile.publication?.name || profile.name,
        username: profile.handle,
        access_token: null,
        refresh_token: null,
        status: "active",
        metadata: {
          credential: "worker secret SUBSTACK_SID",
          publication_id: profile.publication?.id ?? null,
          subdomain: profile.publication?.subdomain ?? null,
          display_name: profile.name,
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "platform,external_id" }
    )
    .select("id, name, username, status, metadata")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ connected: [`Substack @${profile.handle}`], account: data });
}
