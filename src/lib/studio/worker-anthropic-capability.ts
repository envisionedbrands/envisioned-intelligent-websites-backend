export const STUDIO_WORKER_ANTHROPIC_STATUSES = [
  "valid",
  "missing",
  "invalid_provider_credential",
  "provider_permission_denied",
  "billing_required",
  "intermediary_policy_blocked",
  "rate_limited",
  "unavailable",
] as const;

export type StudioWorkerAnthropicStatus = typeof STUDIO_WORKER_ANTHROPIC_STATUSES[number];

export type StudioWorkerAnthropicCode =
  | "worker_anthropic_valid"
  | "worker_anthropic_missing"
  | "worker_anthropic_invalid_provider_credential"
  | "worker_anthropic_provider_permission_denied"
  | "worker_anthropic_billing_required"
  | "worker_anthropic_intermediary_policy_blocked"
  | "worker_anthropic_unverified_rejection"
  | "worker_anthropic_rate_limited"
  | "worker_anthropic_unavailable"
  | "worker_anthropic_unverified_response";

export type StudioWorkerAnthropicProbe = {
  status: StudioWorkerAnthropicStatus;
  code: StudioWorkerAnthropicCode;
  configured: boolean;
  upstream_status: number | null;
  provider_request_id_present: boolean;
  intermediary_trace_present: boolean;
  transport: "direct_anthropic";
  probe: "authenticated_read_only_models_list";
};

export type StudioAnthropicPaidResponse = {
  action: "accept" | "fail_closed_permanent" | "fail_closed_ambiguous";
  upstream_status: number;
  capability_hint: StudioWorkerAnthropicStatus;
  code: StudioWorkerAnthropicCode;
  provider_request_id_present: boolean;
  intermediary_trace_present: boolean;
};

const PROVIDER_REQUEST_ID_HEADERS = ["request-id", "anthropic-request-id"] as const;
const INTERMEDIARY_TRACE_HEADERS = [
  "cf-aig-request-id",
  "cf-aig-log-id",
  "cf-aig-trace-id",
] as const;

function headerPresent(headers: Headers, names: readonly string[]) {
  return names.some((name) => Boolean(headers.get(name)?.trim()));
}

export function studioWorkerAnthropicProbe(
  status: StudioWorkerAnthropicStatus,
  details: {
    configured: boolean;
    code?: StudioWorkerAnthropicCode;
    upstreamStatus?: number | null;
    providerRequestIdPresent?: boolean;
    intermediaryTracePresent?: boolean;
  },
): StudioWorkerAnthropicProbe {
  return {
    status,
    code: details.code ?? `worker_anthropic_${status}`,
    configured: details.configured,
    upstream_status: details.upstreamStatus ?? null,
    provider_request_id_present: details.providerRequestIdPresent ?? false,
    intermediary_trace_present: details.intermediaryTracePresent ?? false,
    transport: "direct_anthropic",
    probe: "authenticated_read_only_models_list",
  };
}

/**
 * Classify only the safe response envelope from Anthropic's read-only models
 * endpoint. The response body, request ids and complete headers are never read
 * or returned. A request-id header is an unauthenticated classification aid,
 * not proof that Anthropic handled the request or that a credential is bad.
 * Requiring that aid is appropriate here only because this probe is read-only
 * and zero-cost; paid Messages responses use a separate trust boundary below.
 */
export function classifyStudioWorkerAnthropicResponse(response: Response): StudioWorkerAnthropicProbe {
  const providerRequestIdPresent = headerPresent(response.headers, PROVIDER_REQUEST_ID_HEADERS);
  const intermediaryTracePresent = headerPresent(response.headers, INTERMEDIARY_TRACE_HEADERS);
  const details = {
    configured: true,
    upstreamStatus: response.status,
    providerRequestIdPresent,
    intermediaryTracePresent,
  };

  if (response.ok) {
    return response.status === 200 && providerRequestIdPresent
      ? studioWorkerAnthropicProbe("valid", details)
      : studioWorkerAnthropicProbe("unavailable", {
        ...details,
        code: "worker_anthropic_unverified_response",
      });
  }
  if (response.status === 402) {
    if (providerRequestIdPresent) return studioWorkerAnthropicProbe("billing_required", details);
    return studioWorkerAnthropicProbe("intermediary_policy_blocked", {
      ...details,
      code: intermediaryTracePresent
        ? "worker_anthropic_intermediary_policy_blocked"
        : "worker_anthropic_unverified_rejection",
    });
  }
  if (response.status === 429) {
    if (providerRequestIdPresent) return studioWorkerAnthropicProbe("rate_limited", details);
    return studioWorkerAnthropicProbe("intermediary_policy_blocked", {
      ...details,
      code: intermediaryTracePresent
        ? "worker_anthropic_intermediary_policy_blocked"
        : "worker_anthropic_unverified_rejection",
    });
  }
  if (response.status === 401 || response.status === 403) {
    if (providerRequestIdPresent) {
      return response.status === 401
        ? studioWorkerAnthropicProbe("invalid_provider_credential", details)
        : studioWorkerAnthropicProbe("provider_permission_denied", details);
    }
    if (!intermediaryTracePresent) {
      return studioWorkerAnthropicProbe("intermediary_policy_blocked", {
        ...details,
        code: "worker_anthropic_unverified_rejection",
      });
    }
    return studioWorkerAnthropicProbe("intermediary_policy_blocked", details);
  }
  if (response.status === 407 || response.status === 451) {
    return studioWorkerAnthropicProbe("intermediary_policy_blocked", details);
  }
  return studioWorkerAnthropicProbe("unavailable", details);
}

/**
 * Classify a response received after submitting a paid Messages request.
 * A successful HTTP 200 is usable without a request-id header: intermediaries
 * may strip that header after Anthropic has generated and billed the response.
 * Conversely, no request-id value authenticates a failed response or proves
 * that the submitted request was unspent. Only the deterministic 400/404/413
 * client failures receive a permanent diagnosis, and only when the header is
 * present as a classification aid. Every other failure remains spend-ambiguous
 * and must never authorize an automatic replay or paid-ledger reset.
 */
export function classifyStudioAnthropicPaidResponse(response: Response): StudioAnthropicPaidResponse {
  const providerRequestIdPresent = headerPresent(response.headers, PROVIDER_REQUEST_ID_HEADERS);
  const intermediaryTracePresent = headerPresent(response.headers, INTERMEDIARY_TRACE_HEADERS);

  if (response.ok && response.status === 200) {
    return {
      action: "accept",
      upstream_status: response.status,
      capability_hint: "valid",
      code: "worker_anthropic_valid",
      provider_request_id_present: providerRequestIdPresent,
      intermediary_trace_present: intermediaryTracePresent,
    };
  }

  const hint = classifyStudioWorkerAnthropicResponse(response);
  const permanentClientFailure = providerRequestIdPresent
    && (response.status === 400 || response.status === 404 || response.status === 413);
  return {
    action: permanentClientFailure ? "fail_closed_permanent" : "fail_closed_ambiguous",
    upstream_status: response.status,
    capability_hint: hint.status,
    code: hint.code,
    provider_request_id_present: providerRequestIdPresent,
    intermediary_trace_present: intermediaryTracePresent,
  };
}

export function studioWorkerAnthropicHttpStatus(status: StudioWorkerAnthropicStatus) {
  if (status === "valid") return 200;
  if (status === "intermediary_policy_blocked") return 502;
  return 503;
}
