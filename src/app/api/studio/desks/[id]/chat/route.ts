/**
 * The desk conversation — where wired context becomes writing.
 *
 * GET  /api/studio/desks/:id/chat?board_id=&node_id=
 *      → context preview for the meter (no model call).
 * POST /api/studio/desks/:id/chat { board_id, node_id, message }
 *      → assemble wired context → Claude → store user+assistant messages →
 *        { reply, context }.
 *
 *      Research runs (web search, pause_turn rounds) take minutes; a silent
 *      connection that long gets severed at the edge and the client sees an
 *      empty body ("Unexpected end of JSON input"). So browsers opt into a
 *      heartbeat stream with `Accept: application/x-ndjson`: the response
 *      starts immediately, `{"type":"ping"}` lines keep bytes flowing, and
 *      the run ends with `{"type":"done",...}` or `{"type":"error",...}`.
 *      Callers without the header (machine API) get plain JSON as before.
 */
import { NextRequest, NextResponse } from "next/server";
import { studioAuth } from "@/lib/studio/auth";
import {
  runAnthropicWithPauseTurns,
  safeAnthropicRequestErrorPayload,
} from "@/lib/studio/anthropic-continuation";
import { createAdminClient } from "@/lib/supabase/server";
import {
  assembleDeskContext,
  boundDeskConversationHistory,
  DeskContextError,
  estimateStudioContinuationTokens,
  planDeskRequestBudget,
  STUDIO_CHAT_HISTORY_ROW_LIMIT,
  STUDIO_CHAT_MAX_CONTINUATION_ROUNDS,
  STUDIO_CHAT_MAX_OUTPUT_TOKENS,
} from "@/lib/studio/context";
import { isDefaultDeskName, suggestDeskTitle } from "@/lib/studio/desk-title";
import { studioContextTextError } from "@/lib/studio/text-limits";

type Ctx = { params: Promise<{ id: string }> };
type AdminClient = ReturnType<typeof createAdminClient>;
type MessageIds = { user: string; assistant: string };
type ChatBody = {
  action?: "persist_reply";
  board_id?: string;
  node_id?: string;
  message?: string;
  reply?: string;
  message_ids?: MessageIds;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validMessageIds = (value: unknown): value is MessageIds => {
  if (!value || typeof value !== "object") return false;
  const ids = value as Partial<MessageIds>;
  return Boolean(ids.user && ids.assistant && ids.user !== ids.assistant && UUID.test(ids.user) && UUID.test(ids.assistant));
};

async function retryMessageWrite(supabase: AdminClient, write: () => PromiseLike<{ error: { message: string } | null }>) {
  let messageError: { message: string } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await write();
    messageError = result.error;
    if (!messageError) break;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 250));
  }
  return messageError;
}

async function renameDefaultDesk(
  supabase: AdminClient,
  desk: { id: string; name: string },
  message: string
): Promise<string | null> {
  if (!isDefaultDeskName(desk.name)) return null;
  const name = suggestDeskTitle(message);
  if (!name) return null;
  const { data, error } = await supabase
    .from("studio_desks")
    .update({ name })
    .eq("id", desk.id)
    .eq("name", desk.name)
    .select("name")
    .maybeSingle();
  if (error) {
    // Naming is cosmetic; a successful paid reply must never become an error
    // because its deterministic title could not be stored.
    console.error("[studio-chat] automatic desk rename failed", { deskId: desk.id, error: error.message });
    return null;
  }
  return data?.name ?? null;
}

const PERSONA_LINES: Record<string, string> = {
  "content-manager":
    "You are the Content Manager: the drumbeat desk. Plain English, short lines, no em dashes. Consistency beats brilliance.",
  beacon:
    "You are Beacon, the YouTube packaging desk: titles, thumbnails, hooks, and growth judgment. Specific beats clever.",
};

const contextFailure = (error: unknown) => {
  if (error instanceof DeskContextError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  return NextResponse.json(
    { error: "The desk could not verify its saved context. Nothing was sent to the writing model. Please try again." },
    { status: 503 }
  );
};

export async function GET(request: NextRequest, { params }: Ctx) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });
  const { id } = await params;
  const boardId = request.nextUrl.searchParams.get("board_id");
  const nodeId = request.nextUrl.searchParams.get("node_id");
  if (!boardId || !nodeId) return NextResponse.json({ error: "board_id and node_id required" }, { status: 400 });

  const supabase = createAdminClient();
  const { data: desk, error: deskError } = await supabase
    .from("studio_desks")
    .select("sop,max_context_tokens")
    .eq("id", id)
    .maybeSingle();
  if (deskError) return NextResponse.json({ error: "The desk could not be read. Please try again." }, { status: 503 });
  if (!desk) return NextResponse.json({ error: "Desk not found" }, { status: 404 });

  let ctx;
  try {
    ctx = await assembleDeskContext(supabase, boardId, nodeId, {
      budgetTokens: desk.max_context_tokens,
      deskSop: desk.sop,
      deskId: id,
    });
  } catch (error) {
    return contextFailure(error);
  }
  return NextResponse.json({
    estTokens: ctx.estTokens,
    budgetTokens: ctx.budgetTokens,
    sops: ctx.sops,
    notes: ctx.notes,
    sopsTruncated: ctx.sopsTruncated,
    notesTruncated: ctx.notesTruncated,
    sources: ctx.sources,
    sopTexts: ctx.sopTexts,
    sopTextsTruncated: ctx.sopTextsTruncated,
    classTokens: ctx.classTokens,
  });
}

export async function POST(request: NextRequest, { params }: Ctx) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as ChatBody | null;
  if (!body?.board_id || !body.node_id) {
    return NextResponse.json({ error: "board_id and node_id required" }, { status: 400 });
  }
  const supabase = createAdminClient();
  const { data: desk, error: deskError } = await supabase.from("studio_desks").select("*").eq("id", id).maybeSingle();
  if (deskError) return NextResponse.json({ error: "The desk could not be read. Please try again." }, { status: 503 });
  if (!desk) return NextResponse.json({ error: "Desk not found" }, { status: 404 });

  // A generated reply that outlived a transient Postgres fault can be saved
  // without another model call. Stable row ids make the retry idempotent.
  if (body.action === "persist_reply") {
    if (!body.message?.trim() || !body.reply?.trim() || !validMessageIds(body.message_ids)) {
      return NextResponse.json({ error: "message, reply and valid message_ids required" }, { status: 400 });
    }
    const messageError = studioContextTextError(body.message, "Message");
    const replyError = studioContextTextError(body.reply, "Reply");
    if (messageError || replyError) {
      return NextResponse.json({ error: messageError ?? replyError, code: "studio_text_too_large" }, { status: 413 });
    }
    const { data: deskNode, error: nodeError } = await supabase
      .from("studio_nodes")
      .select("id")
      .eq("id", body.node_id)
      .eq("board_id", body.board_id)
      .eq("kind", "desk")
      .eq("desk_id", id)
      .maybeSingle();
    if (nodeError) return NextResponse.json({ error: "The saved desk could not be verified. Please try again." }, { status: 503 });
    if (!deskNode) return NextResponse.json({ error: "This desk no longer matches the saved board." }, { status: 409 });

    const recoveryRows = [
      {
        id: body.message_ids.user,
        desk_id: id,
        role: "user",
        content: body.message.trim(),
        created_at: new Date().toISOString(),
        meta: { turn_id: body.message_ids.user },
      },
      {
        id: body.message_ids.assistant,
        desk_id: id,
        role: "assistant",
        content: body.reply.trim(),
        created_at: new Date(Date.now() + 1000).toISOString(),
        meta: { turn_id: body.message_ids.user, recovered_after_save_fault: true },
      },
    ];
    const { data: existing, error: existingError } = await supabase
      .from("studio_desk_messages")
      .select("id,desk_id,role,content")
      .in("id", [body.message_ids.user, body.message_ids.assistant]);
    if (existingError) return NextResponse.json({ error: "The reply history could not be checked. Please try again." }, { status: 503 });
    const expected = new Map(recoveryRows.map((row) => [row.id, row]));
    if ((existing ?? []).some((row) => {
      const wanted = expected.get(row.id);
      return !wanted || row.desk_id !== id || row.role !== wanted.role || row.content !== wanted.content;
    })) {
      return NextResponse.json({ error: "Those reply ids already belong to different messages." }, { status: 409 });
    }
    const saveError = await retryMessageWrite(supabase, () =>
      supabase.from("studio_desk_messages").upsert(recoveryRows, { onConflict: "id", ignoreDuplicates: true })
    );
    if (saveError) {
      return NextResponse.json({ error: "The reply is still safe in this browser, but its history could not be saved yet." }, { status: 503 });
    }
    return NextResponse.json({ saved: true, message_ids: body.message_ids });
  }

  if (!body.message?.trim()) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }
  const userMessage = body.message.trim();
  const userMessageError = studioContextTextError(userMessage, "Message");
  if (userMessageError) {
    return NextResponse.json({ error: userMessageError, code: "studio_text_too_large" }, { status: 413 });
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error: "The deployed Worker is missing ANTHROPIC_API_KEY. Ask your Builder to configure it and rerun Studio setup.",
        code: "worker_anthropic_missing",
      },
      { status: 503 },
    );
  }
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const messageIds = validMessageIds(body.message_ids)
    ? body.message_ids
    : { user: crypto.randomUUID(), assistant: crypto.randomUUID() };

  let alreadySavedReply: string | null = null;
  if (validMessageIds(body.message_ids)) {
    const { data: existing, error: existingError } = await supabase
      .from("studio_desk_messages")
      .select("id,desk_id,role,content")
      .in("id", [messageIds.user, messageIds.assistant]);
    if (existingError) {
      return NextResponse.json({ error: "The desk could not check this request safely. Nothing was sent to the writing model." }, { status: 503 });
    }
    const userRow = (existing ?? []).find((row) => row.id === messageIds.user);
    const assistantRow = (existing ?? []).find((row) => row.id === messageIds.assistant);
    if (
      (userRow && (userRow.desk_id !== id || userRow.role !== "user" || userRow.content !== userMessage)) ||
      (assistantRow && (assistantRow.desk_id !== id || assistantRow.role !== "assistant"))
    ) {
      return NextResponse.json({ error: "Those message ids already belong to another request." }, { status: 409 });
    }
    alreadySavedReply = assistantRow?.content ?? null;
  }

  const persona = PERSONA_LINES[desk.persona] ?? "";
  // Multi-model desks (§12): an OpenRouter-style id (vendor/model) routes
  // through the member's own OPENROUTER_API_KEY — their infrastructure, their
  // spend. Anthropic ids keep the direct path. No key present → exactly
  // today's behavior: graceful fallback to the house Claude, nothing breaks.
  const wantsOpenRouter = desk.model.includes("/");
  const viaOpenRouter = wantsOpenRouter && Boolean(openrouterKey);
  const modelFallback = wantsOpenRouter && !openrouterKey;
  const model = modelFallback ? "claude-sonnet-4-6" : desk.model;
  // Desks with settings.web_search get Anthropic's server-side web search —
  // this is what makes the Research desk a real deep-research desk. Through
  // OpenRouter the equivalent is the web plugin's :online model suffix.
  const webSearch = Boolean((desk.settings as { web_search?: boolean } | null)?.web_search);

  const requestBudget = planDeskRequestBudget({
    deskBudgetTokens: desk.max_context_tokens,
    provider: viaOpenRouter ? "openrouter" : "anthropic",
    model,
    userMessage,
    persona,
    continuationRounds: webSearch && !viaOpenRouter ? STUDIO_CHAT_MAX_CONTINUATION_ROUNDS : 0,
  });
  if (!requestBudget.userMessageFits) {
    return NextResponse.json(
      {
        error: "This message is too large for the desk's safe model context. Shorten it or raise the desk context limit.",
        code: "studio_message_exceeds_context",
      },
      { status: 413 }
    );
  }

  const { data: historyRows, error: historyError } = await supabase
    .from("studio_desk_messages")
    .select("id,role,content,created_at,meta")
    .eq("desk_id", id)
    .order("created_at", { ascending: false })
    .order("role", { ascending: true })
    .order("id", { ascending: false })
    .limit(STUDIO_CHAT_HISTORY_ROW_LIMIT);
  if (historyError) {
    return NextResponse.json(
      { error: "The desk's conversation could not be read. Nothing was sent to the writing model. Please try again." },
      { status: 503 }
    );
  }
  const boundedHistory = boundDeskConversationHistory(historyRows ?? [], requestBudget.historyBudgetTokens);
  const contextBudgetTokens = Math.max(
    requestBudget.minimumContextTokens,
    requestBudget.inputCeilingTokens
      - requestBudget.requestOverheadTokens
      - requestBudget.personaTokens
      - requestBudget.userMessageTokens
      - boundedHistory.tokens
  );

  let ctx;
  try {
    ctx = await assembleDeskContext(supabase, body.board_id, body.node_id, {
      budgetTokens: contextBudgetTokens,
      deskSop: desk.sop,
      deskId: id,
    });
  } catch (error) {
    return contextFailure(error);
  }
  const system = (persona ? `${persona}\n\n` : "") + ctx.system;
  const plannedInputTokens =
    requestBudget.requestOverheadTokens
    + requestBudget.personaTokens
    + requestBudget.userMessageTokens
    + boundedHistory.tokens
    + ctx.estTokens;
  if (plannedInputTokens > requestBudget.inputCeilingTokens) {
    return NextResponse.json(
      { error: "The desk could not fit its verified context safely. Nothing was sent to the writing model." },
      { status: 503 }
    );
  }

  const tools = webSearch && !viaOpenRouter ? [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }] : undefined;

  const messages: { role: string; content: unknown }[] = [
    ...boundedHistory.messages,
    { role: "user", content: userMessage },
  ];

  const runAnthropic = () => runAnthropicWithPauseTurns({
    apiKey,
    model,
    system,
    messages,
    tools,
    maxOutputTokens: STUDIO_CHAT_MAX_OUTPUT_TOKENS,
    maxContinuationRounds: STUDIO_CHAT_MAX_CONTINUATION_ROUNDS,
    continuationReserveTokens: requestBudget.continuationReserveTokens,
    inputCeilingTokens: requestBudget.inputCeilingTokens,
    plannedInputTokens,
    estimateContinuationTokens: estimateStudioContinuationTokens,
  });

  const runOpenRouter = async () => {
    type OpenRouterResponse = {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${openrouterKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: webSearch ? `${model}:online` : model,
        max_tokens: STUDIO_CHAT_MAX_OUTPUT_TOKENS,
        messages: [
          { role: "system", content: system },
          ...messages.map((m) => ({ role: m.role, content: String(m.content) })),
        ],
      }),
    });
    const raw = await res.text();
    let json: OpenRouterResponse;
    try {
      json = JSON.parse(raw) as OpenRouterResponse;
    } catch {
      throw new Error(`OpenRouter returned a non-JSON response (${res.status})${raw ? `: ${raw.slice(0, 200)}` : ""}`);
    }
    if (!res.ok || json.error) {
      throw new Error(json.error?.message ?? `OpenRouter call failed (${res.status})`);
    }
    const reply = (json.choices?.[0]?.message?.content ?? "").trim();
    return {
      reply,
      usage: { input: json.usage?.prompt_tokens ?? null, output: json.usage?.completion_tokens ?? null },
      continuationTokens: 0,
    };
  };

  const runDesk = async () => {
    const generated = alreadySavedReply
      ? { reply: alreadySavedReply, usage: { input: null, output: null }, continuationTokens: 0 }
      : viaOpenRouter
        ? await runOpenRouter()
        : await runAnthropic();
    const { reply, usage, continuationTokens } = generated;
    const totalPlannedInputTokens = plannedInputTokens + continuationTokens;
    if (!reply) throw new Error("Model returned no text");

    let saved = Boolean(alreadySavedReply);
    if (!alreadySavedReply) {
      // Explicit timestamps: both rows in one insert share now() otherwise,
      // and equal created_at makes the pair's order a coin flip on reload.
      const t = Date.now();
      const messageRows = [
          {
            id: messageIds.user,
            desk_id: id,
            role: "user",
            content: userMessage,
            created_at: new Date(t).toISOString(),
            meta: { turn_id: messageIds.user },
          },
          {
            id: messageIds.assistant,
            desk_id: id,
            role: "assistant",
            content: reply,
            created_at: new Date(t + 1000).toISOString(),
            meta: {
              turn_id: messageIds.user,
              model,
              via: viaOpenRouter ? "openrouter" : "anthropic",
              ...(modelFallback ? { fallback_from: desk.model } : {}),
              context_tokens: ctx.estTokens,
              request_input_tokens_estimate: totalPlannedInputTokens,
              input_ceiling_tokens: requestBudget.inputCeilingTokens,
              history_tokens: boundedHistory.tokens,
              history_truncated: boundedHistory.truncated,
              input_tokens: usage.input,
              output_tokens: usage.output,
              sources: ctx.sources.map((s) => s.id),
            },
          },
        ];
      const messageError = await retryMessageWrite(supabase, () =>
        supabase.from("studio_desk_messages").insert(messageRows)
      );
      saved = !messageError;
      if (messageError) {
        // The model call has already spent the member's money. Return the reply
        // and stable ids so the browser/machine caller can preserve it and use
        // the persist-only action without paying for a second generation.
        console.error("[studio-chat] generated reply persistence failed", { deskId: id, error: messageError.message });
      }
    }
    const deskName = await renameDefaultDesk(supabase, desk, userMessage);

    return {
      reply,
      saved,
      ...(saved ? {} : { warning: "This reply was generated but its history could not be saved. Preserve this response and retry saving with these message ids without running the model again." }),
      message_ids: messageIds,
      desk_name: deskName,
      context: {
        estTokens: ctx.estTokens,
        budgetTokens: ctx.budgetTokens,
        sopsTruncated: ctx.sopsTruncated,
        notesTruncated: ctx.notesTruncated,
        sopTextsTruncated: ctx.sopTextsTruncated,
        classTokens: ctx.classTokens,
        inputTokens: totalPlannedInputTokens,
        inputCeilingTokens: requestBudget.inputCeilingTokens,
        providerContextTokens: requestBudget.providerContextTokens,
        outputReserveTokens: requestBudget.outputReserveTokens,
        continuationReserveTokens: requestBudget.continuationReserveTokens,
        continuationTokens,
        historyTokens: boundedHistory.tokens,
        historyTurns: boundedHistory.turns,
        historyTruncated: boundedHistory.truncated,
        historyDroppedRows: boundedHistory.droppedRows,
        sources: ctx.sources,
      },
    };
  };

  if ((request.headers.get("accept") ?? "").includes("application/x-ndjson")) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const write = (obj: unknown) => {
          try {
            controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
          } catch {
            // stream already closed (client went away) — nothing to do
          }
        };
        const ping = setInterval(() => write({ type: "ping" }), 10_000);
        try {
          write({ type: "ping" });
          const payload = await runDesk();
          write({ type: "done", ...payload });
        } catch (e) {
          write({ type: "error", ...safeAnthropicRequestErrorPayload(e) });
        } finally {
          clearInterval(ping);
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      },
    });
    return new Response(stream, {
      headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" },
    });
  }

  try {
    return NextResponse.json(await runDesk());
  } catch (e) {
    return NextResponse.json(
      safeAnthropicRequestErrorPayload(e),
      { status: 502 },
    );
  }
}
