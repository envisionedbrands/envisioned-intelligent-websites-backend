/**
 * PATCH  /api/crm/derivatives/:id — edit or change status
 * DELETE /api/crm/derivatives/:id
 *
 * Status moves draft → approved → scheduled → published. Approving is a
 * status change, NOT a send: nothing in this system posts to a platform by
 * itself, and that stays true until she asks for it explicitly.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";

const STATUSES = ["draft", "approved", "scheduled", "published", "archived"];

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const { id } = await params;

  let body: { status?: string; body?: string; hook?: string; cta?: string; notes?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.status) {
    if (!STATUSES.includes(body.status)) {
      return NextResponse.json({ error: `status must be one of ${STATUSES.join(", ")}` }, { status: 400 });
    }
    patch.status = body.status;
    // "published" is a record of something she did elsewhere, not an action
    // taken here — stamp the time so the log stays honest either way.
    if (body.status === "published") patch.published_at = new Date().toISOString();
  }
  if (typeof body.body === "string") patch.body = body.body;
  if (typeof body.hook === "string") patch.hook = body.hook;
  if (typeof body.cta === "string") patch.cta = body.cta;
  if (typeof body.notes === "string") patch.notes = body.notes;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("content_derivatives")
    .update(patch)
    .eq("id", id)
    .select("id, status")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, derivative: data });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const { id } = await params;
  const supabase = createAdminClient();
  const { error } = await supabase.from("content_derivatives").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
