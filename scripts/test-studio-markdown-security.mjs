#!/usr/bin/env node

import assert from 'node:assert/strict';
import { renderStudioMarkdown } from '../src/lib/studio/markdown.ts';

const hostile = [
  '<img src=x onerror="globalThis.__studio_xss=1">',
  '<style>body{display:none}</style>',
  '<script>globalThis.__studio_xss=1</script>',
  '[script](javascript:alert(1))',
  '[data](data:text/html,<script>alert(1)</script>)',
  '![remote](https://attacker.invalid/pixel.png)',
  '![data](data:image/svg+xml,<svg onload=alert(1)>)',
].join('\n\n');

const safe = renderStudioMarkdown(hostile, { breaks: true });
assert.doesNotMatch(safe, /<(?:script|style|img)\b|<[^>]+\s(?:onerror|onload)\s*=/i);
assert.doesNotMatch(safe, /href="(?:javascript|data):/i);
assert.doesNotMatch(safe, /<[^>]+\ssrc\s*=/i, 'Markdown images can still make a remote request');
assert.match(safe, /&lt;script&gt;/, 'raw HTML was dropped rather than rendered harmlessly as text');
assert.match(safe, /\[Image: remote\]/, 'remote images do not become an inert placeholder');

const ordinary = renderStudioMarkdown([
  '# Heading',
  '',
  'Paragraph with **bold**, `code`, and [safe link](https://example.com).',
  '',
  '- one',
  '- two',
  '',
  '> quote',
  '',
  '| A | B |',
  '| - | - |',
  '| 1 | 2 |',
].join('\n'));
for (const expected of ['<h1>', '<p>', '<strong>', '<code>', '<a href="https://example.com"', '<ul>', '<blockquote>', '<table>']) {
  assert(ordinary.includes(expected), `safe Markdown formatting was lost: ${expected}`);
}
assert.match(ordinary, /rel="noopener noreferrer"/);

console.log(JSON.stringify({
  ok: true,
  raw_html: 'escaped',
  unsafe_protocols: 'rejected',
  markdown_images: 'rendered as inert placeholders',
  supported_gfm: 'preserved',
}));
