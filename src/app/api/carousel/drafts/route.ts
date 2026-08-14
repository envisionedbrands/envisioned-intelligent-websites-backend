/**
 * Carousel drafts — the one controller every review interface talks to.
 * GET  /api/carousel/drafts        — list (newest first)
 * POST /api/carousel/drafts        — create a draft from a validated spec
 *
 * Auth: operator session OR signed API key (the same contract as the content
 * push wire), so the Studio, the local agent and ClaudeClaw all use this door.
 *
 * Creating a draft NEVER publishes anything. The unique partial index on
 * (article_slug, mode) where status != 'archived' makes retries idempotent:
 * a second create for the same article+mode returns the existing draft (200)
 * instead of a duplicate.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("carousel_drafts")
    .select("id, article_slug, mode, template_id, status, revision, caption, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ drafts: data ?? [] });
}

export async function POST(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const { article_slug, mode, template_id, template_version, spec, caption, source_revision } = body;
  if (!article_slug || !mode || !template_id || !spec) {
    return NextResponse.json(
      { error: "article_slug, mode, template_id and spec are required" },
      { status: 400 }
    );
  }
  if (!["functional", "archetypal"].includes(mode)) {
    return NextResponse.json({ error: "mode must be functional or archetypal" }, { status: 400 });
  }

  // Minimal server-side validation of the output contract's hard rules.
  const slides = Array.isArray(spec.slides) ? spec.slides : [];
  if (slides.length === 0) {
    return NextResponse.json({ error: "spec.slides must be a non-empty array" }, { status: 400 });
  }
  const misnumbered = slides.some(
    (s: { number?: number }, i: number) => s?.number !== i + 1
  );
  if (misnumbered) {
    return NextResponse.json({ error: "slide numbers must be consecutive from 1" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: article } = await supabase
    .from("content_objects")
    .select("id")
    .eq("slug", article_slug)
    .maybeSingle();

  const usedAssets: string[] = Array.from(
    new Set(slides.flatMap((s: { asset_ids?: string[] }) => s.asset_ids ?? []))
  );

  const { data, error } = await supabase
    .from("carousel_drafts")
    .insert({
      article_id: article?.id ?? null,
      article_slug,
      source_revision: source_revision ?? null,
      mode,
      template_id,
      template_version: template_version ?? "1.0.0",
      spec,
      caption: caption ?? null,
      used_asset_ids: usedAssets,
      created_by: auth.mode === "session" ? "human" : "agent",
    })
    .select("*")
    .single();

  if (error) {
    // 23505 = the live-draft unique index fired: hand back the existing draft.
    if (error.code === "23505") {
      const { data: existing } = await supabase
        .from("carousel_drafts")
        .select("*")
        .eq("article_slug", article_slug)
        .eq("mode", mode)
        .neq("status", "archived")
        .maybeSingle();
      return NextResponse.json({ draft: existing, existing: true }, { status: 200 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ draft: data }, { status: 201 });
}
