#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalCarouselConfigReceipt,
  CAROUSEL_CONFIG_CONTRACT_REVISION,
  CAROUSEL_CONFIG_KEY,
  CAROUSEL_TEMPLATE_REGISTRY,
  CAROUSEL_TEMPLATE_VERSION,
  mergeCarouselJobResult,
  resolveCarouselConfig,
  validateCarouselConfigReceipt,
} from '../src/lib/studio/carousel-template-registry.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

assert.equal(CAROUSEL_CONFIG_KEY, 'studio_carousel_config');
assert.equal(CAROUSEL_CONFIG_CONTRACT_REVISION, 'studio_carousel_config_v1');
assert.equal(CAROUSEL_TEMPLATE_VERSION, '1', 'template_version must remain a string at the JSON boundary');
assert.deepEqual(
  Object.fromEntries(Object.entries(CAROUSEL_TEMPLATE_REGISTRY).map(([look, value]) => [look, value.template_id])),
  {
    cobalt: 'house-cobalt-v1',
    editorial: 'house-editorial-v1',
    explainer: 'house-explainer-v1',
    manifesto: 'house-manifesto-v1',
    threshold: 'house-threshold-v1',
  },
);

for (const look of Object.keys(CAROUSEL_TEMPLATE_REGISTRY)) {
  for (const renderer of ['content_manager', 'factory']) {
    const receipt = canonicalCarouselConfigReceipt(look, renderer);
    assert.deepEqual(validateCarouselConfigReceipt(receipt), { ok: true, receipt });

    const enabled = resolveCarouselConfig({
      canonicalValue: receipt,
      legacyHouseLook: 'manifesto',
      legacyRenderer: renderer === 'factory' ? 'content_manager' : 'factory',
      factoryEnabled: true,
    });
    assert.equal(enabled.ready, true, `${look}/${renderer} exact receipt did not become ready`);
    assert.equal(enabled.issue, null);
    assert.deepEqual(enabled.receipt, receipt, 'legacy rows overrode the authoritative receipt');

    if (renderer === 'factory') {
      const disabled = resolveCarouselConfig({ canonicalValue: receipt, factoryEnabled: false });
      assert.equal(disabled.ready, false);
      assert.equal(disabled.issue, 'factory_not_enabled');
    }
  }
}

const legacy = resolveCarouselConfig({
  legacyHouseLook: 'cobalt',
  legacyRenderer: 'content_manager',
  factoryEnabled: true,
});
assert.equal(legacy.ready, false, 'legacy look-only configuration became executable');
assert.equal(legacy.issue, 'legacy_look_only_config');
assert.equal(legacy.receipt, null);

const missing = resolveCarouselConfig({ factoryEnabled: true });
assert.equal(missing.ready, false);
assert.equal(missing.issue, 'house_look_required');

const expectedCobalt = canonicalCarouselConfigReceipt('cobalt');
const mismatched = { ...expectedCobalt, template_id: 'house-editorial-v1' };
assert.deepEqual(validateCarouselConfigReceipt(mismatched), { ok: false, issue: 'template_contract_mismatch' });
assert.deepEqual(
  validateCarouselConfigReceipt({ ...expectedCobalt, template_version: 1 }),
  { ok: false, issue: 'config_receipt_invalid' },
);
assert.deepEqual(
  validateCarouselConfigReceipt({ ...expectedCobalt, arbitrary_html: '<h1>unsafe</h1>' }),
  { ok: false, issue: 'config_receipt_invalid' },
  'receipt accepted fields outside the exact portable contract',
);

const firstProgress = mergeCarouselJobResult(
  { config_receipt: expectedCobalt },
  { slide_total: 10, slide_urls: ['https://media.test/01.png'] },
);
assert.equal(firstProgress.ok, true);
assert.deepEqual(firstProgress.result.config_receipt, expectedCobalt);
const contactSheet = mergeCarouselJobResult(
  firstProgress.result,
  { contact_sheet_url: 'https://media.test/contact.png' },
);
assert.equal(contactSheet.ok, true);
assert.deepEqual(contactSheet.result.config_receipt, expectedCobalt,
  'queue-time receipt was lost during slide/contact-sheet result merges');
assert.deepEqual(contactSheet.result.slide_urls, ['https://media.test/01.png']);
assert.equal(contactSheet.result.contact_sheet_url, 'https://media.test/contact.png');
assert.deepEqual(
  mergeCarouselJobResult(firstProgress.result, {
    config_receipt: canonicalCarouselConfigReceipt('editorial'),
    slide_urls: ['https://media.test/02.png'],
  }),
  { ok: false, issue: 'config_receipt_immutable' },
  'renderer replaced the queue-time template receipt',
);

const configRoute = read('src/app/api/studio/carousel-config/route.ts');
assert.match(configRoute, /const templateFieldCount = \[body\.template_id, body\.template_version, body\.contract_revision\]/);
assert.match(configRoute, /if \(templateFieldCount > 0 && templateFieldCount < 3\)/);
assert.match(configRoute, /const candidate = templateFieldCount === 0[\s\S]*canonicalCarouselConfigReceipt\(body\.house_look, renderer\)/);
assert.match(configRoute, /const rows = \[/);
assert.match(configRoute, /key: CAROUSEL_CONFIG_KEY, value: receipt as never/);
assert.match(configRoute, /key: 'content_house_look', value: receipt\.house_look as never/);
assert.match(configRoute, /key: 'carousel_renderer', value: receipt\.renderer as never/);
assert.equal(
  (configRoute.match(/\.upsert\(rows, \{ onConflict: 'key' \}\)/g) ?? []).length,
  1,
  'canonical and compatibility rows are not written by one atomic bulk upsert',
);

const settingsRoute = read('src/app/api/studio/settings/route.ts');
assert.doesNotMatch(settingsRoute, /carousel_template_html/);
assert.match(settingsRoute, /code: 'legacy_look_only_config'/);
assert.match(settingsRoute, /status: 410/);
assert.doesNotMatch(settingsRoute, /\.upsert\(/, 'legacy one-key settings door can still write executable config');

const outputsRoute = read('src/app/api/studio/outputs/route.ts');
assert.match(outputsRoute, /if \(!config\.ready \|\| config\.issue \|\| !config\.receipt\)/);
assert.match(outputsRoute, /CAROUSEL_CONFIG_ISSUE_MESSAGES\[issue\]/);
assert.match(outputsRoute, /Queued for the local HOUSE renderer/);
assert.match(outputsRoute, /result: \{ config_receipt: config\.receipt \}/);
const runnerGate = outputsRoute.indexOf('await requirePortableCarouselRunner(request.url, supabase)');
const queueInsert = outputsRoute.indexOf('.insert({', runnerGate);
assert(runnerGate > -1 && queueInsert > runnerGate,
  'HOUSE job can be inserted before fresh runner/Anthropic readiness is proven');
assert.match(outputsRoute, /anthropicStatus !== "valid"/);
assert.match(outputsRoute, /capabilities\?\.carousel_ready !== true[\s\S]*carousel_runtime_not_ready/);
assert.match(outputsRoute, /runner_health_stale/);
assert.match(outputsRoute, /config\.renderer === "content_manager"/,
  'optional FACTORY jobs are incorrectly gated by the local HOUSE runner');

const board = read('src/components/studio/studio-board.tsx');
const desk = read('src/components/studio/desk-panel.tsx');
assert.match(board, /capabilities\?\.anthropic_status !== 'valid'/);
assert.match(board, /capabilities\?\.carousel_ready !== true/);
assert.match(board, /carouselGenerationIssue=\{carouselGenerationIssue\}/);
assert.match(desk, /HOUSE renderer needs attention/);
assert.match(desk, /carouselConfig\?\.renderer === 'content_manager' && Boolean\(carouselGenerationIssue\)/,
  'desk can queue a HOUSE carousel while the required local model lane is degraded');

const claimRoute = read('src/app/api/studio/carousel-jobs/claim/route.ts');
assert.match(claimRoute, /local HOUSE/);
assert.match(claimRoute, /\.eq\("executor", "employee"\)/);
assert.match(claimRoute, /sole HOUSE executor/);

const reportRoute = read('src/app/api/studio/carousel-jobs/[id]/route.ts');
assert.match(reportRoute, /mergeCarouselJobResult\(job\.result, body\.result, body\.scheduled_at\)/);
assert.match(reportRoute, /code: merged\.issue/);
assert.match(reportRoute, /\["ready", "failed"\]\.includes\(job\.status\)/,
  'a lost terminal response can downgrade a ready job to failed');

console.log(JSON.stringify({
  ok: true,
  receipts: 'five exact signed template tuples, both explicit renderer choices',
  migration: 'legacy look-only rows fail closed',
  writes: 'canonical + compatibility rows use one bulk upsert',
  queue: 'all readiness issues block; immutable queue-time receipt survives result merges',
  capability: 'fresh local runner + carousel_ready + anthropic=valid before HOUSE insert',
}));
