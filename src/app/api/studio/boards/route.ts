/**
 * GET  /api/studio/boards — list boards.
 * POST /api/studio/boards — create a board { name, template_key? }.
 * Session (admin) or machine Bearer key — see lib/studio/auth.
 */
import { NextRequest, NextResponse } from "next/server";
import { studioAuth } from "@/lib/studio/auth";
import { createAdminClient } from "@/lib/supabase/server";
import {
  applyTemplate,
  cleanupTemplateBuild,
  TEMPLATE_KEYS,
  type TemplateKey,
} from "@/lib/studio/templates";

type AdminClient = ReturnType<typeof createAdminClient>;
const STALE_TEMPLATE_BUILD_MS = 15 * 60 * 1000;

const safeError = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * A process can disappear between template writes, so request-level catch is
 * not sufficient. Claim old building rows as failed, then delete their tagged
 * desks before the board. Ready boards are never candidates and ordinary board
 * deletion continues to preserve desk conversations.
 */
async function cleanupStaleTemplateBuilds(supabase: AdminClient) {
  const cutoff = new Date(Date.now() - STALE_TEMPLATE_BUILD_MS).toISOString();
  const [{ data: building, error: buildingError }, { data: failed, error: failedError }] = await Promise.all([
    supabase
      .from("studio_boards")
      .select("id,status,updated_at")
      .eq("status", "building")
      .lt("updated_at", cutoff)
      .limit(10),
    supabase
      .from("studio_boards")
      .select("id,status,updated_at")
      .eq("status", "failed")
      .limit(10),
  ]);
  if (buildingError || failedError) {
    console.error("[studio-template] stale build scan failed", {
      error: buildingError?.message ?? failedError?.message ?? "unknown scan error",
    });
    return;
  }

  for (const candidate of [...(building ?? []), ...(failed ?? [])]) {
    if (candidate.status === "building") {
      const { data: claimed, error: claimError } = await supabase
        .from("studio_boards")
        .update({ status: "failed" })
        .eq("id", candidate.id)
        .eq("status", "building")
        .lt("updated_at", cutoff)
        .select("id")
        .maybeSingle();
      if (claimError) {
        console.error("[studio-template] stale build claim failed", { boardId: candidate.id, error: claimError.message });
        continue;
      }
      if (!claimed) continue;
    }
    const cleanup = await cleanupTemplateBuild(supabase, candidate.id);
    if (!cleanup.ok) {
      console.error("[studio-template] stale build cleanup failed", {
        boardId: candidate.id,
        stage: cleanup.stage,
        error: cleanup.error,
      });
    }
  }
}

export async function GET(request: NextRequest) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });

  const supabase = createAdminClient();
  await cleanupStaleTemplateBuilds(supabase);
  const { data, error } = await supabase
    .from("studio_boards")
    .select("id,name,template_key,created_at,updated_at")
    .eq("status", "ready")
    .order("updated_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ boards: data });
}

export async function POST(request: NextRequest) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { name?: string; template_key?: string } | null;
  if (!body?.name?.trim()) return NextResponse.json({ error: "name is required" }, { status: 400 });

  const template = body.template_key && (TEMPLATE_KEYS as readonly string[]).includes(body.template_key)
    ? (body.template_key as TemplateKey)
    : null;

  const supabase = createAdminClient();
  await cleanupStaleTemplateBuilds(supabase);
  const { data, error } = await supabase
    .from("studio_boards")
    .insert({ name: body.name.trim(), template_key: template, status: template ? "building" : "ready" })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (template) {
    try {
      await applyTemplate(supabase, data.id, template);
      const { data: readyBoard, error: readyError } = await supabase
        .from("studio_boards")
        .update({ status: "ready" })
        .eq("id", data.id)
        .eq("status", "building")
        .select("*")
        .maybeSingle();
      if (readyError || !readyBoard) {
        throw new Error(readyError?.message ?? "Template build was no longer in the building state");
      }
      return NextResponse.json({ board: readyBoard });
    } catch (error) {
      console.error("[studio-template] template apply failed", { boardId: data.id, error: safeError(error) });
      const { error: markError } = await supabase
        .from("studio_boards")
        .update({ status: "failed" })
        .eq("id", data.id)
        .eq("status", "building");
      if (markError) {
        console.error("[studio-template] failed build could not be marked", { boardId: data.id, error: markError.message });
      }
      const cleanup = await cleanupTemplateBuild(supabase, data.id);
      if (!cleanup.ok) {
        console.error("[studio-template] compensating cleanup failed", {
          boardId: data.id,
          stage: cleanup.stage,
          error: cleanup.error,
        });
      }
      return NextResponse.json(
        {
          error: cleanup.ok
            ? "The template could not be completed. Its incomplete records were removed. Please try again."
            : cleanup.stage === "ready_board"
              ? "The template may have completed, but its final state could not be confirmed. Return to your boards before trying again."
              : "The template failed and its incomplete records could not be removed automatically. The board remains hidden; please contact support.",
          code: cleanup.ok
            ? "template_apply_failed"
            : cleanup.stage === "ready_board"
              ? "template_state_unconfirmed"
              : "template_cleanup_failed",
        },
        { status: cleanup.ok ? 503 : 500 }
      );
    }
  }
  return NextResponse.json({ board: data });
}
