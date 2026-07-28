/**
 * POST /api/content-calendar/[id]/revise — rewrite a topic per a one-line instruction.
 *
 * The "Fix" button on the board: MI says what's wrong ("too listicle", "angle it
 * toward founder dependency", "drop the hype") and the entry rewrites itself in
 * place. Status is preserved. Session or signed API auth.
 */

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";

type RouteContext = { params: Promise<{ id: string }> };

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("No JSON in response");
  return trimmed.slice(start, end + 1);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured." }, { status: 500 });
  }

  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { instruction?: string };
  const instruction = (body.instruction || "").trim();
  if (!instruction) {
    return NextResponse.json({ error: "instruction is required" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: entry, error: entryError } = await supabase
    .from("content_calendar")
    .select("*")
    .eq("id", id)
    .single();
  if (entryError || !entry) {
    return NextResponse.json({ error: "Calendar entry not found" }, { status: 404 });
  }

  const anthropic = new Anthropic();
  const completion = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: `You revise content-calendar topics for a business website per the owner's instruction.

Rules:
- Apply the instruction faithfully; keep whatever the instruction doesn't touch.
- No hype language. Practical, specific, calm framing.
- notes: 2-3 sentences, implication-first; keep any "Source: <url>" line if present.
- Return ONLY valid JSON with exactly these keys:
{"title": "...", "search_query": "...", "target_keyword": "...", "keyword_cluster": "...",
 "intent_type": "how_to|comparison|definition|informational|commercial|transactional|listicle|case_study|opinion",
 "priority": "high|medium|low", "pillar_topic": "string or null", "notes": "..."}`,
    messages: [
      {
        role: "user",
        content: `Current topic:
${JSON.stringify(
  {
    title: entry.title,
    search_query: entry.search_query,
    target_keyword: entry.target_keyword,
    keyword_cluster: entry.keyword_cluster,
    intent_type: entry.intent_type,
    priority: entry.priority,
    pillar_topic: entry.pillar_topic,
    notes: entry.notes,
  },
  null,
  2
)}

Owner's instruction: ${instruction}

Rewrite the topic accordingly.`,
      },
    ],
  });

  const responseText =
    completion.content[0]?.type === "text" ? completion.content[0].text : "";

  let revised: Record<string, unknown>;
  try {
    revised = JSON.parse(extractJsonObject(responseText)) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Failed to parse revision" }, { status: 500 });
  }

  const allowedIntents = new Set([
    "how_to", "comparison", "definition", "informational", "commercial",
    "transactional", "listicle", "case_study", "opinion",
  ]);
  const allowedPriorities = new Set(["high", "medium", "low"]);

  const update = {
    title: typeof revised.title === "string" && revised.title ? revised.title : entry.title,
    search_query:
      typeof revised.search_query === "string" && revised.search_query
        ? revised.search_query
        : entry.search_query,
    target_keyword:
      typeof revised.target_keyword === "string" && revised.target_keyword
        ? revised.target_keyword
        : entry.target_keyword,
    keyword_cluster:
      typeof revised.keyword_cluster === "string" && revised.keyword_cluster
        ? revised.keyword_cluster
        : entry.keyword_cluster,
    intent_type: allowedIntents.has(revised.intent_type as string)
      ? (revised.intent_type as typeof entry.intent_type)
      : entry.intent_type,
    priority: allowedPriorities.has(revised.priority as string)
      ? (revised.priority as typeof entry.priority)
      : entry.priority,
    pillar_topic:
      typeof revised.pillar_topic === "string" ? revised.pillar_topic : entry.pillar_topic,
    notes: typeof revised.notes === "string" && revised.notes ? revised.notes : entry.notes,
  };

  const { data: updated, error: updateError } = await supabase
    .from("content_calendar")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, entry: updated });
}
