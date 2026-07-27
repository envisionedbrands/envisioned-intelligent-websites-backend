/**
 * The Operator's brain: a tool-calling loop over the tool belt, running on
 * whichever model provider your backend is configured for.
 *
 * PROVIDER. Your Digital Home already needs an ANTHROPIC_API_KEY for the
 * content pipeline and the CRM copywriter, so by default the Operator runs on
 * that same key — nothing new to buy. If you'd rather run the reasoning loop
 * on OpenAI, add an OPENAI_API_KEY. Set OPERATOR_PROVIDER ('anthropic' or
 * 'openai') to be explicit; otherwise the loop picks whichever key it finds.
 * Either way the CRM copywriter stays on Claude — that's a copy-quality
 * choice, not a cost one.
 *
 * Every tool call is appended to agent_runs.tool_calls AS IT HAPPENS so the
 * dashboard's activity feed (polling every ~2s) shows live work.
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { AdminClient } from "@/lib/crm/types";
import type { Json } from "@/types/database";
import { getCrmSettings } from "@/lib/crm/settings";
import { OPERATOR_SYSTEM } from "./prompt";
import { TOOL_DEFINITIONS, executeTool, type ToolContext } from "./tools";

export type OperatorProvider = "anthropic" | "openai";

const DEFAULT_MODELS: Record<OperatorProvider, string> = {
  anthropic: "claude-opus-4-8",
  openai: "gpt-5.4",
};

const MAX_LOOPS = 12;
const MAX_OUTPUT_TOKENS = 8192;

/**
 * Which provider this install runs on. OPERATOR_PROVIDER wins; otherwise an
 * OpenAI key (which you'd only have added deliberately) beats the Anthropic
 * key every Digital Home already carries.
 */
export function operatorProvider(): OperatorProvider {
  const explicit = (process.env.OPERATOR_PROVIDER || "").trim().toLowerCase();
  if (explicit === "openai" || explicit === "anthropic") return explicit;
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  throw new Error(
    "No model provider configured — set ANTHROPIC_API_KEY (recommended; your content pipeline already uses it) or OPENAI_API_KEY"
  );
}

export function operatorModel(provider: OperatorProvider = operatorProvider()): string {
  return process.env.OPERATOR_MODEL || DEFAULT_MODELS[provider];
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface RunResult {
  runId: string;
  reply: string;
  toolCalls: ToolCallLog[];
  tokens: number;
}

interface ToolCallLog {
  tool: string;
  input: Record<string, unknown>;
  summary: string;
  ok: boolean;
  ms: number;
  at: string;
}

function truncate(value: unknown, max = 6000): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}… (truncated)` : text;
}

/**
 * Run one tool, log it, and push the live update — the half of the loop that
 * is identical across providers. Returns the text to hand back to the model.
 */
async function callTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
  toolCalls: ToolCallLog[],
  runId: string
): Promise<{ content: string; ok: boolean }> {
  const started = Date.now();
  let result: { content: string; ok: boolean };
  try {
    const outcome = await executeTool(name, input, ctx);
    toolCalls.push({
      tool: name,
      input,
      summary: outcome.summary,
      ok: true,
      ms: Date.now() - started,
      at: new Date().toISOString(),
    });
    result = { content: truncate(outcome.data), ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Tool failed";
    toolCalls.push({
      tool: name,
      input,
      summary: `Failed: ${message}`,
      ok: false,
      ms: Date.now() - started,
      at: new Date().toISOString(),
    });
    result = { content: `Error: ${message}`, ok: false };
  }
  // Live-update the run so the dashboard feed shows work in progress.
  await ctx.supabase
    .from("agent_runs")
    .update({ tool_calls: toolCalls as unknown as Json })
    .eq("id", runId);
  return result;
}

interface LoopResult {
  textParts: string[];
  tokens: number;
}

/** Anthropic tool-use loop. */
async function loopAnthropic(
  opts: { message: string; history?: ChatTurn[] },
  ctx: ToolContext,
  toolCalls: ToolCallLog[],
  runId: string
): Promise<LoopResult> {
  const anthropic = new Anthropic();
  const model = operatorModel("anthropic");
  const messages: Anthropic.MessageParam[] = [
    ...(opts.history || []).slice(-12).map((t) => ({ role: t.role, content: t.content })),
    { role: "user" as const, content: opts.message },
  ];
  const textParts: string[] = [];
  let tokens = 0;

  for (let loop = 0; loop < MAX_LOOPS; loop++) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: OPERATOR_SYSTEM,
      tools: TOOL_DEFINITIONS,
      messages,
    });
    tokens += (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) textParts.push(text);

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

    messages.push({ role: "assistant", content: response.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const input = (toolUse.input || {}) as Record<string, unknown>;
      const { content, ok } = await callTool(toolUse.name, input, ctx, toolCalls, runId);
      results.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content,
        ...(ok ? {} : { is_error: true }),
      });
    }
    messages.push({ role: "user", content: results });
  }

  return { textParts, tokens };
}

/**
 * OpenAI-compatible tool-calling loop. AI_BASE_URL can point this at any
 * OpenAI-compatible endpoint instead of api.openai.com.
 */
async function loopOpenAI(
  opts: { message: string; history?: ChatTurn[] },
  ctx: ToolContext,
  toolCalls: ToolCallLog[],
  runId: string
): Promise<LoopResult> {
  const client = new OpenAI({ baseURL: process.env.AI_BASE_URL || undefined });
  const model = operatorModel("openai");
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = TOOL_DEFINITIONS.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema as unknown as Record<string, unknown>,
    },
  }));
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: OPERATOR_SYSTEM },
    ...(opts.history || []).slice(-12).map((t) => ({ role: t.role, content: t.content })),
    { role: "user" as const, content: opts.message },
  ];
  const textParts: string[] = [];
  let tokens = 0;

  for (let loop = 0; loop < MAX_LOOPS; loop++) {
    const completion = await client.chat.completions.create({
      model,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      messages,
      tools,
    });
    tokens += completion.usage?.total_tokens || 0;

    const assistant = completion.choices[0]?.message;
    const toolUses = (assistant?.tool_calls || []).filter(
      (c): c is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall => c.type === "function"
    );
    const text = (assistant?.content || "").trim();
    if (text) textParts.push(text);

    if (toolUses.length === 0) break;

    messages.push({
      role: "assistant",
      content: assistant?.content ?? null,
      tool_calls: assistant?.tool_calls,
    });

    for (const toolUse of toolUses) {
      let input: Record<string, unknown> = {};
      try {
        input = toolUse.function.arguments
          ? (JSON.parse(toolUse.function.arguments) as Record<string, unknown>)
          : {};
      } catch {
        // Malformed arguments JSON — the tool surfaces it as a failed call.
      }
      const { content } = await callTool(toolUse.function.name, input, ctx, toolCalls, runId);
      messages.push({ role: "tool", tool_call_id: toolUse.id, content });
    }
  }

  return { textParts, tokens };
}

export async function runOperator(opts: {
  supabase: AdminClient;
  origin: string;
  trigger: "chat" | "tick";
  message: string;
  history?: ChatTurn[];
}): Promise<RunResult> {
  const { supabase, origin, trigger } = opts;
  const provider = operatorProvider(); // throws early if nothing is configured

  const { data: run, error: runError } = await supabase
    .from("agent_runs")
    .insert({ trigger, status: "running" })
    .select("id")
    .single();
  if (runError || !run) throw new Error(`Failed to create agent run: ${runError?.message}`);

  const ctx: ToolContext = { supabase, origin, runId: run.id };
  const toolCalls: ToolCallLog[] = [];
  let tokens = 0;

  try {
    const loop = provider === "anthropic" ? loopAnthropic : loopOpenAI;
    const { textParts, tokens: used } = await loop(opts, ctx, toolCalls, run.id);
    tokens = used;

    // Scheduled reviews often write the report mid-run and close with a short
    // sign-off — keep every narrative block so the report survives whole.
    let reply = textParts[textParts.length - 1] || "";
    if (trigger === "tick" && textParts.length > 1) {
      reply = textParts.join("\n\n");
    }

    const summary =
      trigger === "tick"
        ? `Scheduled review — ${toolCalls.length} checks across the house`
        : toolCalls.length > 0
          ? `Chat — used ${toolCalls.map((t) => t.tool).filter((v, i, a) => a.indexOf(v) === i).join(", ")}`
          : "Chat reply";

    await supabase
      .from("agent_runs")
      .update({
        status: "completed",
        summary,
        report_md: reply || null,
        tool_calls: toolCalls as unknown as Json,
        tokens_used: tokens,
        completed_at: new Date().toISOString(),
      })
      .eq("id", run.id);

    return { runId: run.id, reply, toolCalls, tokens };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Agent run failed";
    await supabase
      .from("agent_runs")
      .update({
        status: "failed",
        error: message,
        tool_calls: toolCalls as unknown as Json,
        tokens_used: tokens,
        completed_at: new Date().toISOString(),
      })
      .eq("id", run.id);
    throw e;
  }
}

/**
 * Today's date in YOUR timezone — the one collected during the CRM upgrade and
 * stored in backend_settings (crm_send_window.timezone). The reviews read
 * better when the Operator knows what day it is where you are.
 */
async function reviewDate(supabase: AdminClient): Promise<string> {
  let timeZone = "UTC";
  try {
    const { send_window } = await getCrmSettings(supabase);
    if (send_window?.timezone) timeZone = send_window.timezone;
  } catch {
    // Settings unreadable — UTC is a fine fallback for a date string.
  }
  return new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone,
  });
}

export async function weeklyReviewPrompt(supabase: AdminClient): Promise<string> {
  const today = await reviewDate(supabase);
  return `It's ${today} — time for the weekly growth report. First read your memory (list_insights). Then pull the week's full picture: hottest leads and score movement (list_leads order_by='score' min_score=1), engagement (list_engaged_leads days=7), inbound replies (list_recent_replies days=7), the sales pipeline including stalled deals (list_pipeline), funnel numbers (get_funnel_stats days=7 AND days=14 so you can compare week over week), CRM totals (get_crm_overview), content shipped and planned (get_content_calendar), what content converts (get_content_attribution), and any live subject tests (list_subject_tests). Where the week produced real evidence about what works — subject styles, segments, CTAs — record it with save_insight so next week starts smarter. Where something clearly needs doing — a stalled deal to nudge, a hot lead to follow up, a content gap — propose it via your tools. Then, after ALL tool work, your FINAL message must be the complete report in the exact weekly-growth-report format from your instructions; it must be the whole report, never a follow-up question.`;
}

export async function morningReviewPrompt(supabase: AdminClient): Promise<string> {
  const today = await reviewDate(supabase);
  return `Good morning — it's ${today}. Start by checking your memory (list_insights) so today builds on what you've learned. Then review the whole house and write the morning report: start with the hottest leads (list_leads order_by='score' min_score=1, and list_engaged_leads for recent opens/clicks), then new leads since yesterday (list_leads since_days=1, and get_crm_overview), funnel movement (get_funnel_stats over 7 days), and the content calendar (get_content_calendar). If something is clearly worth doing right now (a follow-up email draft, an article topic), propose it via your tools so it's waiting in the approvals queue. Then — after ALL tool work is done — your FINAL message must be the complete report in the exact morning-report format from your instructions. That final message is saved as the report read over coffee: it must be the whole report, never a follow-up question or a summary of what you queued.`;
}
