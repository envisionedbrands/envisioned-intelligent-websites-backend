export const STUDIO_RUNNER_FAILURE_CODES = [
  'lock_config_invalid',
  'lock_unavailable',
  'lock_squatter',
  'carousel_toolchain_unavailable',
] as const;

export type StudioRunnerFailureCode = (typeof STUDIO_RUNNER_FAILURE_CODES)[number];

export const STUDIO_ANTHROPIC_CAPABILITY_STATUSES = [
  'missing',
  'unverified',
  'valid',
  'invalid_provider_credential',
  'provider_permission_denied',
  'billing_required',
  'intermediary_policy_blocked',
  'rate_limited',
  'unavailable',
] as const;

export type StudioAnthropicCapabilityStatus =
  (typeof STUDIO_ANTHROPIC_CAPABILITY_STATUSES)[number];

export function studioAnthropicCapabilityMessage(
  status: StudioAnthropicCapabilityStatus | null | undefined,
): string {
  switch (status) {
    case 'missing':
      return 'Anthropic is not connected to the local Studio runner. Ask your setup agent to connect it locally, then rerun runner setup.';
    case 'invalid_provider_credential':
      return 'Anthropic returned a 401 with a request-id classification hint. That unauthenticated header does not prove the local runner key is bad; ask your setup agent to verify the direct path and key before replacing it.';
    case 'provider_permission_denied':
      return 'Anthropic returned a 403 with a request-id classification hint. The header is not proof; do not rotate the key automatically. Ask your setup agent to check the direct path and Anthropic account permissions.';
    case 'billing_required':
      return 'Anthropic returned a 402 with a request-id classification hint. The header is not authentication; ask your setup agent to check the direct path and Anthropic account billing settings.';
    case 'intermediary_policy_blocked':
      return 'The local runner request was rejected without an Anthropic request-id classification hint. The key has not been marked invalid; ask your setup agent to check local network or intermediary policy.';
    case 'rate_limited':
      return 'The local runner Anthropic proof was temporarily rate- or spend-limited. Wait and retry; do not replace the key.';
    case 'unavailable':
      return 'Anthropic could not be verified from the local runner right now. Wait and retry; the key has not been marked invalid.';
    default:
      return 'The local Studio runner has not verified Anthropic yet. Ask your setup agent to rerun runner setup.';
  }
}

export function isStudioRunnerFailureCode(value: unknown): value is StudioRunnerFailureCode {
  return typeof value === 'string'
    && (STUDIO_RUNNER_FAILURE_CODES as readonly string[]).includes(value);
}

/** Safe, member-facing taxonomy. Hostnames, ports, paths and raw local errors
 * stay in the runner log and never cross the browser boundary. */
export function studioRunnerFailureMessage(code: unknown): string | null {
  switch (code) {
    case 'lock_config_invalid':
      return 'Studio runner setup has an invalid lock setting. Ask your setup agent to rerun Studio runner setup.';
    case 'lock_unavailable':
      return 'Studio could not reserve a safe local runner lock. Ask your setup agent to rerun Studio runner setup.';
    case 'lock_squatter':
      return 'Other local services are occupying every shared Studio runner lock. Ask your setup agent to resolve the local port conflict and rerun Studio runner setup.';
    case 'carousel_toolchain_unavailable':
      return 'Studio could not verify its local Chrome carousel toolchain. Ask your setup agent to rerun Studio runner setup; no HOUSE work will be claimed until it passes.';
    default:
      return null;
  }
}

export type StudioRunnerHealth = {
  status: 'unknown' | 'ready' | 'stale' | 'blocked';
  failure_code: StudioRunnerFailureCode | null;
  capabilities: {
    fal_configured: boolean;
    fal_ready: boolean;
    openai_configured: boolean;
    anthropic_configured: boolean;
    anthropic_status: StudioAnthropicCapabilityStatus;
    carousel_ready: boolean;
  } | null;
  last_seen_at?: string;
  stale?: boolean;
  message?: string | null;
};
