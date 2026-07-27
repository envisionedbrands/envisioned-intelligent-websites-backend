/**
 * POST /api/agent/tick — The Operator's heartbeat.
 * Default: the daily "review the house" morning report. Body {mode:"weekly"}
 * runs the deeper weekly growth report (pipeline, engagement, attribution,
 * A/B tests). Session OR signed machine auth, so crons drive both.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { runOperator, morningReviewPrompt, weeklyReviewPrompt } from "@/lib/agent/run";

export async function POST(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const body = (await request.json().catch(() => ({}))) as { mode?: string };
  const weekly = body?.mode === "weekly";

  const supabase = createAdminClient();
  try {
    const result = await runOperator({
      supabase,
      origin: request.nextUrl.origin,
      trigger: "tick",
      message: weekly ? await weeklyReviewPrompt(supabase) : await morningReviewPrompt(supabase),
    });
    return NextResponse.json({
      ok: true,
      run_id: result.runId,
      report_md: result.reply,
      tool_calls: result.toolCalls.length,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Tick failed" },
      { status: 500 }
    );
  }
}
