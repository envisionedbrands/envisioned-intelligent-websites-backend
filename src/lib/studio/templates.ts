/**
 * Content Studio board templates — three flagship workflows, pre-wired so a
 * new board is never a blank canvas. Voice groups auto-fill with the freshest own sources;
 * the article template mirrors recent published articles in as sources.
 */
import type { createAdminClient } from "@/lib/supabase/server";
import type { Json } from "@/types/database";

type AdminClient = ReturnType<typeof createAdminClient>;
const uid = () => crypto.randomUUID();

export const TEMPLATE_KEYS = ["youtube-video", "article-multiplication", "model-a-reel"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

type NodeIn = {
  id: string;
  board_id: string;
  kind: string;
  position: Json;
  data?: Json;
  source_id?: string | null;
  desk_id?: string | null;
};
type EdgeIn = { id: string; board_id: string; from_node: string; to_node: string };

async function makeDesk(
  supabase: AdminClient,
  createdDeskIds: string[],
  templateBuildId: string,
  desk: { name: string; persona?: string; sop: string; settings?: Json }
) {
  const settings = desk.settings && typeof desk.settings === "object" && !Array.isArray(desk.settings)
    ? (desk.settings as Record<string, Json>)
    : {};
  const { data, error } = await supabase
    .from("studio_desks")
    .insert({
      name: desk.name,
      persona: desk.persona ?? "none",
      sop: desk.sop,
      settings: { ...settings, template_build_id: templateBuildId },
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const id = data.id as string;
  createdDeskIds.push(id);
  return id;
}

export type TemplateCleanupResult =
  | { ok: true }
  | { ok: false; stage: "ready_board" | "desk_cleanup" | "board_cleanup" | "board_check"; error: string };

/**
 * Remove an incomplete template build without touching a completed board.
 * Template-created desks carry the build id only as cleanup metadata; ordinary
 * deletion of a ready board deliberately leaves those desks/conversations in
 * place, preserving the existing Studio contract.
 */
export async function cleanupTemplateBuild(supabase: AdminClient, boardId: string): Promise<TemplateCleanupResult> {
  const { data: board, error: boardError } = await supabase
    .from("studio_boards")
    .select("status")
    .eq("id", boardId)
    .maybeSingle();
  if (boardError) return { ok: false, stage: "board_check", error: boardError.message };
  if (board?.status === "ready") {
    return { ok: false, stage: "ready_board", error: "Refused cleanup for a ready board" };
  }

  const { error: deskError } = await supabase
    .from("studio_desks")
    .delete()
    .contains("settings", { template_build_id: boardId });
  if (deskError) return { ok: false, stage: "desk_cleanup", error: deskError.message };

  const { error: deleteError } = await supabase
    .from("studio_boards")
    .delete()
    .eq("id", boardId)
    .neq("status", "ready");
  if (deleteError) return { ok: false, stage: "board_cleanup", error: deleteError.message };
  return { ok: true };
}

/** Mirror recent published articles into studio_sources (idempotent by URL). */
type ArticleRow = { id: string; slug: string; title: string | null; body: string | null; view_count: number | null };

const siteBase = () => process.env.NEXT_PUBLIC_DIGITAL_HOME_URL || process.env.DIGITAL_HOME_URL || null;
const siteAuthor = (base: string) => {
  try {
    return new URL(base).hostname.replace(/^www\./, "");
  } catch {
    return "own site";
  }
};

/** One article → one ready studio source (idempotent by URL). */
async function upsertArticleSource(supabase: AdminClient, base: string, a: ArticleRow) {
  const { data, error } = await supabase
    .from("studio_sources")
    .upsert(
      {
        url: `${base}/articles/${a.slug}`,
        platform: "article",
        kind: "own",
        status: "ready",
        title: a.title,
        author: siteAuthor(base),
        transcript: (a.body ?? "").slice(0, 120000),
        engagement: { views: a.view_count ?? null },
        mirrored_from: "content_objects",
        mirror_key: a.id,
        added_by: "mirror",
        refreshed_at: new Date().toISOString(),
      },
      { onConflict: "url" }
    )
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function mirrorArticles(supabase: AdminClient, limit = 3): Promise<string[]> {
  const base = siteBase();
  if (!base) return []; // no site URL configured — nothing to mirror against
  const { data: articles, error } = await supabase
    .from("content_objects")
    .select("id,slug,title,body,view_count")
    .eq("content_type", "article")
    .eq("status", "published")
    .not("body", "is", null)
    .order("published_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  const ids: string[] = [];
  for (const a of articles ?? []) {
    const src = await upsertArticleSource(supabase, base, a);
    if (src) ids.push(src.id);
  }
  return ids;
}

/** Mirror SPECIFIC articles — the canvas article picker's door. Returns full
 *  source rows so cards land ready, no polling. */
export async function mirrorArticlesByIds(supabase: AdminClient, ids: string[]) {
  const base = siteBase();
  if (!base || !ids.length) return [];
  const { data: articles, error } = await supabase
    .from("content_objects")
    .select("id,slug,title,body,view_count")
    .in("id", ids)
    .eq("content_type", "article")
    .eq("status", "published")
    .not("body", "is", null);
  if (error) throw new Error(error.message);
  const out = [];
  for (const a of articles ?? []) {
    const src = await upsertArticleSource(supabase, base, a);
    if (src) out.push(src);
  }
  return out;
}

async function ownVideoSources(supabase: AdminClient, limit = 3): Promise<string[]> {
  const { data, error } = await supabase
    .from("studio_sources")
    .select("id")
    .eq("kind", "own")
    .eq("platform", "youtube")
    .eq("status", "ready")
    .order("published_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map((s) => s.id);
}

/** Build the pre-wired graph for a template onto an existing board. */
export async function applyTemplate(supabase: AdminClient, boardId: string, key: TemplateKey) {
  const nodes: NodeIn[] = [];
  const edges: EdgeIn[] = [];
  const createdDeskIds: string[] = [];
  const makeTemplateDesk = (desk: { name: string; persona?: string; sop: string; settings?: Json }) =>
    makeDesk(supabase, createdDeskIds, boardId, desk);
  const node = (n: Omit<NodeIn, "board_id">) => {
    // Bulk insert sends null for keys missing on some rows — default them all.
    nodes.push({ data: {}, source_id: null, desk_id: null, ...n, board_id: boardId });
    return n.id;
  };
  const wire = (from: string, to: string) => edges.push({ id: uid(), board_id: boardId, from_node: from, to_node: to });

  try {
    // The living ledger: a LIVE group that always expands to the current top
    // own sources by engagement — self-curating, no manual wiring. Falls back
    // to wiring recent own videos when nothing has engagement data yet.
    const voiceIds = await ownVideoSources(supabase);
    const voiceGroup = (x: number, y: number) => {
      const group = node({
        id: uid(),
        kind: "group",
        position: { x, y },
        data: { label: "My best performers — live", auto: "best_performers" },
      });
      voiceIds.forEach((sid, i) => {
        const s = node({ id: uid(), kind: "source", position: { x: x - 340, y: y - 100 + i * 200 }, source_id: sid });
        wire(s, group);
      });
      return group;
    };

  if (key === "youtube-video") {
    const idea = node({
      id: uid(), kind: "note", position: { x: 0, y: 40 },
      data: { text: "VIDEO IDEA — replace with your idea, one or two sentences." },
    });
    node({
      id: uid(), kind: "note", position: { x: 0, y: 240 },
      data: { text: "RESEARCH FUEL — paste competitor/topic videos onto the canvas (Cmd+V) and wire them into the Research desk. The Research desk can also search the live web on its own." },
    });
    const group = voiceGroup(560, 520);
    const research = node({
      id: uid(), kind: "desk", position: { x: 900, y: 40 },
      desk_id: await makeTemplateDesk({
        name: "Research desk",
        sop: "Deep-research the video idea. Search the live web for what's already ranking and being said on this topic. Deliver: 1) the audience and their pain in their own words, 2) proven angles others used and what they missed, 3) ONE recommended angle with the reason, 4) 5 points the video must cover. Cite sources.",
        settings: { web_search: true },
      }),
    });
    const packaging = node({
      id: uid(), kind: "desk", position: { x: 900, y: 280 },
      desk_id: await makeTemplateDesk({
        name: "Packaging desk", persona: "beacon",
        sop: "10 title options (curiosity, outcome, contrarian mixes), top 2 marked with reasons, then 3 thumbnail concepts (composition + max 3 words on-image). Judge against what worked in the wired own-videos.",
        settings: { creative_format: "youtube_thumbnail" },
      }),
    });
    const script = node({
      id: uid(), kind: "desk", position: { x: 900, y: 520 },
      desk_id: await makeTemplateDesk({
        name: "Script desk", persona: "content-manager",
        sop: "Write in the owner's voice from the wired own-videos: plain, direct, no hype. Deliver: HOOK (first 15s verbatim), the first 60 seconds verbatim, then a beat sheet. Open on pain or the contrarian claim, never a greeting.",
      }),
    });
    for (const d of [research, packaging, script]) wire(idea, d);
    wire(group, packaging);
    wire(group, script);
  }

  if (key === "article-multiplication") {
    const articleIds = await mirrorArticles(supabase);
    const group = node({ id: uid(), kind: "group", position: { x: 340, y: 160 }, data: { label: "Articles from the site" } });
    articleIds.forEach((sid, i) => {
      const s = node({ id: uid(), kind: "source", position: { x: 0, y: 40 + i * 200 }, source_id: sid });
      wire(s, group);
    });
    const voice = voiceGroup(340, 640);
    const carousel = node({
      id: uid(), kind: "desk", position: { x: 700, y: 40 },
      desk_id: await makeTemplateDesk({
        name: "Carousel desk", persona: "content-manager",
        sop: "Turn ONE wired article into an Instagram carousel: exactly 10 slides, slide 1 is a scroll-stopping hook, one idea per slide, and slide 10 is a soft CTA. Output slide-by-slide text plus a caption. File the finished concept through the configured Studio carousel renderer; HOUSE Content Manager is the portable default, and the optional factory is used only when it was explicitly selected and installed.",
      }),
    });
    const reels = node({
      id: uid(), kind: "desk", position: { x: 700, y: 280 },
      desk_id: await makeTemplateDesk({
        name: "Reels desk", persona: "content-manager",
        sop: "Turn ONE wired article into three 30-second reel scripts: HOOK (first 2s) / 3 value beats / soft CTA, plus text-overlay suggestions. Owner's voice from the wired own-videos.",
      }),
    });
    const email = node({
      id: uid(), kind: "desk", position: { x: 700, y: 520 },
      desk_id: await makeTemplateDesk({
        name: "Email desk", persona: "content-manager",
        sop: "Turn ONE wired article into a short promo email for the list: subject line options (3), 120-180 words, one link CTA. Educate first, sell softly.",
      }),
    });
    for (const d of [carousel, reels, email]) {
      wire(group, d);
      wire(voice, d);
    }
  }

  if (key === "model-a-reel") {
    node({
      id: uid(), kind: "note", position: { x: 0, y: 40 },
      data: { text: "SWIPE — paste the competitor reel/short you want to model (Cmd+V), wait for green, wire it into the desk. Add a note on WHY you saved it." },
    });
    const voice = voiceGroup(340, 380);
    const model = node({
      id: uid(), kind: "desk", position: { x: 700, y: 200 },
      desk_id: await makeTemplateDesk({
        name: "Model-it desk", persona: "content-manager",
        sop: "Given a competitor reel: name its hook mechanism and structure beats, then write ONE new 30-second script keeping the structure but swapping in the owner's topic and voice (from the wired own-videos). Never copy lines. Deliver: WHY IT WORKED / HOOK / BEATS / CTA / overlays / shot list.",
      }),
    });
    wire(voice, model);
  }

    if (nodes.length) {
      const { error } = await supabase.from("studio_nodes").insert(nodes);
      if (error) throw new Error(error.message);
    }
    if (edges.length) {
      const { error } = await supabase.from("studio_edges").insert(edges);
      if (error) throw new Error(error.message);
    }
  } catch (error) {
    // Board creation is all-or-nothing to the member. Nodes and wires are
    // removed by the board route's compensating delete; desks do not carry a
    // board_id, so clean those up here before propagating the failure.
    if (createdDeskIds.length) {
      const { error: cleanupError } = await supabase.from("studio_desks").delete().in("id", createdDeskIds);
      if (cleanupError) {
        throw new Error(`${(error as Error).message}; desk cleanup also failed: ${cleanupError.message}`);
      }
    }
    throw error;
  }
}
