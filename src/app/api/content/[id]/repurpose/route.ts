/**
 * GET  /api/content/:id/repurpose — derivatives already made from this article
 * POST /api/content/:id/repurpose — generate a set { kinds?: [...] }
 *
 * Everything lands as a draft. Nothing here schedules or publishes.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { repurposeArticle, DERIVATIVE_KINDS, type DerivativeKind } from "@/lib/content/repurpose";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const { id } = await params;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("content_derivatives")
    .select("*")
    .eq("source_content_id", id)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ derivatives: data || [], kinds: DERIVATIVE_KINDS });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const { id } = await params;

  let body: { kinds?: string[] } = {};
  try {
    body = await request.json();
  } catch {
    /* empty body means "all formats" */
  }

  const requested = (body.kinds?.length ? body.kinds : DERIVATIVE_KINDS).filter((k) =>
    (DERIVATIVE_KINDS as string[]).includes(k)
  ) as DerivativeKind[];

  if (!requested.length) {
    return NextResponse.json(
      { error: `kinds must be some of: ${DERIVATIVE_KINDS.join(", ")}` },
      { status: 400 }
    );
  }

  const supabase = createAdminClient();
  const result = await repurposeArticle(supabase, id, requested);

  // Partial success is normal — one format failing shouldn't discard the rest.
  return NextResponse.json(result, { status: result.created.length ? 200 : 502 });
}
