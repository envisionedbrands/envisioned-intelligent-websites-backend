import { NextRequest, NextResponse } from "next/server";
import { studioMachineAuth } from "@/lib/studio/auth";
import {
  classifyStudioWorkerAnthropicResponse,
  studioWorkerAnthropicHttpStatus,
  studioWorkerAnthropicProbe,
  type StudioWorkerAnthropicProbe,
} from "@/lib/studio/worker-anthropic-capability";

const ANTHROPIC_MODELS_PROBE_URL = "https://api.anthropic.com/v1/models?limit=1";
const ANTHROPIC_PROBE_TIMEOUT_MS = 10_000;

function responseFor(probe: StudioWorkerAnthropicProbe) {
  return NextResponse.json(probe, {
    status: studioWorkerAnthropicHttpStatus(probe.status),
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Machine-only proof of the deployed Worker's own Anthropic path. This is
 * deliberately separate from the local runner probe: it reads the Worker's
 * secret and makes a bounded, zero-token request directly to Anthropic. It
 * never follows an AI Gateway URL, submits a prompt, reads the response body,
 * or returns request ids, headers or credentials.
 */
export async function GET(request: NextRequest) {
  const auth = studioMachineAuth(request);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    return responseFor(studioWorkerAnthropicProbe("missing", { configured: false }));
  }

  try {
    // The Workers runtime rejects redirect:"error" with a TypeError. "manual"
    // returns any 3xx unfollowed (the key is never forwarded) and the
    // classifier below fails that response closed as unavailable.
    const upstream = await fetch(ANTHROPIC_MODELS_PROBE_URL, {
      method: "GET",
      cache: "no-store",
      redirect: "manual",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(ANTHROPIC_PROBE_TIMEOUT_MS),
    });
    const probe = classifyStudioWorkerAnthropicResponse(upstream);
    await upstream.body?.cancel().catch(() => undefined);
    return responseFor(probe);
  } catch {
    return responseFor(studioWorkerAnthropicProbe("unavailable", { configured: true }));
  }
}
