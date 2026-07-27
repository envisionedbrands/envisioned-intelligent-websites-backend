/**
 * GET /api/agent/runs — recent agent runs for the live activity feed.
 * The dashboard polls this every ~2s; running rows carry their tool_calls
 * log as it grows.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSession, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { getCrmSettings } from "@/lib/crm/settings";

export async function GET(request: NextRequest) {
  const auth = await authenticateSession(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const limit = Math.min(50, Math.max(1, Number(request.nextUrl.searchParams.get("limit")) || 15));
  const supabase = createAdminClient();
  const [{ data, error }, settings] = await Promise.all([
    supabase
      .from("agent_runs")
      .select("id, trigger, status, summary, report_md, tool_calls, tokens_used, error, created_at, completed_at")
      .order("created_at", { ascending: false })
      .limit(limit),
    getCrmSettings(supabase),
  ]);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ runs: data || [], safe_mode: settings.safe_mode });
}
