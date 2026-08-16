/**
 * GET  /api/crm/templates/:id/preview — the template rendered in the real shell
 * POST /api/crm/templates/:id/preview — same, but for unsaved draft copy
 *
 * Returns HTML, so the editor previews exactly what the recipient gets rather
 * than an approximation. Sample merge values stand in for a real lead.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { getCrmSettings } from "@/lib/crm/settings";
import { renderEmailHtml } from "@/lib/crm/markdown";

const SAMPLE: Record<string, string> = {
  first_name: "Maria-Ines",
  last_name: "Fuenmayor",
  email: "someone@example.com",
  company: "Envisioned",
  booking_title: "Client Sessions — 1:1",
  booking_day: "Wednesday 19 August",
  booking_weekday: "Wednesday",
  booking_time: "10:00",
  meeting_url: "https://us02web.zoom.us/j/000000",
  guest_notes: "The thing I keep avoiding in the business.",
  reschedule_link: "#",
  cancellation_link: "#",
};

function fill(text: string): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/gi, (_m, key: string, alt?: string) => {
    const v = SAMPLE[key];
    return v ?? alt ?? `{{${key}}}`;
  });
}

async function render(bodyMd: string, preheader: string | null, supabase: ReturnType<typeof createAdminClient>) {
  const settings = await getCrmSettings(supabase);
  return renderEmailHtml({
    bodyMd: fill(bodyMd),
    preheader: preheader ? fill(preheader) : null,
    sender: settings.sender,
    unsubscribeUrl: "#",
  });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const { id } = await params;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("email_templates")
    .select("body_md, preheader")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return new NextResponse(await render(data.body_md, data.preheader, supabase), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);
  await params;

  let body: { body_md?: string; preheader?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const supabase = createAdminClient();
  return new NextResponse(await render(body.body_md || "", body.preheader ?? null, supabase), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
