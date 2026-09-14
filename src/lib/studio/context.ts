/**
 * Studio context assembler — the edge-walk that gives a desk its knowledge.
 *
 * Poppy semantics, kept honest: a desk only knows what is WIRED to it.
 * Incoming edges to the desk node are the context set; a group node expands
 * to everything wired into the group. SOP nodes become standing instructions,
 * note nodes become working notes, source nodes contribute their transcript,
 * analysis, and human annotations — all under a hard token budget surfaced
 * to the UI as the context meter (Poppy's "≤20 hours" lesson, made visible).
 */
import type { createAdminClient } from "@/lib/supabase/server";
import {
  STUDIO_QUERY_PAGE_SIZE,
  chunkStudioQueryIds,
  isExactStudioQueryMatch,
} from "@/lib/studio/query-integrity";
import type { Json } from "@/types/database";

type AdminClient = ReturnType<typeof createAdminClient>;

type GraphNode = {
  id: string;
  kind: string;
  data: Json;
  source_id: string | null;
  desk_id: string | null;
};

type GraphEdge = {
  id: string;
  from_node: string;
  to_node: string;
};

type ExactQueryResult<Row> = {
  data: Row[] | null;
  error: { message: string } | null;
  count: number | null;
};

/**
 * Read a board-owned graph table without trusting PostgREST's response cap.
 * A count change, duplicate id, short page or missing page fails closed so a
 * large board can never be mistaken for an unwired one.
 */
async function readExactContextPages<Row extends { id: string }>(
  fetchPage: (from: number, to: number) => PromiseLike<ExactQueryResult<Row>>,
): Promise<Row[] | null> {
  let expectedCount: number | null = null;
  const rows: Row[] = [];
  const returnedIds = new Set<string>();

  for (let from = 0; ; from += STUDIO_QUERY_PAGE_SIZE) {
    const result = await fetchPage(from, from + STUDIO_QUERY_PAGE_SIZE - 1);
    if (result.error || result.count === null) return null;
    if (expectedCount === null) expectedCount = result.count;
    if (result.count !== expectedCount) return null;

    const page = result.data ?? [];
    for (const row of page) {
      if (returnedIds.has(row.id)) return null;
      returnedIds.add(row.id);
      rows.push(row);
    }

    if (rows.length === expectedCount) return rows;
    if (rows.length > expectedCount || page.length === 0 || page.length < STUDIO_QUERY_PAGE_SIZE) {
      return null;
    }
  }
}

/** Every wired source id must survive an exact, sub-cap batch read. */
async function readExactContextSources<Row extends { id: string }>(
  ids: readonly string[],
  fetchBatch: (ids: string[]) => PromiseLike<ExactQueryResult<Row>>,
): Promise<Row[] | null> {
  const rows: Row[] = [];
  const returnedIds = new Set<string>();
  for (const batch of chunkStudioQueryIds(ids)) {
    const result = await fetchBatch(batch);
    if (result.error || !isExactStudioQueryMatch(batch, result.data, result.count)) return null;
    for (const row of result.data) {
      if (returnedIds.has(row.id)) return null;
      returnedIds.add(row.id);
      rows.push(row);
    }
  }
  return rows;
}

export class DeskContextError extends Error {
  public readonly status: 409 | 503;
  public readonly code: "desk_context_mismatch" | "desk_context_unavailable";

  constructor(
    message: string,
    status: 409 | 503,
    code: "desk_context_mismatch" | "desk_context_unavailable"
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "DeskContextError";
  }
}

const unavailable = (part: string) =>
  new DeskContextError(
    `The desk could not verify its ${part}. Nothing was sent to the writing model. Please try again.`,
    503,
    "desk_context_unavailable"
  );

export type ContextSourceStat = {
  id: string;
  title: string;
  platform: string;
  kind: string;
  tokens: number;
  truncated: boolean;
};

export type AssembledContext = {
  system: string;
  estTokens: number;
  budgetTokens: number;
  sops: number;
  notes: number;
  sopsTruncated: boolean;
  notesTruncated: boolean;
  sources: ContextSourceStat[];
  /** Canvas-wired Instructions card texts (excludes the desk's own box). */
  sopTexts: string[];
  sopTextsTruncated: boolean;
  classTokens: {
    instructions: number;
    auxiliary: number;
    notes: number;
    sources: number;
  };
};

export type StudioChatProvider = "anthropic" | "openrouter";
export type DeskHistoryMessage = { role: "user" | "assistant"; content: string };
export type DeskHistoryRow = {
  id?: string | null;
  role?: string | null;
  content?: string | null;
  created_at?: string | null;
  meta?: unknown;
};

export const STUDIO_CHAT_MAX_OUTPUT_TOKENS = 4_000;
export const STUDIO_CHAT_CONTINUATION_RESERVE_TOKENS = 8_000;
export const STUDIO_CHAT_MAX_CONTINUATION_ROUNDS = 2;
export const STUDIO_CHAT_MAX_HISTORY_TOKENS = 24_000;
export const STUDIO_CHAT_HISTORY_ROW_LIMIT = 20;
export const STUDIO_SOP_PREVIEW_TOKENS = 2_000;
const STUDIO_SOP_PREVIEW_ITEM_TOKENS = 500;
const STUDIO_SOP_PREVIEW_ITEMS = 20;
const STUDIO_CHAT_REQUEST_OVERHEAD_TOKENS = 512;
const STUDIO_CHAT_PROVIDER_SAFETY_TOKENS = 2_000;
const STUDIO_CHAT_MESSAGE_OVERHEAD_TOKENS = 8;

/**
 * A deliberately conservative tokenizer-free estimate. English prose is
 * normally closer to four characters per token; using three, and charging
 * every non-ASCII UTF-16 code unit as two tokens, leaves room for punctuation,
 * JSON, URLs, CJK text, emoji surrogate pairs and other multilingual text
 * without adding a provider tokenizer to every replicated Home.
 */
export function estimateStudioTokens(text: string): number {
  let nonAscii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) nonAscii += 1;
  }
  return Math.ceil((text.length - nonAscii) / 3) + (nonAscii * 2);
}

/** Conservative cost of replaying one structured pause-turn response. */
export function estimateStudioContinuationTokens(content: unknown): number {
  try {
    const serialized = JSON.stringify(content);
    if (!serialized) return STUDIO_CHAT_MESSAGE_OVERHEAD_TOKENS;
    return estimateStudioTokens(serialized) + STUDIO_CHAT_MESSAGE_OVERHEAD_TOKENS;
  } catch {
    // Parsed provider JSON should be serializable. Fail closed if that
    // invariant ever changes rather than replaying unbudgeted content.
    return Number.MAX_SAFE_INTEGER;
  }
}

const providerContextWindowTokens = (provider: StudioChatProvider, model: string) => {
  if (provider === "anthropic") return 200_000;
  const normalized = model.toLowerCase().replace(/:online$/, "");
  // These are intentionally below the providers' advertised windows. The
  // desk itself remains capped at 150k, so exact upstream maxima are neither
  // trusted nor needed for the supported presets.
  if (normalized.startsWith("google/gemini-2.5-")) return 256_000;
  if (normalized.startsWith("anthropic/claude-")) return 200_000;
  // An arbitrary OpenRouter id has no locally verifiable context contract.
  return 64_000;
};

export type DeskRequestBudget = {
  providerContextTokens: number;
  inputCeilingTokens: number;
  outputReserveTokens: number;
  continuationReserveTokens: number;
  requestOverheadTokens: number;
  userMessageTokens: number;
  personaTokens: number;
  historyBudgetTokens: number;
  minimumContextTokens: number;
  userMessageFits: boolean;
};

/** One input envelope for both providers: system + history + current user. */
export function planDeskRequestBudget(opts: {
  deskBudgetTokens?: number | null;
  provider: StudioChatProvider;
  model: string;
  userMessage: string;
  persona?: string;
  continuationRounds?: number;
}): DeskRequestBudget {
  const configured = Number.isFinite(opts.deskBudgetTokens)
    ? Math.max(4_000, Math.min(150_000, Math.floor(Number(opts.deskBudgetTokens))))
    : 60_000;
  const providerContextTokens = providerContextWindowTokens(opts.provider, opts.model);
  const continuationRounds = opts.provider === "anthropic"
    ? Math.max(0, Math.min(
        STUDIO_CHAT_MAX_CONTINUATION_ROUNDS,
        Math.floor(Number(opts.continuationRounds) || 0)
      ))
    : 0;
  const requestedContinuationReserve = continuationRounds * STUDIO_CHAT_CONTINUATION_RESERVE_TOKENS;
  const continuationReserveTokens = Math.min(
    requestedContinuationReserve,
    Math.max(0, configured - 4_000),
    Math.max(
      0,
      providerContextTokens
        - STUDIO_CHAT_MAX_OUTPUT_TOKENS
        - STUDIO_CHAT_PROVIDER_SAFETY_TOKENS
        - 4_000
    )
  );
  const providerInputCeiling = Math.max(
    4_000,
    providerContextTokens
      - STUDIO_CHAT_MAX_OUTPUT_TOKENS
      - continuationReserveTokens
      - STUDIO_CHAT_PROVIDER_SAFETY_TOKENS
  );
  // Continuation content is replayed as new input. Reserve it inside both the
  // member's desk budget and the provider window before assembling context.
  const inputCeilingTokens = Math.min(
    Math.max(4_000, configured - continuationReserveTokens),
    providerInputCeiling
  );
  const userMessageTokens = estimateStudioTokens(opts.userMessage) + STUDIO_CHAT_MESSAGE_OVERHEAD_TOKENS;
  const personaTokens = opts.persona ? estimateStudioTokens(opts.persona) + 2 : 0;
  const minimumContextTokens = Math.min(4_000, Math.max(800, Math.floor(inputCeilingTokens * 0.2)));
  const fixedTokens = STUDIO_CHAT_REQUEST_OVERHEAD_TOKENS + personaTokens + userMessageTokens;
  const userMessageFits = fixedTokens + minimumContextTokens <= inputCeilingTokens;
  const historyBudgetTokens = userMessageFits
    ? Math.max(0, Math.min(
        STUDIO_CHAT_MAX_HISTORY_TOKENS,
        Math.floor(inputCeilingTokens * 0.25),
        inputCeilingTokens - fixedTokens - minimumContextTokens
      ))
    : 0;

  return {
    providerContextTokens,
    inputCeilingTokens,
    outputReserveTokens: STUDIO_CHAT_MAX_OUTPUT_TOKENS,
    continuationReserveTokens,
    requestOverheadTokens: STUDIO_CHAT_REQUEST_OVERHEAD_TOKENS,
    userMessageTokens,
    personaTokens,
    historyBudgetTokens,
    minimumContextTokens,
    userMessageFits,
  };
}

export type BoundedDeskHistory = {
  messages: DeskHistoryMessage[];
  tokens: number;
  turns: number;
  truncated: boolean;
  droppedRows: number;
};

const historyMessageTokens = (message: DeskHistoryMessage) =>
  estimateStudioTokens(message.content) + STUDIO_CHAT_MESSAGE_OVERHEAD_TOKENS;

function clipCompleteHistoryTurn(
  user: DeskHistoryMessage,
  assistant: DeskHistoryMessage,
  maxTokens: number
): { messages: DeskHistoryMessage[]; tokens: number; truncated: boolean } | null {
  const contentBudget = maxTokens - (STUDIO_CHAT_MESSAGE_OVERHEAD_TOKENS * 2);
  if (contentBudget < 4) return null;
  const userFull = estimateStudioTokens(user.content);
  const assistantFull = estimateStudioTokens(assistant.content);
  let userBudget = Math.min(userFull, Math.max(2, Math.floor(contentBudget * 0.4)));
  let assistantBudget = Math.min(assistantFull, Math.max(2, contentBudget - userBudget));
  let spare = contentBudget - userBudget - assistantBudget;
  if (spare > 0 && userBudget < userFull) {
    const extra = Math.min(spare, userFull - userBudget);
    userBudget += extra;
    spare -= extra;
  }
  if (spare > 0 && assistantBudget < assistantFull) assistantBudget += Math.min(spare, assistantFull - assistantBudget);

  const clippedUser = clipTextToTokenBudget(user.content, userBudget);
  const clippedAssistant = clipTextToTokenBudget(assistant.content, assistantBudget);
  if (!clippedUser.text || !clippedAssistant.text) return null;
  const messages: DeskHistoryMessage[] = [
    { role: "user", content: clippedUser.text },
    { role: "assistant", content: clippedAssistant.text },
  ];
  return {
    messages,
    tokens: messages.reduce((sum, message) => sum + historyMessageTokens(message), 0),
    truncated: clippedUser.truncated || clippedAssistant.truncated,
  };
}

/**
 * Rows arrive newest-first. Current writes carry one shared turn_id so rapid
 * replies cannot interleave question B with answer A. Older rows without the
 * tag retain the conservative adjacent assistant→user fallback. Only complete
 * turns are replayed, and the oldest retained turn may be clipped as a pair.
 */
export function boundDeskConversationHistory(
  rows: DeskHistoryRow[],
  maxTokens: number
): BoundedDeskHistory {
  const normalized = rows
    .map((row, index) => ({ ...row, index }))
    .filter((row): row is DeskHistoryRow & { role: "user" | "assistant"; content: string; index: number } =>
      (row.role === "user" || row.role === "assistant") && typeof row.content === "string" && Boolean(row.content)
    );
  type OrderedTurn = { user: DeskHistoryMessage; assistant: DeskHistoryMessage; order: number };
  const turns: OrderedTurn[] = [];
  const tagged = new Map<string, {
    user?: DeskHistoryMessage;
    assistant?: DeskHistoryMessage;
    order: number;
  }>();
  const legacy: typeof normalized = [];

  for (const row of normalized) {
    const meta = row.meta && typeof row.meta === "object" && !Array.isArray(row.meta)
      ? row.meta as Record<string, unknown>
      : null;
    const turnId = typeof meta?.turn_id === "string" && /^[0-9a-f-]{36}$/i.test(meta.turn_id)
      ? meta.turn_id
      : null;
    if (!turnId) {
      legacy.push(row);
      continue;
    }
    const turn = tagged.get(turnId) ?? { order: row.index };
    turn.order = Math.min(turn.order, row.index);
    // First occurrence wins because rows are newest-first. A corrupted
    // duplicate tag can therefore never make an older row displace a newer
    // one inside the bounded window.
    if (!turn[row.role]) turn[row.role] = { role: row.role, content: row.content };
    tagged.set(turnId, turn);
  }
  for (const turn of tagged.values()) {
    if (turn.user && turn.assistant) turns.push({ ...turn, user: turn.user, assistant: turn.assistant });
  }

  // Compatibility for pre-1.6.3 rows. These were written assistant-first in
  // the newest-first query order; incomplete/ambiguous tails are dropped.
  let pendingAssistant: DeskHistoryMessage | null = null;
  let pendingOrder = 0;
  for (const row of legacy) {
    if (row.role === "assistant") {
      // Two assistants in a row means the newer one has no matching user in
      // this bounded window. Replace it with the older candidate rather than
      // pairing messages from different turns.
      pendingAssistant = { role: "assistant", content: row.content };
      pendingOrder = row.index;
      continue;
    }
    if (pendingAssistant) {
      turns.push({
        user: { role: "user", content: row.content },
        assistant: pendingAssistant,
        order: Math.min(pendingOrder, row.index),
      });
      pendingAssistant = null;
    }
  }
  turns.sort((a, b) => a.order - b.order);

  const selected: DeskHistoryMessage[][] = [];
  let tokens = 0;
  let clipped = false;
  let selectedTurns = 0;
  const boundedMax = Math.max(0, Math.floor(maxTokens));
  for (const turn of turns) {
    const full = [turn.user, turn.assistant];
    const fullTokens = full.reduce((sum, message) => sum + historyMessageTokens(message), 0);
    const remaining = boundedMax - tokens;
    if (fullTokens <= remaining) {
      selected.push(full);
      tokens += fullTokens;
      selectedTurns += 1;
      continue;
    }
    const partial = clipCompleteHistoryTurn(turn.user, turn.assistant, remaining);
    if (partial) {
      selected.push(partial.messages);
      tokens += partial.tokens;
      selectedTurns += 1;
      clipped = true;
    }
    break;
  }

  const messages = selected.reverse().flat();
  return {
    messages,
    tokens,
    turns: selectedTurns,
    truncated: clipped || selectedTurns < turns.length || normalized.length !== rows.length || turns.length * 2 !== normalized.length,
    droppedRows: Math.max(0, rows.length - messages.length),
  };
}

const CONTEXT_TRUNCATION_MARKER = "\n[…truncated to fit this desk's context budget]";

export function clipTextToTokenBudget(
  text: string,
  maxTokens: number,
  marker = CONTEXT_TRUNCATION_MARKER
): { text: string; truncated: boolean } {
  if (!text) return { text: "", truncated: false };
  if (maxTokens <= 0) return { text: "", truncated: true };
  if (estimateStudioTokens(text) <= maxTokens) return { text, truncated: false };

  const markerTokens = estimateStudioTokens(marker);
  if (markerTokens >= maxTokens) {
    return { text: marker.slice(0, maxTokens), truncated: true };
  }
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${text.slice(0, middle).trimEnd()}${marker}`;
    if (estimateStudioTokens(candidate) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  let keep = low;
  if (keep > 0 && /[\uD800-\uDBFF]/.test(text.charAt(keep - 1))) keep -= 1;
  let clipped = `${text.slice(0, keep).trimEnd()}${marker}`;
  while (keep > 0 && estimateStudioTokens(clipped) > maxTokens) {
    keep = Math.max(0, keep - 1);
    clipped = `${text.slice(0, keep).trimEnd()}${marker}`;
  }
  return { text: clipped, truncated: true };
}

function nodeText(data: Json): string {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const t = (data as Record<string, Json | undefined>).text;
    if (typeof t === "string") return t;
  }
  return "";
}

function boundSopPreviews(texts: string[]) {
  const candidates = texts.slice(0, STUDIO_SOP_PREVIEW_ITEMS);
  const previews: string[] = [];
  let used = 0;
  let truncated = texts.length > candidates.length;
  for (let i = 0; i < candidates.length; i++) {
    const remaining = STUDIO_SOP_PREVIEW_TOKENS - used;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const allocation = Math.min(
      STUDIO_SOP_PREVIEW_ITEM_TOKENS,
      Math.max(1, Math.floor(remaining / (candidates.length - i)))
    );
    const preview = clipTextToTokenBudget(candidates[i], allocation);
    if (preview.text) previews.push(preview.text);
    used += estimateStudioTokens(preview.text);
    truncated ||= preview.truncated;
  }
  return { previews, truncated };
}

/** Walk incoming edges to `deskNodeId`, expanding groups one level deep. */
export async function assembleDeskContext(
  supabase: AdminClient,
  boardId: string,
  deskNodeId: string,
  opts: { budgetTokens?: number; deskSop?: string | null; deskId?: string } = {}
): Promise<AssembledContext> {
  const budgetTokens = Number.isFinite(opts.budgetTokens)
    ? Math.max(256, Math.floor(Number(opts.budgetTokens)))
    : 60_000;

  const [nodes, edges] = await Promise.all([
    readExactContextPages<GraphNode>((from, to) => supabase
      .from("studio_nodes")
      .select("id,kind,data,source_id,desk_id", { count: "exact" })
      .eq("board_id", boardId)
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<ExactQueryResult<GraphNode>>),
    readExactContextPages<GraphEdge>((from, to) => supabase
      .from("studio_edges")
      .select("id,from_node,to_node", { count: "exact" })
      .eq("board_id", boardId)
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<ExactQueryResult<GraphEdge>>),
  ]);
  if (!nodes || !edges) throw unavailable("saved board wiring");
  const nodeById = new Map<string, GraphNode>(nodes.map((n) => [n.id, n]));
  if (edges.some((edge) => !nodeById.has(edge.from_node) || !nodeById.has(edge.to_node))) {
    throw unavailable("saved board wiring");
  }
  const targetDesk = nodeById.get(deskNodeId);
  if (!targetDesk || targetDesk.kind !== "desk" || (opts.deskId && targetDesk.desk_id !== opts.deskId)) {
    throw new DeskContextError(
      "This desk no longer matches the saved board. Nothing was sent to the writing model. Reload the board and try again.",
      409,
      "desk_context_mismatch"
    );
  }

  const incoming = (target: string) =>
    edges.filter((e) => e.to_node === target).map((e) => nodeById.get(e.from_node)).filter(Boolean) as GraphNode[];

  // Collect context members: direct wires + one level of group expansion.
  // A group whose data carries `auto: "best_performers"` is a LIVE group —
  // it expands to the current top own sources by engagement instead of
  // whatever is wired into it. This is the performance ledger on the canvas.
  const members: GraphNode[] = [];
  const seen = new Set<string>();
  const autoSourceIds: string[] = [];
  const isAutoGroup = (n: GraphNode) =>
    n.kind === "group" &&
    n.data &&
    typeof n.data === "object" &&
    !Array.isArray(n.data) &&
    (n.data as Record<string, Json | undefined>).auto === "best_performers";

  for (const direct of incoming(deskNodeId)) {
    if (isAutoGroup(direct)) {
      const { data: top, error: topError } = await supabase
        .from("studio_sources")
        .select("id")
        .eq("kind", "own")
        .eq("status", "ready")
        .not("engagement", "is", null)
        .order("engagement->engagement_rate", { ascending: false, nullsFirst: false })
        .limit(5);
      if (topError) throw unavailable("live source collection");
      for (const s of top ?? []) autoSourceIds.push(s.id);
      // Wired members still count — the union means the group degrades
      // gracefully before engagement data exists.
      for (const inner of incoming(direct.id)) {
        if (!seen.has(inner.id) && inner.kind === "source") {
          seen.add(inner.id);
          members.push(inner);
        }
      }
    } else if (direct.kind === "group") {
      for (const inner of incoming(direct.id)) {
        if (!seen.has(inner.id) && inner.kind !== "desk" && inner.kind !== "group") {
          seen.add(inner.id);
          members.push(inner);
        }
      }
    } else if (!seen.has(direct.id) && direct.kind !== "desk") {
      seen.add(direct.id);
      members.push(direct);
    }
  }

  const sops: string[] = [];
  const notes: string[] = [];
  const sourceIds: string[] = [...autoSourceIds];
  for (const m of members) {
    if (m.kind === "sop") {
      const t = nodeText(m.data);
      if (t) sops.push(t);
    } else if (m.kind === "note") {
      const t = nodeText(m.data);
      if (t) notes.push(t);
    } else if (m.kind === "source" && m.source_id && !sourceIds.includes(m.source_id)) {
      sourceIds.push(m.source_id);
    }
  }

  const uniqueSourceIds = [...new Set(sourceIds)];
  const sourceRows = uniqueSourceIds.length
    ? await readExactContextSources(uniqueSourceIds, (batch) => supabase
        .from("studio_sources")
        .select("id,title,platform,kind,status,transcript,analysis,engagement,notes,author", { count: "exact" })
        .in("id", batch)
        .range(0, batch.length - 1) as unknown as PromiseLike<ExactQueryResult<{
          id: string;
          title: string | null;
          platform: string;
          kind: string;
          status: string;
          transcript: string | null;
          analysis: Json | null;
          engagement: Json | null;
          notes: string | null;
          author: string | null;
        }>>)
    : [];
  if (!sourceRows) throw unavailable("wired sources");

  // The living voice profile (regenerated weekly by the runner from actually-
  // published content) rides along in every desk — never a hand-written brain.
  const { data: voice, error: voiceError } = await supabase
    .from("voice_profiles")
    .select("version,profile,generated_at")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (voiceError) throw unavailable("voice profile");

  // Real CTA links (brand_context cta/links — same source the article writer
  // uses). Without these, desks write placeholder brackets with no URL.
  const { data: cta, error: ctaError } = await supabase
    .from("brand_context")
    .select("content")
    .eq("category", "cta")
    .eq("key", "links")
    .maybeSingle();
  if (ctaError) throw unavailable("brand links");

  const ready = sourceRows.filter((s) => s.status === "ready" && s.transcript);

  // Every byte that enters the system prompt participates in the same budget.
  // Each class has one aggregate ceiling; twenty legacy SOP rows therefore do
  // not each receive a fresh allowance. When ready sources exist, instructions,
  // notes and auxiliary brand data can consume at most 65% together, reserving
  // real source evidence even when an old instruction row is enormous.
  const preamble =
    `You are a specialist content desk in this brand's Content Studio. ` +
    `Work ONLY from the wired context below plus the conversation. Use the audience's real language from the sources; ` +
    `never invent statistics, testimonials, or proof. ` +
    `Answer in clean GitHub-flavored Markdown. Separate paragraphs with a blank line, and use descriptive headings and proper bullet or numbered lists when they improve readability. ` +
    `Banned words: revolutionary, cutting-edge, game-changing, unleash, supercharge, 10x, unlock, leverage, harness.`;
  const parts: string[] = [];
  let used = estimateStudioTokens(preamble);
  const appendBudgeted = (block: string, maxTokens = Number.POSITIVE_INFINITY) => {
    const separatorTokens = estimateStudioTokens("\n\n");
    const remaining = Math.max(0, budgetTokens - used - separatorTokens);
    const allocation = Math.min(remaining, maxTokens);
    const clipped = clipTextToTokenBudget(block, allocation);
    if (!clipped.text) return { ...clipped, tokens: 0 };
    parts.push(clipped.text);
    const tokens = estimateStudioTokens(clipped.text);
    used += separatorTokens + tokens;
    return { ...clipped, tokens };
  };

  const availableAfterPreamble = Math.max(0, budgetTokens - used - estimateStudioTokens("\n\n"));
  const classBudgets = ready.length
    ? {
        instructions: Math.floor(availableAfterPreamble * 0.4),
        auxiliary: Math.floor(availableAfterPreamble * 0.1),
        notes: Math.floor(availableAfterPreamble * 0.15),
      }
    : {
        instructions: Math.floor(availableAfterPreamble * 0.65),
        auxiliary: Math.floor(availableAfterPreamble * 0.15),
        notes: Math.floor(availableAfterPreamble * 0.2),
      };
  const classTokens = { instructions: 0, auxiliary: 0, notes: 0, sources: 0 };

  // Keep the canvas-wired instruction texts separately: the desk panel shows
  // them read-only under its own instructions box, so the two rule sources
  // visibly merge instead of looking like competing features. This preview is
  // separately aggregate-bounded because it is returned as JSON outside the
  // model prompt.
  const sopPreview = boundSopPreviews(sops);
  if (opts.deskSop) sops.unshift(opts.deskSop);
  const sopResult = sops.length
    ? appendBudgeted(
        `## Standing instructions (SOPs)\n\n${sops.join("\n\n---\n\n")}`,
        classBudgets.instructions
      )
    : { text: "", truncated: false, tokens: 0 };
  classTokens.instructions = sopResult.tokens;

  const auxiliaryBlocks: string[] = [];
  if (cta?.content) {
    auxiliaryBlocks.push(
      `## CTA links — the ONLY links you may use. Always write real markdown links with these exact URLs; never a bracketed placeholder without a URL.\n\n${cta.content}`
    );
  }
  if (voice) {
    auxiliaryBlocks.push(
      `## Voice profile (auto-generated v${voice.version}, ${String(voice.generated_at).slice(0, 10)} — from recently published content)\n\n${JSON.stringify(voice.profile)}`
    );
  }
  for (let i = 0; i < auxiliaryBlocks.length; i++) {
    const remaining = Math.max(0, classBudgets.auxiliary - classTokens.auxiliary);
    const allocation = Math.floor(remaining / (auxiliaryBlocks.length - i));
    const added = appendBudgeted(auxiliaryBlocks[i], allocation);
    classTokens.auxiliary += added.tokens;
  }

  const noteResult = notes.length
    ? appendBudgeted(
        `## Working notes\n\n${notes.join("\n\n---\n\n")}`,
        classBudgets.notes
      )
    : { text: "", truncated: false, tokens: 0 };
  classTokens.notes = noteResult.tokens;

  const stats: ContextSourceStat[] = [];

  for (let i = 0; i < ready.length; i++) {
    const s = ready[i];
    const remaining = Math.max(0, budgetTokens - used - estimateStudioTokens("\n\n"));
    if (remaining <= 0) {
      stats.push({ id: s.id, title: s.title ?? s.id, platform: s.platform, kind: s.kind, tokens: 0, truncated: true });
      continue;
    }
    const perSourceBudget = Math.floor(remaining / (ready.length - i));
    const fullHeader =
      `### Source: ${s.title ?? "untitled"} [${s.platform}, ${s.kind}]` +
      (s.author ? ` by ${s.author}` : "") +
      (s.engagement ? `\nEngagement: ${JSON.stringify(s.engagement)}` : "") +
      (s.notes ? `\nHuman notes: ${s.notes}` : "") +
      (s.analysis ? `\nAnalysis: ${JSON.stringify(s.analysis)}` : "");
    const sourceScaffoldingTokens = estimateStudioTokens("\n\nTranscript:\n");
    const sourceContentBudget = Math.max(1, perSourceBudget - sourceScaffoldingTokens);
    const headerBudget = Math.min(512, Math.max(1, Math.floor(sourceContentBudget * 0.35)));
    const transcriptBudget = Math.max(1, sourceContentBudget - headerBudget);
    const header = clipTextToTokenBudget(fullHeader, headerBudget);
    const transcript = clipTextToTokenBudget(s.transcript ?? "", transcriptBudget);
    const block = `${header.text}\n\nTranscript:\n${transcript.text}`;
    const added = appendBudgeted(block, perSourceBudget);
    classTokens.sources += added.tokens;
    stats.push({
      id: s.id,
      title: s.title ?? s.id,
      platform: s.platform,
      kind: s.kind,
      tokens: added.tokens,
      truncated: header.truncated || transcript.truncated || added.truncated,
    });
  }

  const system =
    `${preamble}\n\n` +
    (parts.length ? parts.join("\n\n") : "## No context wired yet\nTell the user to wire sources, notes, or SOPs into this desk.");

  return {
    system,
    estTokens: estimateStudioTokens(system),
    budgetTokens,
    sops: sops.length,
    notes: notes.length,
    sopsTruncated: sopResult.truncated,
    notesTruncated: noteResult.truncated,
    sources: stats,
    sopTexts: sopPreview.previews,
    sopTextsTruncated: sopPreview.truncated,
    classTokens,
  };
}
