/**
 * GET /api/social/substack/stats?days=30&limit=50
 * Recent Notes ranked by subscribers driven (paid, then free), then impressions.
 * Numbers come from Substack's own per-Note stats, refreshed by the social
 * tick every ~6 hours for Notes from the last 30 days.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { substackNoteStats } from "@/lib/social/substack-ops";

export async function GET(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request, { allowRoles: ["admin", "social"] });
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const params = request.nextUrl.searchParams;
  try {
    const stats = await substackNoteStats(createAdminClient(), {
      days: Number(params.get("days")) || 30,
      limit: Number(params.get("limit")) || 50,
    });
    return NextResponse.json(stats);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Stats failed" }, { status: 500 });
  }
}
