export const ANTHROPIC_CAPABILITY_STATUSES = Object.freeze([
  "missing",
  "unverified",
  "valid",
  "invalid_provider_credential",
  "provider_permission_denied",
  "billing_required",
  "intermediary_policy_blocked",
  "rate_limited",
  "unavailable",
]);

export const ANTHROPIC_MODELS_PROBE_URL =
  "https://api.anthropic.com/v1/models?limit=1";

const providerRequestIdPresent = (response) =>
  Boolean(response?.headers?.get?.("request-id")?.trim())
  || Boolean(response?.headers?.get?.("anthropic-request-id")?.trim());

export function anthropicCapabilityFromResponse(response) {
  const providerReceipt = providerRequestIdPresent(response);
  if (response?.ok) return response.status === 200 && providerReceipt ? "valid" : "unavailable";
  if (response?.status === 402) {
    return providerReceipt ? "billing_required" : "intermediary_policy_blocked";
  }
  if (response?.status === 429) {
    return providerReceipt ? "rate_limited" : "intermediary_policy_blocked";
  }
  if (response?.status === 401 || response?.status === 403) {
    if (providerReceipt) {
      return response.status === 401
        ? "invalid_provider_credential"
        : "provider_permission_denied";
    }
    return "intermediary_policy_blocked";
  }
  if (response?.status === 407 || response?.status === 451) {
    return "intermediary_policy_blocked";
  }
  return "unavailable";
}

export function anthropicMessageFailureAction(response) {
  const capability = anthropicCapabilityFromResponse(response);
  const providerReceipt = providerRequestIdPresent(response);
  const permanentClientFailure = providerReceipt
    && (response?.status === 400 || response?.status === 404 || response?.status === 413);
  return {
    capability,
    action: permanentClientFailure
      ? "fail_closed_permanent"
      : "fail_closed_ambiguous",
    status: Number.isInteger(response?.status) ? response.status : null,
  };
}

export function anthropicMessageFailureMessage(failure) {
  if (failure?.action === "fail_closed_permanent") {
    switch (failure.status) {
      case 400:
        return "Anthropic permanently rejected the carousel request as invalid (HTTP 400). Correct the request or local Studio configuration before sending a new request.";
      case 404:
        return "Anthropic could not find the configured Messages resource (HTTP 404). Correct the local endpoint or model before sending a new request.";
      case 413:
        return "Anthropic permanently rejected the carousel payload as too large (HTTP 413). Reduce the carousel draft before sending a new request.";
    }
  }
  return "Anthropic returned a spend-ambiguous response after the paid carousel request was submitted. Studio did not retry it automatically; verify the direct Anthropic path before sending a new request.";
}

/**
 * Perform a bounded, authenticated, read-only capability probe. The probe
 * lists one model; it never submits content, creates a message, or spends
 * generation tokens. Network and provider failures remain distinguishable
 * from a credential rejection so a transient outage cannot invalidate a key.
 */
export async function probeAnthropicCapability({ apiKey, fetcher }) {
  if (!apiKey?.trim()) return "missing";
  try {
    const response = await fetcher(ANTHROPIC_MODELS_PROBE_URL, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    const capability = anthropicCapabilityFromResponse(response);
    await response.body?.cancel?.().catch(() => undefined);
    return capability;
  } catch {
    return "unavailable";
  }
}

export function anthropicCapabilityRemediation(status) {
  switch (status) {
    case "missing":
      return "ANTHROPIC_API_KEY is missing. Store it locally with scripts/configure-studio-runner-secret.sh, then rerun runner setup.";
    case "invalid_provider_credential":
      return "Anthropic returned a 401 with a request-id classification hint. That unauthenticated header does not prove the key is bad; verify the direct Anthropic path and the key in the Anthropic account before replacing it, then rerun runner setup.";
    case "provider_permission_denied":
      return "Anthropic returned a 403 with a request-id classification hint. The unauthenticated header is not proof; do not rotate the key automatically. Check the direct path and Anthropic account permissions, then rerun runner setup.";
    case "billing_required":
      return "Anthropic returned a 402 with a request-id classification hint. The header is not authentication; check the direct path and Anthropic account billing/spend settings, then rerun runner setup.";
    case "intermediary_policy_blocked":
      return "The local runner request was rejected without an Anthropic request-id classification hint. The key has not been marked invalid; check local network/intermediary policy, then rerun runner setup.";
    case "rate_limited":
      return "The local runner Anthropic proof was temporarily rate- or spend-limited. Wait and rerun runner setup; do not replace the key.";
    case "unavailable":
      return "Anthropic could not be verified right now. Check connectivity and rerun runner setup; do not replace the key based only on response headers.";
    case "unverified":
      return "Anthropic has not been verified yet. Rerun runner setup.";
    default:
      return null;
  }
}

/**
 * Kept for older callers that only retained the numeric status. Neither a
 * status nor an unauthenticated request-id header can prove credential
 * invalidity or that a paid request was unspent.
 */
export function anthropicCapabilityFromMessageStatus(status) {
  void status;
  return null;
}

/**
 * Drain a capability-gated queue without claiming a second item when processing
 * explicitly defers the lane. Paid response failures never reset their job;
 * the next pass obtains a fresh zero-cost capability classification instead.
 */
export async function drainAnthropicGatedQueue({ getCapability, claim, process }) {
  if (getCapability() !== "valid") return "deferred";
  for (;;) {
    const job = await claim();
    if (!job) return "complete";
    const result = await process(job);
    if (result === "deferred" || getCapability() !== "valid") return "deferred";
  }
}
