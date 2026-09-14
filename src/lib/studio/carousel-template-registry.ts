import type { CarouselRenderer, HouseLook } from '@/lib/studio/house-looks';

export const CAROUSEL_CONFIG_KEY = 'studio_carousel_config' as const;
export const CAROUSEL_CONFIG_CONTRACT_REVISION = 'studio_carousel_config_v1' as const;
export const CAROUSEL_TEMPLATE_VERSION = '1' as const;

/**
 * The portable carousel boundary. A saved choice is not executable merely
 * because it names a look: it must name the exact template compiled into this
 * Studio release. The local HOUSE renderer and the optional factory both use
 * the same signed look tuple; `renderer` only selects who executes it.
 */
export const CAROUSEL_TEMPLATE_REGISTRY = {
  cobalt: { template_id: 'house-cobalt-v1', template_version: CAROUSEL_TEMPLATE_VERSION },
  editorial: { template_id: 'house-editorial-v1', template_version: CAROUSEL_TEMPLATE_VERSION },
  explainer: { template_id: 'house-explainer-v1', template_version: CAROUSEL_TEMPLATE_VERSION },
  manifesto: { template_id: 'house-manifesto-v1', template_version: CAROUSEL_TEMPLATE_VERSION },
  threshold: { template_id: 'house-threshold-v1', template_version: CAROUSEL_TEMPLATE_VERSION },
} as const satisfies Record<HouseLook, { template_id: string; template_version: typeof CAROUSEL_TEMPLATE_VERSION }>;

export type CarouselTemplateId = (typeof CAROUSEL_TEMPLATE_REGISTRY)[HouseLook]['template_id'];

export type CarouselConfigReceipt = {
  house_look: HouseLook;
  renderer: CarouselRenderer;
  template_id: CarouselTemplateId;
  template_version: typeof CAROUSEL_TEMPLATE_VERSION;
  contract_revision: typeof CAROUSEL_CONFIG_CONTRACT_REVISION;
};

export type CarouselConfigIssue =
  | 'house_look_required'
  | 'legacy_look_only_config'
  | 'config_receipt_invalid'
  | 'template_contract_mismatch'
  | 'factory_not_enabled'
  | 'config_unavailable';

export type CarouselConfig = {
  receipt: CarouselConfigReceipt | null;
  house_look: HouseLook | null;
  renderer: CarouselRenderer;
  template_id: CarouselTemplateId | null;
  template_version: typeof CAROUSEL_TEMPLATE_VERSION | null;
  contract_revision: typeof CAROUSEL_CONFIG_CONTRACT_REVISION | null;
  factory_enabled: boolean;
  ready: boolean;
  issue: CarouselConfigIssue | null;
  legacy: {
    house_look: HouseLook | null;
    renderer: CarouselRenderer | null;
  };
};

export const CAROUSEL_CONFIG_ISSUE_MESSAGES: Record<CarouselConfigIssue, string> = {
  house_look_required:
    'Choose your house look with your Content Manager in Buzz first. Studio needs the signed template choice before it can queue a carousel.',
  legacy_look_only_config:
    'This house look was saved by an older Studio contract. Ask your Content Manager to save the choice again so the exact signed template is recorded.',
  config_receipt_invalid:
    'The saved carousel configuration receipt is incomplete or malformed. Ask your Builder to repair the Studio setup before queueing.',
  template_contract_mismatch:
    'The saved carousel template does not match this Studio release. Re-save the house look after upgrading the Content Manager training.',
  factory_not_enabled:
    'This Digital Home is set to use the bespoke carousel factory, but that capability is not installed. Switch back to the Content Manager renderer or install the factory.',
  config_unavailable:
    'Studio could not verify the carousel configuration. Wait a moment and retry; if it persists, ask your Builder to check the backend.',
};

const RECEIPT_KEYS = [
  'contract_revision',
  'house_look',
  'renderer',
  'template_id',
  'template_version',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isHouseLook(value: unknown): value is HouseLook {
  return typeof value === 'string' && Object.hasOwn(CAROUSEL_TEMPLATE_REGISTRY, value);
}

function isCarouselRenderer(value: unknown): value is CarouselRenderer {
  return value === 'content_manager' || value === 'factory';
}

export function canonicalCarouselConfigReceipt(
  houseLook: HouseLook,
  renderer: CarouselRenderer = 'content_manager',
): CarouselConfigReceipt {
  const template = CAROUSEL_TEMPLATE_REGISTRY[houseLook];
  return {
    house_look: houseLook,
    renderer,
    template_id: template.template_id,
    template_version: template.template_version,
    contract_revision: CAROUSEL_CONFIG_CONTRACT_REVISION,
  };
}

export function validateCarouselConfigReceipt(value: unknown):
  | { ok: true; receipt: CarouselConfigReceipt }
  | { ok: false; issue: 'config_receipt_invalid' | 'template_contract_mismatch' } {
  if (!isPlainObject(value)) return { ok: false, issue: 'config_receipt_invalid' };
  const keys = Object.keys(value).sort();
  if (keys.length !== RECEIPT_KEYS.length || RECEIPT_KEYS.some((key, index) => key !== keys[index])) {
    return { ok: false, issue: 'config_receipt_invalid' };
  }
  if (!isHouseLook(value.house_look) || !isCarouselRenderer(value.renderer)) {
    return { ok: false, issue: 'config_receipt_invalid' };
  }
  if (
    typeof value.template_id !== 'string'
    || typeof value.template_version !== 'string'
    || typeof value.contract_revision !== 'string'
  ) {
    return { ok: false, issue: 'config_receipt_invalid' };
  }
  const expected = canonicalCarouselConfigReceipt(value.house_look, value.renderer);
  if (
    value.template_id !== expected.template_id
    || value.template_version !== expected.template_version
    || value.contract_revision !== expected.contract_revision
  ) {
    return { ok: false, issue: 'template_contract_mismatch' };
  }
  return { ok: true, receipt: expected };
}

export function resolveCarouselConfig({
  canonicalValue,
  legacyHouseLook,
  legacyRenderer,
  factoryEnabled,
  unavailable = false,
}: {
  canonicalValue?: unknown;
  legacyHouseLook?: unknown;
  legacyRenderer?: unknown;
  factoryEnabled: boolean;
  unavailable?: boolean;
}): CarouselConfig {
  const legacyLook = isHouseLook(legacyHouseLook) ? legacyHouseLook : null;
  const legacyExecutor = isCarouselRenderer(legacyRenderer) ? legacyRenderer : null;
  const base = {
    factory_enabled: factoryEnabled,
    legacy: { house_look: legacyLook, renderer: legacyExecutor },
  };
  if (unavailable) {
    return {
      ...base,
      receipt: null,
      house_look: null,
      renderer: 'content_manager',
      template_id: null,
      template_version: null,
      contract_revision: null,
      ready: false,
      issue: 'config_unavailable',
    };
  }
  if (canonicalValue === undefined) {
    return {
      ...base,
      receipt: null,
      house_look: legacyLook,
      renderer: legacyExecutor ?? 'content_manager',
      template_id: null,
      template_version: null,
      contract_revision: null,
      ready: false,
      issue: legacyLook ? 'legacy_look_only_config' : 'house_look_required',
    };
  }
  const validation = validateCarouselConfigReceipt(canonicalValue);
  if (!validation.ok) {
    return {
      ...base,
      receipt: null,
      house_look: isPlainObject(canonicalValue) && isHouseLook(canonicalValue.house_look)
        ? canonicalValue.house_look
        : null,
      renderer: isPlainObject(canonicalValue) && isCarouselRenderer(canonicalValue.renderer)
        ? canonicalValue.renderer
        : 'content_manager',
      template_id: null,
      template_version: null,
      contract_revision: null,
      ready: false,
      issue: validation.issue,
    };
  }
  const receipt = validation.receipt;
  const issue = receipt.renderer === 'factory' && !factoryEnabled ? 'factory_not_enabled' : null;
  return {
    ...base,
    receipt,
    house_look: receipt.house_look,
    renderer: receipt.renderer,
    template_id: receipt.template_id,
    template_version: receipt.template_version,
    contract_revision: receipt.contract_revision,
    ready: issue === null,
    issue,
  };
}

export type CarouselJobResult = {
  config_receipt?: CarouselConfigReceipt;
  contact_sheet_url?: string | null;
  contact_sheet_receipt?: {
    contract_revision: 'studio_carousel_contact_sheet_v1';
    columns: 2;
    rows: 5;
    numbered: true;
    slide_total: 10;
  } | null;
  slide_urls?: string[] | null;
  slide_total?: number | null;
  scheduled_at?: string | null;
};

type CarouselJobResultPatch = {
  config_receipt?: unknown;
  contact_sheet_url?: string;
  contact_sheet_receipt?: CarouselJobResult['contact_sheet_receipt'];
  slide_urls?: string[];
  slide_total?: number;
};

function resultObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sameCanonicalReceipt(left: unknown, right: unknown): boolean {
  const current = validateCarouselConfigReceipt(left);
  const proposed = validateCarouselConfigReceipt(right);
  return current.ok && proposed.ok
    && JSON.stringify(current.receipt) === JSON.stringify(proposed.receipt);
}

/** Merge runner progress without allowing the queue-time renderer contract to
 * change after the human has filed the job. Kept in this dependency-free core
 * so the executable release proof exercises the same logic the route uses. */
export function mergeCarouselJobResult(
  previousValue: unknown,
  patch: CarouselJobResultPatch,
  scheduledAt?: string,
):
  | { ok: true; result: CarouselJobResult }
  | { ok: false; issue: 'config_receipt_immutable' } {
  const previous = resultObject(previousValue);
  const hasPreviousReceipt = Object.hasOwn(previous, 'config_receipt');
  const hasPatchReceipt = Object.hasOwn(patch, 'config_receipt');
  const currentReceipt = hasPreviousReceipt
    ? validateCarouselConfigReceipt(previous.config_receipt)
    : null;
  if (currentReceipt && !currentReceipt.ok) {
    return { ok: false, issue: 'config_receipt_immutable' };
  }
  if (
    hasPatchReceipt
    && (!hasPreviousReceipt || !sameCanonicalReceipt(previous.config_receipt, patch.config_receipt))
  ) {
    return { ok: false, issue: 'config_receipt_immutable' };
  }

  const result: CarouselJobResult = {
    contact_sheet_url: patch.contact_sheet_url
      ?? (typeof previous.contact_sheet_url === 'string' ? previous.contact_sheet_url : null),
    contact_sheet_receipt: patch.contact_sheet_receipt
      ?? (previous.contact_sheet_receipt && typeof previous.contact_sheet_receipt === 'object'
        ? previous.contact_sheet_receipt as CarouselJobResult['contact_sheet_receipt']
        : null),
    slide_urls: Array.isArray(patch.slide_urls)
      ? patch.slide_urls.slice(0, 10)
      : Array.isArray(previous.slide_urls)
        ? previous.slide_urls.filter((url): url is string => typeof url === 'string').slice(0, 10)
        : null,
    slide_total: typeof patch.slide_total === 'number'
      ? Math.max(1, Math.min(10, Math.round(patch.slide_total)))
      : typeof previous.slide_total === 'number'
        ? Math.max(1, Math.min(10, Math.round(previous.slide_total)))
        : null,
    ...(scheduledAt
      ? { scheduled_at: scheduledAt }
      : typeof previous.scheduled_at === 'string' && previous.scheduled_at
        ? { scheduled_at: previous.scheduled_at }
        : {}),
  };
  if (currentReceipt?.ok) result.config_receipt = currentReceipt.receipt;
  return { ok: true, result };
}
