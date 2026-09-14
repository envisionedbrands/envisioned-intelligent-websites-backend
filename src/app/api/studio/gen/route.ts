/**
 * Studio creative generation (fal.ai) — the ad/graphics lane.
 *
 * POST { board_id, desk_node_id, prompt, mode: "reference"|"fresh", count? }
 *   → queues a studio_gen_jobs row for the local runner. In "reference" mode
 *     the server walks the desk's wired sources and passes their thumbnails
 *     to fal as style references (the factory's reference-faithful contract:
 *     GPT Image 2 edit replicates the reference format and renders the exact
 *     copy on-image). Spending is gated in the UI with an explicit confirm.
 * GET ?board_id= → the board's gen jobs (canvas polling + on-load recovery).
 */
import { NextRequest, NextResponse } from "next/server";
import { studioAuth } from "@/lib/studio/auth";
import {
  CREATIVE_FORMATS,
  isCreativeFormatKey,
  resolveCreativeImageSize,
  type CreativeFormatKey,
} from "@/lib/studio/creative-formats";
import { createAdminClient } from "@/lib/supabase/server";
import { isUploadedImageUrl } from "@/lib/studio/uploads";
import { refineCreativePrompts } from "@/lib/studio/gen-prompt";
import {
  readExactStudioMatchBatches,
  readExactStudioPages,
} from "@/lib/studio/query-integrity";
import { studioRunnerFailureMessage } from "@/lib/studio/runner-health";
import { expectedStudioRunnerInstanceId } from "@/lib/studio/runner-server-identity";

const MODELS: Record<string, string> = {
  reference: "openai/gpt-image-2/edit",
  fresh: "openai/gpt-image-2",
};

const GEN_VIEW_FIELDS = "id,desk_node_id,prompt,model,asset_type,image_size,count,status,stage,results,error,dismissed,materialized_at,created_at";
const GEN_PAGE_SIZE = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type GenViewRow = {
  id: string;
  desk_node_id: string | null;
  prompt: string;
  model: string;
  asset_type: string;
  image_size: unknown;
  count: number;
  status: string;
  stage: string;
  results: unknown;
  error: string | null;
  dismissed: boolean;
  materialized_at: string | null;
  created_at: string;
};

type GenJobStatus =
  | "queued"
  | "claimed"
  | "generating"
  | "ready"
  | "failed"
  | "submission_unknown"
  | "cancelled";

type GenGraphNode = {
  id: string;
  kind: string;
  source_id: string | null;
  data: { image_url?: unknown } | null;
};

type GenGraphEdge = {
  id: string;
  from_node: string;
  to_node: string;
};

type GenReferenceSource = {
  id: string;
  thumbnail: string | null;
  url: string;
  platform: string;
};

async function fetchGenJobPages(
  supabase: ReturnType<typeof createAdminClient>,
  boardId: string,
  statuses: readonly GenJobStatus[],
  { pendingMaterialization = false } = {},
) {
  const rows: GenViewRow[] = [];
  const returnedIds = new Set<string>();
  let expectedCount: number | null = null;
  for (let offset = 0; ; offset += GEN_PAGE_SIZE) {
    let query = supabase
      .from("studio_gen_jobs")
      .select(GEN_VIEW_FIELDS, { count: "exact" })
      .eq("board_id", boardId)
      .in("status", statuses)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    if (pendingMaterialization) query = query.eq("dismissed", false).is("materialized_at", null);
    const { data, error, count } = await query.range(offset, offset + GEN_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    if (count == null) throw new Error("Generation query did not return an exact count");
    if (expectedCount == null) expectedCount = count;
    else if (count !== expectedCount) throw new Error("Generation jobs changed while they were being read; retry");
    for (const row of (data ?? []) as GenViewRow[]) {
      if (returnedIds.has(row.id)) throw new Error("Generation query returned a duplicate page row");
      returnedIds.add(row.id);
      rows.push(row);
    }
    if (rows.length === expectedCount) break;
    if (rows.length > expectedCount) throw new Error("Generation query exceeded its exact count");
    if (!data?.length) throw new Error("Generation query ended before its exact count");
  }
  return rows;
}

export async function POST(request: NextRequest) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });

  const body = (await request.json().catch(() => null)) as
    | {
        board_id?: string;
        desk_node_id?: string;
        prompt?: string;
        mode?: string;
        count?: number;
        split?: boolean;
        asset_type?: string;
        width?: number;
        height?: number;
      }
    | null;
  if (!body?.board_id || !body.prompt?.trim()) {
    return NextResponse.json({ error: "board_id and prompt required" }, { status: 400 });
  }
  const mode = body.mode === "fresh" ? "fresh" : "reference";
  const assetType: CreativeFormatKey = isCreativeFormatKey(body.asset_type) ? body.asset_type : "match_reference";
  const { imageSize, error: imageSizeError } = resolveCreativeImageSize(assetType, {
    width: body.width,
    height: body.height,
  });
  if (imageSizeError) return NextResponse.json({ error: imageSizeError }, { status: 400 });
  const supabase = createAdminClient();
  let expectedRunnerInstance: string;
  try {
    expectedRunnerInstance = await expectedStudioRunnerInstanceId(request.url);
  } catch {
    return NextResponse.json({
      code: "runner_identity_unavailable",
      error: "Studio runner identity is not configured. Deploy the complete 1.6.3 backend and rerun runner setup before image generation.",
    }, { status: 503 });
  }

  // A recent runner receipt can prove that fal is not connected. Fail before
  // prompt refinement or queue insertion so the member neither spends Claude
  // tokens nor waits on a job that cannot run. Missing/stale health remains
  // unknown and therefore never falsely disables an older installation.
  const { data: runnerHealth, error: runnerHealthError } = await supabase
    .from("studio_runner_health")
    .select("status,failure_code,capabilities,last_seen_at")
    .eq("instance_id", expectedRunnerInstance)
    .order("last_seen_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (runnerHealthError) {
    return NextResponse.json({
      code: "runner_health_unavailable",
      error: "Studio runner health is unavailable. Deploy the complete 1.6.3 backend before image generation.",
    }, { status: 503 });
  }
  const capabilities = runnerHealth?.capabilities && typeof runnerHealth.capabilities === "object"
    ? runnerHealth.capabilities as Record<string, unknown>
    : null;
  const healthIsFresh = runnerHealth?.last_seen_at
    ? Date.now() - new Date(runnerHealth.last_seen_at).getTime() <= 2 * 60_000
    : false;
  if (
    runnerHealth?.status === "blocked"
    && runnerHealth.failure_code !== "carousel_toolchain_unavailable"
  ) {
    return NextResponse.json({
      code: runnerHealth.failure_code ?? "runner_blocked",
      error: studioRunnerFailureMessage(runnerHealth.failure_code)
        ?? "Studio’s local runner needs setup before image generation can start.",
    }, { status: 503 });
  }
  if (healthIsFresh && capabilities?.fal_ready === false) {
    const connected = capabilities?.fal_configured === true;
    return NextResponse.json({
      code: connected ? "fal_not_verified" : "fal_not_configured",
      error: connected
        ? "The fal key could not be verified. Ask your setup agent to reconnect fal, then try again."
        : "Image generation isn’t connected. Ask your setup agent to connect fal, then try again.",
    }, { status: 503 });
  }

  // Collect reference thumbnails from sources wired into the desk node.
  let referenceUrls: string[] = [];
  if (mode === "reference" && body.desk_node_id) {
    const [nodes, edges] = await Promise.all([
      readExactStudioPages<GenGraphNode>(async (from, to) => {
        const { data, error, count } = await supabase
          .from("studio_nodes")
          .select("id,kind,source_id,data", { count: "exact" })
          .eq("board_id", body.board_id!)
          .order("id", { ascending: true })
          .range(from, to);
        return { data: data as GenGraphNode[] | null, error, count };
      }),
      readExactStudioPages<GenGraphEdge>(async (from, to) => {
        const { data, error, count } = await supabase
          .from("studio_edges")
          .select("id,from_node,to_node", { count: "exact" })
          .eq("board_id", body.board_id!)
          .order("id", { ascending: true })
          .range(from, to);
        return { data: data as GenGraphEdge[] | null, error, count };
      }),
    ]);

    if (!nodes || !edges) {
      return NextResponse.json(
        { error: "This board's visual references could not be read completely. Please try again." },
        { status: 503 },
      );
    }

    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const incomingByTarget = new Map<string, GenGraphNode[]>();
    for (const edge of edges) {
      const sourceNode = nodeById.get(edge.from_node);
      if (!sourceNode) continue;
      const incoming = incomingByTarget.get(edge.to_node) ?? [];
      incoming.push(sourceNode);
      incomingByTarget.set(edge.to_node, incoming);
    }
    const incoming = (targetId: string) => incomingByTarget.get(targetId) ?? [];
    const sourceIds = new Set<string>();
    for (const direct of incoming(body.desk_node_id)) {
      if (direct.kind === "source" && direct.source_id) sourceIds.add(direct.source_id);
      else if (direct.kind === "group") {
        for (const inner of incoming(direct.id)) {
          if (inner.kind === "source" && inner.source_id) sourceIds.add(inner.source_id);
        }
      }
    }

    if (sourceIds.size) {
      const sources = await readExactStudioMatchBatches<GenReferenceSource>(
        [...sourceIds],
        async (batch) => {
          const { data, error, count } = await supabase
            .from("studio_sources")
            .select("id,thumbnail,url,platform", { count: "exact" })
            .in("id", batch)
            .order("id", { ascending: true })
            .range(0, batch.length - 1);
          return { data: data as GenReferenceSource[] | null, error, count };
        },
      );
      if (!sources) {
        return NextResponse.json(
          { error: "This board's visual references could not be read completely. Please try again." },
          { status: 503 },
        );
      }
      // Uploaded images go to fal at FULL resolution (their url IS the file);
      // scraped sources contribute their captured thumbnail.
      referenceUrls = sources
        .map((s) => (s.platform === "upload" && isUploadedImageUrl(s.url) ? s.url : s.thumbnail))
        .filter((u): u is string => !!u);
    }
    // Wired creative nodes count as references too — wire a winning
    // generation back into the desk to lock its style for the next round.
    for (const direct of incoming(body.desk_node_id)) {
      const imageUrl = direct.data?.image_url;
      if (direct.kind === "creative" && typeof imageUrl === "string" && imageUrl) {
        referenceUrls.push(imageUrl);
      }
    }
    referenceUrls = referenceUrls.slice(0, 4);
    if (!referenceUrls.length) {
      return NextResponse.json(
        { error: "Reference mode needs at least one wired source with an image. Wire a visual reference into this desk, or use fresh mode." },
        { status: 400 }
      );
    }
  }

  // Prompt refinement — ALWAYS. Desk replies are conversations: they carry
  // meta-chatter ("Want me to write the hook? Say the word") and sometimes
  // several distinct visual concepts. Sending them raw makes tacky images.
  // Claude rewrites the reply into polished factory-contract prompt(s):
  // conversational text stripped, concept expanded into real composition
  // detail, on-image copy stated exactly. `split` controls whether multiple
  // concepts become multiple jobs or everything collapses into one prompt.
  const creativeFormat = CREATIVE_FORMATS[assetType];
  const prompts = await refineCreativePrompts({
    apiKey: process.env.ANTHROPIC_API_KEY,
    prompt: body.prompt,
    split: body.split === true,
    formatLabel: creativeFormat.label,
    formatDetail: creativeFormat.detail,
  });

  const rows = prompts.map((p) => ({
    board_id: body.board_id!,
    desk_node_id: body.desk_node_id ?? null,
    prompt: p.label ? `[${p.label}] ${p.prompt}` : p.prompt,
    model: MODELS[mode],
    asset_type: assetType,
    image_size: imageSize,
    reference_urls: referenceUrls,
    count: prompts.length > 1 ? 1 : Math.max(1, Math.min(4, body.count ?? 1)),
  }));
  const { data: jobs, error } = await supabase.from("studio_gen_jobs").insert(rows).select("*");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ jobs, job: jobs?.[0] });
}

export async function GET(request: NextRequest) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });
  const boardId = request.nextUrl.searchParams.get("board_id");
  if (!boardId) return NextResponse.json({ error: "board_id required" }, { status: 400 });

  const supabase = createAdminClient();
  try {
    const [active, terminal] = await Promise.all([
      fetchGenJobPages(supabase, boardId, ["queued", "claimed", "generating"]),
      fetchGenJobPages(supabase, boardId, ["ready", "failed", "submission_unknown"], {
        pendingMaterialization: true,
      }),
    ]);
    const byId = new Map([...active, ...terminal].map((job) => [job.id, job]));
    const jobs = [...byId.values()].sort((a, b) =>
      b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    return NextResponse.json({ jobs });
  } catch {
    return NextResponse.json({ error: "Generation jobs could not be read completely. Retry this board." }, { status: 503 });
  }
}

/** PATCH { id, dismissed } — deleting a creative card dismisses its job so
 *  recovery never resurrects it on the canvas. */
export async function PATCH(request: NextRequest) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });
  const body = (await request.json().catch(() => null)) as {
    id?: string;
    dismissed?: boolean;
    board_id?: string;
    materialized_ids?: string[];
  } | null;
  if (body?.board_id && Array.isArray(body.materialized_ids)) {
    const ids = [...new Set(body.materialized_ids)].filter((id) => UUID.test(id));
    if (!UUID.test(body.board_id) || ids.length !== body.materialized_ids.length || ids.length > 100) {
      return NextResponse.json({ error: "Invalid materialization receipt" }, { status: 400 });
    }
    if (!ids.length) return NextResponse.json({ ok: true });
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("studio_gen_jobs")
      .update({ materialized_at: new Date().toISOString() })
      .eq("board_id", body.board_id)
      .eq("dismissed", false)
      .in("status", ["ready", "failed", "submission_unknown"])
      .in("id", ids)
      .select("id");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if ((data?.length ?? 0) !== ids.length) {
      return NextResponse.json({ error: "Some generation receipts changed before acknowledgement; retry" }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  }
  if (!body?.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const supabase = createAdminClient();
  const dismissed = body.dismissed ?? true;
  if (dismissed) {
    // This CAS is the spend boundary. If deletion wins while the job is still
    // queued/claimed, the runner can never move it to generating. If the
    // runner's generating CAS wins first, submission was already authorized;
    // dismissal then only prevents the paid result from reappearing.
    const { error: cancelError } = await supabase
      .from("studio_gen_jobs")
      .update({
        dismissed: true,
        status: "cancelled",
        stage: "Dismissed before generation",
        completed_at: new Date().toISOString(),
      })
      .eq("id", body.id)
      .in("status", ["queued", "claimed"]);
    if (cancelError) return NextResponse.json({ error: cancelError.message }, { status: 500 });
  }
  const { error } = await supabase
    .from("studio_gen_jobs")
    .update({ dismissed })
    .eq("id", body.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
