import type { createAdminClient } from "@/lib/supabase/server";

type AdminClient = ReturnType<typeof createAdminClient>;
type RpcResult = { data: unknown; error: { message: string } | null };
type RpcClient = { rpc: (name: string, args: Record<string, unknown>) => Promise<RpcResult> };

type CarouselDecisionReceipt = {
  state?: "applied" | "replayed" | "conflict" | "not_found";
  job_id?: string;
  post_id?: string;
  decision?: "approve" | "reject";
  decision_operation_id?: string;
  scheduled_at?: string | null;
  reason?: string;
};

export async function decideStudioCarousel(
  supabase: AdminClient,
  input: {
    jobId: string;
    decision: "approve" | "reject";
    decisionOperationId: string;
    scheduledAt: string | null;
  },
): Promise<
  | { ok: true; state: "applied" | "replayed"; decision: "approve" | "reject"; scheduled_at: string | null }
  | { error: string; status: number }
> {
  const { data, error } = await (supabase as unknown as RpcClient).rpc(
    "studio_decide_carousel_operation",
    {
      p_job_id: input.jobId,
      p_decision: input.decision,
      p_decision_operation_id: input.decisionOperationId,
      p_scheduled_at: input.scheduledAt,
    },
  );
  if (error) return { error: error.message, status: 500 };
  const receipt = data as CarouselDecisionReceipt | null;
  if (!receipt || typeof receipt !== "object") {
    return { error: "The carousel decision returned no database receipt", status: 500 };
  }
  if (receipt.state === "not_found") return { error: "Carousel not found", status: 404 };
  if (receipt.state === "conflict") {
    return {
      error: receipt.reason?.trim() || "This carousel has already been decided in another request",
      status: 409,
    };
  }
  if (
    (receipt.state !== "applied" && receipt.state !== "replayed")
    || receipt.job_id !== input.jobId
    || receipt.decision !== input.decision
    || receipt.decision_operation_id !== input.decisionOperationId
    || (input.decision === "approve" && typeof receipt.scheduled_at !== "string")
    || (input.decision === "reject" && receipt.scheduled_at != null)
  ) {
    return { error: "The carousel decision returned an incomplete database receipt", status: 500 };
  }
  return {
    ok: true,
    state: receipt.state,
    decision: receipt.decision,
    scheduled_at: receipt.scheduled_at ?? null,
  };
}
