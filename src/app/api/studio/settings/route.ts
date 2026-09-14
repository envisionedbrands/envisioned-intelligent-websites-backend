/**
 * GET/POST /api/studio/settings — legacy Studio carousel diagnostics.
 *
 * Old installations wrote a look (and sometimes arbitrary template HTML) one
 * key at a time. Those rows are not executable in 1.6.7: only the atomic,
 * signed receipt written through /api/studio/carousel-config can make the
 * carousel queue ready. GET keeps the harmless legacy selector visible for
 * migration diagnosis; POST fails closed so a partial choice cannot reappear.
 */
import { NextRequest, NextResponse } from "next/server";
import { studioAuth } from "@/lib/studio/auth";
import { createAdminClient } from "@/lib/supabase/server";

const LEGACY_STUDIO_KEYS = ['content_house_look', 'carousel_renderer'] as const;

export async function GET(request: NextRequest) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("backend_settings")
    .select("key, value")
    .in("key", [...LEGACY_STUDIO_KEYS]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const settings: Record<string, unknown> = {};
  for (const row of data ?? []) settings[row.key] = row.value;
  return NextResponse.json({
    settings,
    deprecated: true,
    issue: Object.hasOwn(settings, 'content_house_look') ? 'legacy_look_only_config' : 'house_look_required',
    write_endpoint: '/api/studio/carousel-config',
  });
}

export async function POST(request: NextRequest) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });
  return NextResponse.json(
    {
      error: 'Legacy one-key carousel settings are read-only. Save a complete signed receipt through /api/studio/carousel-config.',
      code: 'legacy_look_only_config',
    },
    { status: 410 },
  );
}
