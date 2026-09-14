import { NextRequest, NextResponse } from "next/server";
import { studioAuth, studioMachineAuth } from "@/lib/studio/auth";
import {
  STUDIO_ANTHROPIC_CAPABILITY_STATUSES,
  isStudioRunnerFailureCode,
  studioRunnerFailureMessage,
  type StudioAnthropicCapabilityStatus,
  type StudioRunnerFailureCode,
} from "@/lib/studio/runner-health";
import { expectedStudioRunnerInstanceId } from "@/lib/studio/runner-server-identity";
import { STUDIO_CAROUSEL_RUNNER_PROTOCOL } from "@/lib/studio/carousel-execution";
import { createAdminClient } from "@/lib/supabase/server";

const RUNNER_STATUSES = new Set(["ready", "blocked"]);
const FRESH_FOR_MS = 2 * 60_000;

type RunnerCapabilities = {
  fal_configured: boolean;
  fal_ready: boolean;
  openai_configured: boolean;
  anthropic_configured: boolean;
  anthropic_status: StudioAnthropicCapabilityStatus;
  carousel_ready: boolean;
};

function safeCapabilities(raw: unknown): RunnerCapabilities | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.fal_configured !== "boolean"
    || typeof value.fal_ready !== "boolean"
    || typeof value.openai_configured !== "boolean"
    || typeof value.anthropic_configured !== "boolean"
    || typeof value.anthropic_status !== "string"
    || typeof value.carousel_ready !== "boolean"
    || !(STUDIO_ANTHROPIC_CAPABILITY_STATUSES as readonly string[]).includes(value.anthropic_status)
  ) {
    return null;
  }
  const anthropicStatus = value.anthropic_status as StudioAnthropicCapabilityStatus;
  if (
    (!value.anthropic_configured && anthropicStatus !== "missing")
    || (value.anthropic_configured && anthropicStatus === "missing")
  ) return null;
  return {
    fal_configured: value.fal_configured,
    fal_ready: value.fal_ready,
    openai_configured: value.openai_configured,
    anthropic_configured: value.anthropic_configured,
    anthropic_status: anthropicStatus,
    carousel_ready: value.carousel_ready,
  };
}

/** Machine-only heartbeat. Arbitrary messages, hostnames and local paths are
 * deliberately not accepted, persisted or returned to the browser. */
export async function POST(request: NextRequest) {
  const auth = studioMachineAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (request.headers.get("x-studio-carousel-protocol") !== STUDIO_CAROUSEL_RUNNER_PROTOCOL) {
    return NextResponse.json(
      {
        error: "Studio runner 1.6.7 setup is required before health can be refreshed.",
        code: "studio_carousel_runner_upgrade_required",
      },
      { status: 426 },
    );
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const instanceId = typeof body?.instance_id === "string" ? body.instance_id : "";
  const status = typeof body?.status === "string" ? body.status : "";
  const failureCode = body?.failure_code == null ? null : String(body.failure_code);
  const capabilities = safeCapabilities(body?.capabilities);
  if (!/^[a-f0-9]{12}$/.test(instanceId) || !RUNNER_STATUSES.has(status) || !capabilities) {
    return NextResponse.json({ error: "Invalid runner health receipt" }, { status: 400 });
  }
  let expectedInstanceId: string;
  try {
    expectedInstanceId = await expectedStudioRunnerInstanceId(request.url);
  } catch {
    return NextResponse.json({ error: "Runner identity is not configured" }, { status: 503 });
  }
  if (instanceId !== expectedInstanceId) {
    return NextResponse.json({ error: "Runner identity does not match this backend origin" }, { status: 409 });
  }
  if (
    (status === "ready" && failureCode !== null)
    || (status === "blocked" && !isStudioRunnerFailureCode(failureCode))
  ) {
    return NextResponse.json({ error: "Invalid runner health state" }, { status: 400 });
  }
  const runnerStatus = status as "ready" | "blocked";
  const safeFailureCode = failureCode as StudioRunnerFailureCode | null;

  const now = new Date().toISOString();
  const supabase = createAdminClient();
  const { error } = await supabase.from("studio_runner_health").upsert({
    instance_id: instanceId,
    status: runnerStatus,
    failure_code: safeFailureCode,
    capabilities,
    last_seen_at: now,
    updated_at: now,
  }, { onConflict: "instance_id" });
  if (error) return NextResponse.json({ error: "Runner health could not be saved" }, { status: 503 });
  return NextResponse.json({ ok: true });
}

/** Member-session read. Only the safe state taxonomy and capability booleans
 * cross this boundary; machine identity remains server-side. */
export async function GET(request: NextRequest) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });
  const supabase = createAdminClient();
  let expectedInstanceId: string;
  try {
    expectedInstanceId = await expectedStudioRunnerInstanceId(request.url);
  } catch {
    return NextResponse.json({ error: "Runner identity is not configured" }, { status: 503 });
  }
  const { data, error } = await supabase
    .from("studio_runner_health")
    .select("status,failure_code,capabilities,last_seen_at")
    .eq("instance_id", expectedInstanceId)
    .order("last_seen_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Runner health could not be read" }, { status: 503 });
  if (!data) {
    return NextResponse.json({ runner: { status: "unknown", failure_code: null, capabilities: null, message: null } });
  }
  const fresh = Date.now() - new Date(data.last_seen_at).getTime() <= FRESH_FOR_MS;
  const blocked = data.status === "blocked";
  return NextResponse.json({
    runner: {
      // A lock failure is durable setup state, not a liveness heartbeat. Keep
      // its exact safe code visible until a runner successfully starts and
      // overwrites it with ready. Only an old ready heartbeat becomes stale.
      status: blocked ? "blocked" : fresh ? "ready" : "stale",
      failure_code: blocked ? data.failure_code : null,
      capabilities: safeCapabilities(data.capabilities),
      last_seen_at: data.last_seen_at,
      stale: !fresh,
      message: blocked ? studioRunnerFailureMessage(data.failure_code) : null,
    },
  }, { headers: { "Cache-Control": "no-store" } });
}
