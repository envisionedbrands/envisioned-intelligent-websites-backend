/**
 * GET /api/brand-context — audit view of the brand_context table.
 *
 * Returns metadata + staleness flags per row (never full content), so brand
 * hygiene can be checked without dashboard access. Session or signed API auth.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("brand_context")
    .select("key, category, content, updated_at")
    .order("category")
    .order("key");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data || []).map((row) => {
    const c = row.content || "";
    const lower = c.toLowerCase();
    return {
      category: row.category,
      key: row.key,
      chars: c.length,
      updated_at: row.updated_at,
      preview: c.slice(0, 120).replace(/\s+/g, " "),
      flags: {
        has_prices: /[€$]\s?\d/.test(c),
        old_citc_price: lower.includes("3,500") || lower.includes("3500"),
        old_fonts: lower.includes("cormorant") || lower.includes("italiana"),
        mentions_pulse: lower.includes("pulse"),
        mentions_atelier: lower.includes("atelier"),
      },
    };
  });

  const totalChars = rows.reduce((sum, r) => sum + r.chars, 0);
  return NextResponse.json({ total_rows: rows.length, total_chars: totalChars, rows });
}
