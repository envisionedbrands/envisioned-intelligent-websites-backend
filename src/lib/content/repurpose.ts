/**
 * Repurposing — one article becomes the pieces that carry it elsewhere.
 *
 * Audited 2026-08-16: nothing connected an essay to a LinkedIn post or a
 * caption. `social_posts` is video-shaped and belongs to Clip Studio;
 * `carousel_drafts` was the only downstream format with a link back to its
 * source. This does for text what carousels already did for slides.
 *
 * Two principles:
 *   1. Derivatives are DRAFTS. Nothing schedules or publishes itself.
 *   2. Her voice comes from brand_context, not from this file. The platform
 *      playbooks, voice guide and banned phrases she has already written are
 *      the instructions — hardcoding tone here would fork her voice.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type AdminClient = SupabaseClient<Database>;

export type DerivativeKind =
  | "linkedin"
  | "instagram"
  | "facebook"
  | "x"
  | "newsletter"
  | "substack_note";

/** What each format needs, and which of her playbooks governs it. */
const FORMATS: Record<
  DerivativeKind,
  { label: string; brief: string; contextKeys: string[] }
> = {
  linkedin: {
    label: "LinkedIn post",
    brief:
      "150-250 words. Story or diagnosis first — never a summary of the article. One idea, taken further than a summary would. Line breaks for breathing. No hashtag salad.",
    contextKeys: ["content/platform-linkedin"],
  },
  instagram: {
    label: "Instagram caption",
    brief:
      "100-180 words. The first line has to earn the tap on 'more'. Written to be read on a phone at speed. Permission-based CTA only.",
    contextKeys: ["content/platform-instagram"],
  },
  facebook: {
    label: "Facebook post",
    brief: "120-200 words, conversational, closer to how she talks than how she writes.",
    contextKeys: ["content/platform-facebook"],
  },
  x: {
    label: "X post",
    brief: "Under 280 characters. One sharp claim, no thread, no hook-bait.",
    contextKeys: [],
  },
  newsletter: {
    label: "Newsletter section",
    brief:
      "200-350 words that can sit inside a wider email. Markdown. May use a > pull quote and end with a single link line, which renders as a button.",
    contextKeys: ["content/platform-substack"],
  },
  substack_note: {
    label: "Substack note",
    brief: "80-150 words. A thought worth posting on its own, not a teaser for the essay.",
    contextKeys: ["content/platform-substack"],
  },
};

export const DERIVATIVE_KINDS = Object.keys(FORMATS) as DerivativeKind[];

async function brandContext(supabase: AdminClient, keys: string[]): Promise<string> {
  // Voice rules always apply; platform playbooks are additive.
  const always = ["voice/voice-guide", "voice/banned-phrases", "voice/forbidden-phrases"];
  const wanted = Array.from(new Set([...always, ...keys]));

  const { data } = await supabase.from("brand_context").select("category, key, content");
  const rows = (data || []).filter((r) => wanted.includes(`${r.category}/${r.key}`));
  if (!rows.length) return "";

  return rows
    .map((r) => `## ${r.category}/${r.key}\n${String(r.content).slice(0, 4000)}`)
    .join("\n\n");
}

function extractJson(text: string): { hook?: string; body?: string; cta?: string } | null {
  // Models like to wrap JSON in prose or fences; take the first object.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function generateOne(
  apiKey: string,
  kind: DerivativeKind,
  article: { title: string; body: string },
  context: string
): Promise<{ hook: string; body: string; cta: string } | null> {
  const format = FORMATS[kind];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 2000,
      thinking: { type: "adaptive" },
      system: `You write as Maria-Ines of Envisioned Brands. Her voice rules are below and are absolute — the banned phrases are banned, not discouraged.

${context}

You are adapting one of her essays into a ${format.label}. This is NOT a summary. Take one idea from the piece and carry it somewhere on its own terms: the reader should get value without clicking anything.

Format brief: ${format.brief}

Return ONLY JSON:
{"hook": "the opening line, standalone", "body": "the full post including the hook", "cta": "the closing line or invitation, or empty string"}`,
      messages: [
        {
          role: "user",
          content: `TITLE: ${article.title}\n\nESSAY:\n${article.body.slice(0, 24000)}`,
        },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const payload = (await res.json()) as {
    content?: { type: string; text?: string }[];
    stop_reason?: string;
  };
  if (payload.stop_reason === "refusal") return null;

  const text = (payload.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("\n");

  const parsed = extractJson(text);
  if (!parsed?.body) return null;
  return { hook: parsed.hook || "", body: parsed.body, cta: parsed.cta || "" };
}

export type RepurposeResult = {
  created: { kind: DerivativeKind; id: string }[];
  errors: string[];
  runId: string;
};

export async function repurposeArticle(
  supabase: AdminClient,
  contentId: string,
  kinds: DerivativeKind[]
): Promise<RepurposeResult> {
  const runId = crypto.randomUUID();
  const result: RepurposeResult = { created: [], errors: [], runId };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    result.errors.push("ANTHROPIC_API_KEY not configured");
    return result;
  }

  const { data: article } = await supabase
    .from("content_objects")
    .select("id, title, body")
    .eq("id", contentId)
    .maybeSingle();
  if (!article?.body) {
    result.errors.push("Article not found, or it has no body to work from");
    return result;
  }

  for (const kind of kinds) {
    try {
      const context = await brandContext(supabase, FORMATS[kind].contextKeys);
      const piece = await generateOne(apiKey, kind, { title: article.title, body: article.body }, context);
      if (!piece) {
        result.errors.push(`${kind}: model returned nothing usable`);
        continue;
      }

      const { data: row, error } = await supabase
        .from("content_derivatives")
        .insert({
          source_content_id: article.id,
          kind,
          title: article.title,
          hook: piece.hook,
          body: piece.body,
          cta: piece.cta,
          status: "draft", // never anything else from here
          run_id: runId,
        })
        .select("id")
        .single();

      if (error) result.errors.push(`${kind}: ${error.message}`);
      else result.created.push({ kind, id: row.id });
    } catch (e) {
      result.errors.push(`${kind}: ${e instanceof Error ? e.message : "generation failed"}`);
    }
  }

  return result;
}
