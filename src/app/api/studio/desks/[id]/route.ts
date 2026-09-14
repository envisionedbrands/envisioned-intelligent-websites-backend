/**
 * GET   /api/studio/desks/:id — desk + last 50 messages.
 * PATCH /api/studio/desks/:id — { name?, sop?, model?, persona?, max_context_tokens? }.
 */
import { NextRequest, NextResponse } from "next/server";
import { studioAuth } from "@/lib/studio/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { studioContextTextError } from "@/lib/studio/text-limits";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });
  const { id } = await params;
  const supabase = createAdminClient();

  const { data: desk, error } = await supabase.from("studio_desks").select("*").eq("id", id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!desk) return NextResponse.json({ error: "Desk not found" }, { status: 404 });

  // Secondary role order untangles legacy pairs that share a timestamp
  // (descending scan wants assistant-then-user so the reverse reads
  // user-then-assistant).
  const { data: messages, error: messagesError } = await supabase
    .from("studio_desk_messages")
    .select("id,role,content,meta,created_at")
    .eq("desk_id", id)
    .order("created_at", { ascending: false })
    .order("role", { ascending: true })
    .order("id", { ascending: false })
    .limit(50);
  if (messagesError) {
    return NextResponse.json({ error: "The desk conversation could not be read. Please try again." }, { status: 503 });
  }

  // The picker needs to know whether non-Anthropic models will actually
  // route (§12): no OpenRouter key → they fall back to the house Claude.
  return NextResponse.json({
    desk,
    messages: (messages ?? []).reverse(),
    openrouter: Boolean(process.env.OPENROUTER_API_KEY),
  });
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as
    | { name?: string; expected_name?: string; sop?: string | null; model?: string; persona?: string; max_context_tokens?: number }
    | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const sopError = studioContextTextError(body.sop, "Desk instructions");
  if (sopError) return NextResponse.json({ error: sopError, code: "studio_text_too_large" }, { status: 413 });

  const update: Record<string, unknown> = {};
  if (body.name?.trim()) update.name = body.name.trim();
  if (body.sop !== undefined) update.sop = body.sop;
  if (body.model) update.model = body.model;
  if (body.persona && ["none", "content-manager", "beacon"].includes(body.persona)) update.persona = body.persona;
  if (typeof body.max_context_tokens === "number") {
    update.max_context_tokens = Math.max(4000, Math.min(150000, body.max_context_tokens));
  }
  if (!Object.keys(update).length) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

  const supabase = createAdminClient();
  let query = supabase.from("studio_desks").update(update).eq("id", id);
  if (body.expected_name !== undefined) query = query.eq("name", body.expected_name);
  const { data, error } = await query.select("id,name").maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, updated: Boolean(data), name: data?.name ?? null });
}
