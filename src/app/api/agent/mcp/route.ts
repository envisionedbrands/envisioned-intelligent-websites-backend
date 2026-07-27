/**
 * POST /api/agent/mcp — streamable-HTTP MCP server exposing the Operator's
 * tool belt to external MCP clients (Claude Desktop, ChatGPT, your own scripts),
 * so you can drive your Operator from outside the dashboard. Hand-rolled on
 * purpose: the protocol surface needed (initialize / tools/list / tools/call)
 * is tiny, and heavy MCP SDKs fight the OpenNext/Workers build.
 *
 * Auth is a bearer token — your existing API_SECRET_KEY (the master key), so
 * there is no new secret to manage. Every tools/call is logged to agent_runs,
 * so external activity shows up in the Operator dashboard feed alongside chat.
 * The proposal gate is untouched: outward-facing tools still only write
 * proposals into agent_actions — nothing sends without your approval.
 *
 * OPTIONAL. If you didn't opt into the MCP track, this route is simply never
 * called; it exposes nothing without the bearer key.
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { TOOL_DEFINITIONS, executeTool, type ToolContext } from "@/lib/agent/tools";
import type { Json } from "@/types/database";

const PROTOCOL_VERSION = "2025-03-26";

/**
 * Only the master key (API_SECRET_KEY) may drive the tool belt — the narrower
 * per-agent keys from the starter deliberately don't reach it. Checked here
 * rather than through the shared auth helper so this optional route stays a
 * single self-contained file you can delete if you don't want the bridge.
 */
function authorized(request: NextRequest): boolean {
  const secret = process.env.API_SECRET_KEY;
  if (!secret) return false;
  const match = (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const token = match[1].trim();
  // Constant-time-ish compare: bail on length first, then diff every byte.
  if (token.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null, result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: string | number | null, code: number, message: string, status = 200) {
  return NextResponse.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
}

/**
 * Log one external tool call as an agent_runs row so it appears in the
 * dashboard activity feed. Prefers trigger 'mcp'; falls back to 'chat' where
 * the DB check constraint predates the MCP track (migration 200).
 */
async function createRun(supabase: ReturnType<typeof createAdminClient>): Promise<string | null> {
  for (const trigger of ["mcp", "chat"] as const) {
    const { data, error } = await supabase
      .from("agent_runs")
      .insert({ trigger, status: "running" })
      .select("id")
      .single();
    if (data) return data.id;
    if (error && !/check constraint/i.test(error.message)) return null;
  }
  return null;
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let rpc: JsonRpcRequest;
  try {
    rpc = (await request.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }
  if (Array.isArray(rpc)) {
    return rpcError(null, -32600, "Batch requests are not supported", 400);
  }

  const { id = null, method, params = {} } = rpc;

  // Notifications (no id) get an empty 202 per streamable-HTTP transport.
  if (id === null && method?.startsWith("notifications/")) {
    return new NextResponse(null, { status: 202 });
  }

  switch (method) {
    case "initialize": {
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "digital-home-operator", version: "1.0.0" },
        instructions:
          "The Operator tool belt: CRM leads, funnel, pipeline, bookings, email, " +
          "content and memory (save_insight/list_insights). Outward-facing tools (emails, " +
          "publishes) only create proposals for the owner to approve — they never send directly.",
      });
    }

    case "ping":
      return rpcResult(id, {});

    case "tools/list": {
      const tools = TOOL_DEFINITIONS.map((t) => ({
        name: t.name,
        description: t.description || "",
        inputSchema: t.input_schema,
      }));
      return rpcResult(id, { tools });
    }

    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments || {}) as Record<string, unknown>;
      if (!TOOL_DEFINITIONS.some((t) => t.name === name)) {
        return rpcError(id, -32602, `Unknown tool: ${name}`);
      }

      const supabase = createAdminClient();
      const runId = await createRun(supabase);
      const ctx: ToolContext = {
        supabase,
        origin: request.nextUrl.origin,
        runId: runId || "mcp-unlogged",
      };

      const started = Date.now();
      try {
        const outcome = await executeTool(name, args, ctx);
        if (runId) {
          await supabase
            .from("agent_runs")
            .update({
              status: "completed",
              summary: `MCP — ${name}: ${outcome.summary}`,
              tool_calls: [
                {
                  tool: name,
                  input: args,
                  summary: outcome.summary,
                  ok: true,
                  ms: Date.now() - started,
                  at: new Date().toISOString(),
                },
              ] as unknown as Json,
              completed_at: new Date().toISOString(),
            })
            .eq("id", runId);
        }
        const text = typeof outcome.data === "string" ? outcome.data : JSON.stringify(outcome.data);
        return rpcResult(id, { content: [{ type: "text", text }], isError: false });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Tool failed";
        if (runId) {
          await supabase
            .from("agent_runs")
            .update({
              status: "failed",
              summary: `MCP — ${name} failed`,
              error: message,
              tool_calls: [
                {
                  tool: name,
                  input: args,
                  summary: `Failed: ${message}`,
                  ok: false,
                  ms: Date.now() - started,
                  at: new Date().toISOString(),
                },
              ] as unknown as Json,
              completed_at: new Date().toISOString(),
            })
            .eq("id", runId);
        }
        return rpcResult(id, { content: [{ type: "text", text: `Error: ${message}` }], isError: true });
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// This server responds with plain JSON (no SSE stream) — spec-compliant for
// streamable HTTP. GET is for servers that offer a server-initiated stream;
// we don't, so say so.
export function GET() {
  return NextResponse.json({ error: "Method not allowed — POST JSON-RPC only" }, { status: 405 });
}
