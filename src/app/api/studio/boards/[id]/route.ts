/**
 * GET    /api/studio/boards/:id — board + nodes + edges + referenced desks/sources.
 * PATCH  /api/studio/boards/:id — { name?, viewport? }.
 * PUT    /api/studio/boards/:id — full graph save { nodes, edges, viewport? }
 *        (single-operator autosave: upsert everything sent, delete the rest).
 * DELETE /api/studio/boards/:id
 */
import { NextRequest, NextResponse } from "next/server";
import { studioAuth } from "@/lib/studio/auth";
import { createAdminClient } from "@/lib/supabase/server";
import {
  presentIngestJob,
  type IngestJobSummaryRow,
} from "@/lib/studio/ingest-errors";
import {
  chunkStudioQueryIds,
  isExactStudioQueryMatch,
  isExactStudioQuerySubset,
} from "@/lib/studio/query-integrity";
import { MAX_STUDIO_CONTEXT_TEXT_CHARS, validateStudioContextTextSave } from "@/lib/studio/text-limits";
import type { Json } from "@/types/database";

type Ctx = { params: Promise<{ id: string }> };

type QueryFailure = { message: string } | null;
type ExactQueryResult<Row> = { data: Row[] | null; error: QueryFailure; count: number | null };
type UntypedRpcClient = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};
type AtomicBoardSaveResult = {
  state?: "saved" | "conflict" | "not_found" | "invalid_payload" | "foreign_node" | "foreign_edge";
  board_id?: string;
  graph_revision?: number;
  current_revision?: number;
  node_count?: number;
  edge_count?: number;
};

async function readExactSubsetBatches<Row extends { id: string }>(
  ids: readonly string[],
  fetchBatch: (ids: string[]) => Promise<ExactQueryResult<Row>>,
): Promise<{ rows: Row[]; complete: true } | { rows: []; complete: false }> {
  const rows: Row[] = [];
  const returnedIds = new Set<string>();
  for (const batch of chunkStudioQueryIds(ids)) {
    const result = await fetchBatch(batch);
    if (result.error || !isExactStudioQuerySubset(batch, result.data, result.count)) {
      return { rows: [], complete: false };
    }
    for (const row of result.data) {
      if (returnedIds.has(row.id)) return { rows: [], complete: false };
      returnedIds.add(row.id);
      rows.push(row);
    }
  }
  return { rows, complete: true };
}

async function readExactMatchBatches<Row extends { id: string }>(
  ids: readonly string[],
  fetchBatch: (ids: string[]) => Promise<ExactQueryResult<Row>>,
): Promise<{ rows: Row[]; complete: true } | { rows: []; complete: false }> {
  const rows: Row[] = [];
  for (const batch of chunkStudioQueryIds(ids)) {
    const result = await fetchBatch(batch);
    if (result.error || !isExactStudioQueryMatch(batch, result.data, result.count)) {
      return { rows: [], complete: false };
    }
    rows.push(...result.data);
  }
  return { rows, complete: true };
}

type BoardSnapshotSource = Record<string, unknown> & {
  id: string;
  status: string;
  latest_job?: IngestJobSummaryRow | null;
};
type BoardSnapshotDesk = Record<string, unknown> & { id: string };
type BoardSnapshot = {
  state?: "ready" | "not_found";
  board?: Record<string, unknown>;
  nodes?: Record<string, unknown>[];
  edges?: Record<string, unknown>[];
  sources?: BoardSnapshotSource[];
  desks?: BoardSnapshotDesk[];
  previews?: { desk_id: string; content: string }[];
  runner_working?: boolean;
  counts?: { nodes?: number; edges?: number };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

function validBoardSnapshot(value: unknown, boardId: string): value is BoardSnapshot & {
  state: "ready";
  board: Record<string, unknown>;
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
  sources: BoardSnapshotSource[];
  desks: BoardSnapshotDesk[];
  previews: { desk_id: string; content: string }[];
  runner_working: boolean;
  counts: { nodes: number; edges: number };
} {
  if (!isRecord(value) || value.state !== "ready" || !isRecord(value.board)) return false;
  const snapshot = value as BoardSnapshot;
  if (value.board.id !== boardId || value.board.status !== "ready") return false;
  const counts = snapshot.counts;
  if (
    !Array.isArray(snapshot.nodes)
    || !Array.isArray(snapshot.edges)
    || !Array.isArray(snapshot.sources)
    || !Array.isArray(snapshot.desks)
    || !Array.isArray(snapshot.previews)
    || typeof snapshot.runner_working !== "boolean"
    || !isRecord(counts)
  ) return false;
  const nodeCount = counts.nodes;
  const edgeCount = counts.edges;
  if (
    typeof nodeCount !== "number"
    || typeof edgeCount !== "number"
    || !Number.isSafeInteger(nodeCount)
    || !Number.isSafeInteger(edgeCount)
    || nodeCount !== snapshot.nodes.length
    || edgeCount !== snapshot.edges.length
  ) return false;
  if (!snapshot.sources.every((source) => isRecord(source) && typeof source.id === "string" && typeof source.status === "string")) {
    return false;
  }
  if (!snapshot.desks.every((desk) => isRecord(desk) && typeof desk.id === "string")) return false;
  return snapshot.previews.every(
    (preview) => isRecord(preview) && typeof preview.desk_id === "string" && typeof preview.content === "string",
  );
}

export async function GET(request: NextRequest, { params }: Ctx) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });
  const { id } = await params;
  const supabase = createAdminClient();

  const { data, error } = await (supabase as unknown as UntypedRpcClient).rpc(
    "studio_read_board_snapshot",
    { p_board_id: id },
  );
  if (error) {
    return NextResponse.json(
      { error: "This board could not be read completely. Please try again." },
      { status: 503 },
    );
  }
  if (isRecord(data) && data.state === "not_found") {
    return NextResponse.json({ error: "Board not found" }, { status: 404 });
  }
  if (!validBoardSnapshot(data, id)) {
    return NextResponse.json(
      { error: "This board could not be read completely. Please try again." },
      { status: 503 },
    );
  }

  const { board, nodes, edges } = data;

  // Failed cards must retain their safe diagnosis and Retry action after a
  // reload; pending cards also need their real queue state immediately.
  let sourcesOut: Record<string, unknown>[] = data.sources;
  const jobSourceIds = sourcesOut
    .filter((source) => source.status === "pending" || source.status === "ingesting" || source.status === "failed")
    .map((source) => source.id as string);
  if (jobSourceIds.length) {
    sourcesOut = sourcesOut.map((source) => {
      const { latest_job: latestJob, ...cleanSource } = source as BoardSnapshotSource;
      return {
        ...cleanSource,
        ...(cleanSource.status !== "ready" && latestJob?.status === "failed"
          ? { status: "failed" }
          : {}),
        job: latestJob ? presentIngestJob(latestJob, data.runner_working) : null,
      };
    });
  } else {
    sourcesOut = sourcesOut.map((source) => {
      const cleanSource = { ...source };
      delete cleanSource.latest_job;
      return cleanSource;
    });
  }

  // Attach each desk's latest reply as a canvas preview (Poppy-style glance).
  let desksOut = data.desks;
  if (desksOut.length) {
    const requested = new Set(desksOut.map((desk) => desk.id));
    const seen = new Set<string>();
    const latest: Record<string, string> = {};
    for (const m of data.previews) {
      if (!requested.has(m.desk_id) || seen.has(m.desk_id)) {
        return NextResponse.json(
          { error: "This board's desk previews could not be read. Please try again." },
          { status: 503 },
        );
      }
      seen.add(m.desk_id);
      if (!latest[m.desk_id]) latest[m.desk_id] = m.content.replace(/[#*_`>]/g, "").slice(0, 180);
    }
    desksOut = desksOut.map((d) => ({ ...d, preview: latest[d.id] ?? null }));
  }

  return NextResponse.json({ board, nodes, edges, sources: sourcesOut, desks: desksOut });
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as { name?: string; viewport?: Json } | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const update: Record<string, Json | string> = {};
  if (body.name?.trim()) update.name = body.name.trim();
  if (body.viewport !== undefined) update.viewport = body.viewport;
  if (!Object.keys(update).length) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("studio_boards")
    .update(update)
    .eq("id", id)
    .eq("status", "ready")
    .select("id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Board not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

type GraphNodeIn = {
  id: string;
  kind: string;
  parent_id?: string | null;
  position: Json;
  data?: Json;
  source_id?: string | null;
  desk_id?: string | null;
};
type GraphEdgeIn = { id: string; from_node: string; to_node: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NODE_KINDS = new Set(["source", "desk", "note", "sop", "group", "output", "creative"]);

function validateGraph(nodes: GraphNodeIn[], edges: GraphEdgeIn[]): string | null {
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (!UUID.test(node.id)) return "Every node must have a valid id";
    if (nodeIds.has(node.id)) return "The board contains a duplicate node id";
    if (!NODE_KINDS.has(node.kind)) return `Unsupported node kind: ${node.kind}`;
    nodeIds.add(node.id);
  }
  for (const node of nodes) {
    if (node.parent_id && !nodeIds.has(node.parent_id)) {
      return "A parent group points to a node that is not on this board";
    }
  }

  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (!UUID.test(edge.id)) return "Every wire must have a valid id";
    if (edgeIds.has(edge.id)) return "The board contains a duplicate wire id";
    if (!nodeIds.has(edge.from_node) || !nodeIds.has(edge.to_node)) {
      return "A wire points to a node that is not on this board";
    }
    edgeIds.add(edge.id);
  }
  return null;
}

const contextNodeText = (data: Json | undefined): unknown =>
  data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, Json | undefined>).text
    : undefined;

export async function PUT(request: NextRequest, { params }: Ctx) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as
    | { nodes?: GraphNodeIn[]; edges?: GraphEdgeIn[]; viewport?: Json; expected_revision?: number }
    | null;
  if (!body || !Array.isArray(body.nodes) || !Array.isArray(body.edges)) {
    return NextResponse.json({ error: "nodes[] and edges[] required" }, { status: 400 });
  }
  if (!Number.isSafeInteger(body.expected_revision) || Number(body.expected_revision) < 0) {
    return NextResponse.json(
      {
        error: "This board was opened before the atomic-save upgrade. Reload it once before saving.",
        code: "studio_board_revision_required",
      },
      { status: 409 },
    );
  }

  const graphError = validateGraph(body.nodes, body.edges);
  if (graphError) return NextResponse.json({ error: graphError }, { status: 400 });

  const supabase = createAdminClient();
  const { data: board, error: boardError } = await supabase
    .from("studio_boards")
    .select("id,graph_revision")
    .eq("id", id)
    .eq("status", "ready")
    .maybeSingle();
  if (boardError) return NextResponse.json({ error: "This board could not be verified. Please try again." }, { status: 503 });
  if (!board) return NextResponse.json({ error: "Board not found" }, { status: 404 });
  if (board.graph_revision !== body.expected_revision) {
    return NextResponse.json(
      {
        error: "This board changed after it was opened. Reload it before saving so another tab's work is not overwritten.",
        code: "studio_board_revision_conflict",
        current_revision: board.graph_revision,
      },
      { status: 409 },
    );
  }

  // Node and wire ids are globally unique in Postgres. A stale canvas must
  // never be allowed to upsert an id that belongs to another board, which
  // would silently move that row across board boundaries.
  const incomingNodeIds = body.nodes.map((node) => node.id);
  const incomingEdgeIds = body.edges.map((edge) => edge.id);
  type OwnershipRow = { id: string; board_id: string };
  const [ownedNodesRead, ownedEdgesRead] = await Promise.all([
    readExactSubsetBatches<OwnershipRow>(incomingNodeIds, async (batch) => {
      const result = await supabase
        .from("studio_nodes")
        .select("id,board_id", { count: "exact" })
        .in("id", batch)
        .range(0, batch.length - 1);
      return result;
    }),
    readExactSubsetBatches<OwnershipRow>(incomingEdgeIds, async (batch) => {
      const result = await supabase
        .from("studio_edges")
        .select("id,board_id", { count: "exact" })
        .in("id", batch)
        .range(0, batch.length - 1);
      return result;
    }),
  ]);
  if (!ownedNodesRead.complete || !ownedEdgesRead.complete) {
    return NextResponse.json({ error: "This board could not be verified before saving. Please try again." }, { status: 503 });
  }
  const ownedNodes = ownedNodesRead.rows;
  const ownedEdges = ownedEdgesRead.rows;
  if (
    ownedNodes.some((row) => row.board_id !== id) ||
    ownedEdges.some((row) => row.board_id !== id)
  ) {
    return NextResponse.json(
      { error: "This canvas contains data from another board. Reload this board before saving again." },
      { status: 409 }
    );
  }

  // A board PUT contains the whole graph. Older Homes may already contain a
  // note or Instructions card above today's limit; an unrelated move or wire
  // must not brick that board. Grandfather only byte-identical saved text.
  // New or edited oversized text is rejected before any graph write, so the
  // browser and server still confirm the exact same graph with no truncation.
  type PersistedContextNode = OwnershipRow & { kind: string; data: Json };
  const ownedNodeIds = new Set(ownedNodes.map((row) => row.id));
  const persistedContextIds = body.nodes
    .filter((node) => {
      if ((node.kind !== "note" && node.kind !== "sop") || !ownedNodeIds.has(node.id)) return false;
      const text = contextNodeText(node.data);
      return typeof text === "string" && text.length > MAX_STUDIO_CONTEXT_TEXT_CHARS;
    })
    .map((node) => node.id);
  const persistedContextRead = await readExactMatchBatches<PersistedContextNode>(
    persistedContextIds,
    async (batch) => {
      const result = await supabase
        .from("studio_nodes")
        .select("id,board_id,kind,data", { count: "exact" })
        .in("id", batch)
        .range(0, batch.length - 1);
      return result;
    },
  );
  if (!persistedContextRead.complete || persistedContextRead.rows.some((row) => row.board_id !== id)) {
    return NextResponse.json({ error: "This board could not be verified before saving. Please try again." }, { status: 503 });
  }

  const persistedNodes = new Map(persistedContextRead.rows.map((row) => [row.id, row]));
  let legacyTextPreserved = 0;
  for (const node of body.nodes) {
    if (node.kind !== "note" && node.kind !== "sop") continue;
    const persisted = persistedNodes.get(node.id);
    const decision = validateStudioContextTextSave(
      contextNodeText(node.data),
      node.kind === "sop" ? "Instructions" : "Note",
      persisted?.kind === node.kind ? contextNodeText(persisted.data) : undefined,
    );
    if (!decision.ok) {
      return NextResponse.json(
        { error: decision.error, code: decision.code },
        { status: decision.status },
      );
    }
    if (decision.legacyPreserved) legacyTextPreserved++;
  }

  // One RPC, one Postgres transaction. If any node, edge, cleanup, or viewport
  // statement fails, none of them commit and this browser's recovery base stays
  // valid. The row lock + expected revision also prevents two tabs from
  // silently replacing one another.
  const { data: saveData, error: saveError } = await (supabase as unknown as UntypedRpcClient).rpc(
    "studio_save_board_graph",
    {
      p_board_id: id,
      p_expected_revision: body.expected_revision,
      p_nodes: body.nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        parent_id: node.parent_id ?? null,
        position: node.position,
        data: node.data ?? {},
        source_id: node.source_id ?? null,
        desk_id: node.desk_id ?? null,
      })),
      p_edges: body.edges,
      p_viewport: body.viewport ?? null,
      p_has_viewport: body.viewport !== undefined,
    },
  );
  if (saveError) {
    return NextResponse.json(
      { error: "The atomic board save failed. No part of this graph was committed; please try again." },
      { status: 503 },
    );
  }
  const saved = (saveData ?? {}) as AtomicBoardSaveResult;
  if (saved.state === "conflict") {
    return NextResponse.json(
      {
        error: "This board changed after it was opened. Reload it before saving so another tab's work is not overwritten.",
        code: "studio_board_revision_conflict",
        current_revision: saved.current_revision,
      },
      { status: 409 },
    );
  }
  if (saved.state === "not_found") return NextResponse.json({ error: "Board not found" }, { status: 404 });
  if (saved.state === "invalid_payload") return NextResponse.json({ error: "Invalid board graph" }, { status: 400 });
  if (saved.state === "foreign_node" || saved.state === "foreign_edge") {
    return NextResponse.json(
      { error: "This canvas contains data from another board. Reload this board before saving again." },
      { status: 409 },
    );
  }
  if (
    saved.state !== "saved"
    || saved.board_id !== id
    || saved.node_count !== body.nodes.length
    || saved.edge_count !== body.edges.length
    || !Number.isSafeInteger(saved.graph_revision)
    || Number(saved.graph_revision) !== Number(body.expected_revision) + 1
  ) {
    return NextResponse.json(
      { error: "The database did not confirm the complete atomic board save. Please try again." },
      { status: 503 },
    );
  }

  return NextResponse.json({
    ok: true,
    board_id: id,
    graph_revision: saved.graph_revision,
    node_count: saved.node_count,
    edge_count: saved.edge_count,
    legacy_text_preserved: legacyTextPreserved,
  });
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });
  const { id } = await params;
  const supabase = createAdminClient();
  const { error } = await supabase.from("studio_boards").delete().eq("id", id).eq("status", "ready");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
