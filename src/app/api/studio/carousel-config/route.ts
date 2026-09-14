import { NextRequest, NextResponse } from 'next/server';
import { studioAuth } from '@/lib/studio/auth';
import { createAdminClient } from '@/lib/supabase/server';
import { loadCarouselConfig } from '@/lib/studio/carousel-config';
import { isCarouselRenderer, isHouseLook } from '@/lib/studio/house-looks';
import {
  canonicalCarouselConfigReceipt,
  CAROUSEL_CONFIG_ISSUE_MESSAGES,
  CAROUSEL_CONFIG_KEY,
  validateCarouselConfigReceipt,
} from '@/lib/studio/carousel-template-registry';

export async function GET(request: NextRequest) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });
  return NextResponse.json({ config: await loadCarouselConfig() });
}

export async function POST(request: NextRequest) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });
  const body = (await request.json().catch(() => null)) as {
    house_look?: unknown;
    renderer?: unknown;
    template_id?: unknown;
    template_version?: unknown;
    contract_revision?: unknown;
  } | null;
  if (!body) {
    return NextResponse.json({ error: 'A complete carousel configuration receipt is required', code: 'config_receipt_invalid' }, { status: 400 });
  }
  const allowedKeys = new Set(['house_look', 'renderer', 'template_id', 'template_version', 'contract_revision']);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    return NextResponse.json({ error: 'The carousel configuration receipt contains unsupported fields', code: 'config_receipt_invalid' }, { status: 400 });
  }
  if (!isHouseLook(body.house_look)) {
    return NextResponse.json(
      { error: 'house_look must be cobalt, editorial, explainer, manifesto, or threshold', code: 'config_receipt_invalid' },
      { status: 400 },
    );
  }
  const renderer = body.renderer === undefined ? 'content_manager' : body.renderer;
  if (!isCarouselRenderer(renderer)) {
    return NextResponse.json(
      { error: 'renderer must be content_manager or factory', code: 'config_receipt_invalid' },
      { status: 400 },
    );
  }
  const templateFieldCount = [body.template_id, body.template_version, body.contract_revision]
    .filter((value) => value !== undefined)
    .length;
  if (templateFieldCount > 0 && templateFieldCount < 3) {
    return NextResponse.json(
      {
        error: 'When one template field is supplied, template_id, template_version, and contract_revision are all required',
        code: 'config_receipt_invalid',
      },
      { status: 400 },
    );
  }
  // Bob's stable selection contract stays small: { house_look, renderer }.
  // The backend resolves that choice to the exact compiled tuple. Advanced
  // callers may send the tuple as a parity proof, but partial or stale tuples
  // fail closed instead of being silently corrected.
  const candidate = templateFieldCount === 0
    ? canonicalCarouselConfigReceipt(body.house_look, renderer)
    : {
        house_look: body.house_look,
        renderer,
        template_id: body.template_id,
        template_version: body.template_version,
        contract_revision: body.contract_revision,
      };
  const validation = validateCarouselConfigReceipt(candidate);
  if (!validation.ok) {
    return NextResponse.json(
      {
        error: CAROUSEL_CONFIG_ISSUE_MESSAGES[validation.issue],
        code: validation.issue,
        expected: canonicalCarouselConfigReceipt(body.house_look, renderer),
      },
      { status: validation.issue === 'template_contract_mismatch' ? 409 : 400 },
    );
  }
  if (renderer === 'factory' && process.env.CAROUSEL_FACTORY_ENABLED !== 'true') {
    return NextResponse.json(
      { error: CAROUSEL_CONFIG_ISSUE_MESSAGES.factory_not_enabled, code: 'factory_not_enabled' },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();
  const receipt = validation.receipt;
  // One PostgREST bulk upsert is one database statement: the authoritative
  // receipt and both compatibility rows either all land or none do. Older
  // look-only writers remain diagnostic only and can never make GET ready.
  const rows = [
    { key: CAROUSEL_CONFIG_KEY, value: receipt as never, updated_at: now },
    { key: 'content_house_look', value: receipt.house_look as never, updated_at: now },
    { key: 'carousel_renderer', value: receipt.renderer as never, updated_at: now },
  ];
  const supabase = createAdminClient();
  const { error } = await supabase.from('backend_settings').upsert(rows, { onConflict: 'key' });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const config = await loadCarouselConfig(supabase);
  if (!config.ready || config.issue) {
    const issue = config.issue ?? 'config_receipt_invalid';
    return NextResponse.json(
      { error: CAROUSEL_CONFIG_ISSUE_MESSAGES[issue], code: issue, config },
      { status: 500 },
    );
  }
  return NextResponse.json({ success: true, config });
}
