/**
 * One carousel draft.
 * GET    — full draft incl. spec (the review screens read this)
 * PATCH  — status changes and revisions, all on the SAME row:
 *   { status: "approved" }                  draft -> approved
 *   { status: "archived" }                  any   -> archived
 *   { status: "draft" }                     approved -> draft (re-open)
 *   { feedback, spec?, caption?, changed_slides? }
 *       appends to revision_history, bumps revision, returns status to draft
 *       so a revised carousel always needs a FRESH approval.
 * DELETE — hard-deletes the draft row permanently
 *
 * Approval hands the draft to the human publishing flow — it does not post
 * anything anywhere. There is deliberately no "publish" here.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);
  const { id } = await params;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("carousel_drafts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ draft: data });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);
  const { id } = await params;

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const supabase = createAdminClient();
  const { data: draft } = await supabase
    .from("carousel_drafts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!draft) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Plain status change
  if (body.status && !body.feedback) {
    const allowed: Record<string, string[]> = {
      draft: ["approved", "archived"],
      approved: ["draft", "archived"],
      archived: ["draft"],
    };
    if (!allowed[draft.status]?.includes(body.status)) {
      return NextResponse.json(
        { error: `Cannot move ${draft.status} -> ${body.status}` },
        { status: 422 }
      );
    }
    const { data, error } = await supabase
      .from("carousel_drafts")
      .update({ status: body.status, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("*")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ draft: data });
  }

  // Revision: same draft id, history preserved, fresh approval required.
  if (body.feedback) {
    const history = Array.isArray(draft.revision_history) ? draft.revision_history : [];
    history.push({
      revision: draft.revision,
      feedback: body.feedback,
      changed_slides: body.changed_slides ?? [],
      actor: auth.mode === "session" ? "human" : "agent",
      requested_at: new Date().toISOString(),
      previous_specification: draft.spec,
    });
    const { data, error } = await supabase
      .from("carousel_drafts")
      .update({
        spec: body.spec ?? draft.spec,
        caption: body.caption ?? draft.caption,
        revision: draft.revision + 1,
        revision_history: history,
        status: "draft",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select("*")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ draft: data });
  }

  return NextResponse.json({ error: "Provide status or feedback" }, { status: 400 });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);
  const { id } = await params;

  const supabase = createAdminClient();
  const { data: draft } = await supabase
    .from("carousel_drafts")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (!draft) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { error } = await supabase
    .from("carousel_drafts")
    .delete()
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, deleted: id });
}
