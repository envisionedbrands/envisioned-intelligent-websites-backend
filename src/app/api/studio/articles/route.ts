/**
 * The canvas's door to the home's own articles — on EVERY board, not just the
 * multiplication template.
 *
 * GET  → list the home's published articles for the picker.
 * POST { ids: string[] } → mirror the picked articles into studio_sources
 *        (ready immediately — the body IS the transcript) and return the
 *        full source rows so cards land without polling.
 */
import { NextRequest, NextResponse } from "next/server";
import { studioAuth } from "@/lib/studio/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { mirrorArticlesByIds } from "@/lib/studio/templates";

export async function GET(request: NextRequest) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("content_objects")
    .select("id,slug,title,status,published_at,created_at,view_count,featured_image_url")
    .eq("content_type", "article")
    .eq("status", "published")
    .not("body", "is", null)
    .order("published_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(60);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ articles: data ?? [] });
}

export async function POST(request: NextRequest) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { ids?: string[] } | null;
  const ids = Array.isArray(body?.ids) ? body.ids.filter((i) => typeof i === "string").slice(0, 20) : [];
  if (!ids.length) return NextResponse.json({ error: "ids required" }, { status: 400 });

  if (!(process.env.NEXT_PUBLIC_DIGITAL_HOME_URL || process.env.DIGITAL_HOME_URL)) {
    return NextResponse.json(
      { error: "DIGITAL_HOME_URL is not configured — the Studio needs your site URL to mirror articles." },
      { status: 409 }
    );
  }
  const supabase = createAdminClient();
  const sources = await mirrorArticlesByIds(supabase, ids);
  return NextResponse.json({ sources });
}
