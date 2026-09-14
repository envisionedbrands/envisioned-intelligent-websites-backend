/**
 * POST /api/studio/desks — create a desk { name, persona?, sop?, model? }.
 * The client then places a desk node carrying desk_id on the board.
 */
import { NextRequest, NextResponse } from "next/server";
import { studioAuth } from "@/lib/studio/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { studioContextTextError } from "@/lib/studio/text-limits";

export async function POST(request: NextRequest) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });

  const body = (await request.json().catch(() => null)) as
    | { name?: string; persona?: string; sop?: string; model?: string }
    | null;
  if (!body?.name?.trim()) return NextResponse.json({ error: "name is required" }, { status: 400 });
  const sopError = studioContextTextError(body.sop, "Desk instructions");
  if (sopError) return NextResponse.json({ error: sopError, code: "studio_text_too_large" }, { status: 413 });

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("studio_desks")
    .insert({
      name: body.name.trim(),
      persona: body.persona && ["none", "content-manager", "beacon"].includes(body.persona) ? body.persona : "none",
      sop: body.sop ?? null,
      model: body.model ?? "claude-sonnet-4-6",
    })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ desk: data });
}
