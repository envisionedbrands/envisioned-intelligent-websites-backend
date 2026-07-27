/**
 * POST /api/agent/actions/[id] — decide on a proposed action.
 * Body: { decision: "approve" | "reject" }
 * Approve executes immediately through the trust layer (safe-mode aware).
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSession, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { executeAgentAction } from "@/lib/agent/actions";
import type { Json } from "@/types/database";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSession(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const { id } = await params;
  const body = (await request.json().catch(() => null)) as { decision?: string } | null;
  const decision = body?.decision;
  if (decision !== "approve" && decision !== "reject") {
    return NextResponse.json({ error: "decision must be 'approve' or 'reject'" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: action, error } = await supabase
    .from("agent_actions")
    .select("*")
    .eq("id", id)
    .single();
  if (error || !action) return NextResponse.json({ error: "Action not found" }, { status: 404 });
  if (action.status !== "proposed") {
    return NextResponse.json({ error: `Action is already ${action.status}` }, { status: 409 });
  }

  const decidedAt = new Date().toISOString();

  if (decision === "reject") {
    await supabase
      .from("agent_actions")
      .update({ status: "rejected", decided_at: decidedAt })
      .eq("id", id);
    return NextResponse.json({ ok: true, status: "rejected" });
  }

  await supabase
    .from("agent_actions")
    .update({ status: "approved", decided_at: decidedAt })
    .eq("id", id);

  try {
    const result = await executeAgentAction(supabase, action);
    await supabase
      .from("agent_actions")
      .update({ status: "executed", result: result as Json, executed_at: new Date().toISOString() })
      .eq("id", id);
    return NextResponse.json({ ok: true, status: "executed", result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Execution failed";
    await supabase
      .from("agent_actions")
      .update({ status: "failed", result: { error: message } as Json })
      .eq("id", id);
    return NextResponse.json({ error: message, status: "failed" }, { status: 500 });
  }
}
