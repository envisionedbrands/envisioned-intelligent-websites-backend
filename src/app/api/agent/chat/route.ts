/**
 * POST /api/agent/chat — one chat turn with The Operator.
 * Body: { message: string, history?: [{role, content}] }
 * Session-only: this is the owner's chat surface.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSession, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { runOperator, type ChatTurn } from "@/lib/agent/run";

export async function POST(request: NextRequest) {
  const auth = await authenticateSession(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const body = (await request.json().catch(() => null)) as {
    message?: string;
    history?: ChatTurn[];
  } | null;
  const message = body?.message?.trim();
  if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });

  const history = Array.isArray(body?.history)
    ? body!.history!.filter(
        (t) => (t.role === "user" || t.role === "assistant") && typeof t.content === "string"
      )
    : [];

  const supabase = createAdminClient();
  try {
    const result = await runOperator({
      supabase,
      origin: request.nextUrl.origin,
      trigger: "chat",
      message,
      history,
    });
    return NextResponse.json({
      reply: result.reply,
      run_id: result.runId,
      tool_calls: result.toolCalls.map((t) => ({ tool: t.tool, summary: t.summary, ok: t.ok })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Agent run failed" },
      { status: 500 }
    );
  }
}
