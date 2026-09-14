#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertStudioCarouselConfigReceipt,
  assertStudioCarouselSlideCopy,
  buildStudioCarouselContactSheet,
  countStudioCarouselWords,
  normalizeStudioCarouselPayload,
  renderStudioCarouselSlide,
  renderStudioCarouselText,
  studioCarouselContactSheetProbeScript,
  studioCarouselFitProbeScript,
  STUDIO_CAROUSEL_CONFIG_CONTRACT,
  STUDIO_CAROUSEL_CONFIG_KEY,
  STUDIO_CAROUSEL_FONT_ROLE_EXPECTATIONS,
  STUDIO_CAROUSEL_FIT_MAX_ATTEMPTS,
  STUDIO_CAROUSEL_FIT_VIRTUAL_TIME_BUDGET_MS,
  STUDIO_CAROUSEL_LOOK_CONTRACTS,
  STUDIO_CAROUSEL_MAX_COVER_WORDS,
  STUDIO_CAROUSEL_MAX_SLIDE_WORDS,
  STUDIO_CAROUSEL_MAX_UNBROKEN_CHARS,
  STUDIO_CAROUSEL_RENDER_CONTRACT,
  STUDIO_CAROUSEL_SLIDE_COUNT,
  STUDIO_CAROUSEL_SLIDE_WORD_LIMITS,
  STUDIO_CAROUSEL_TEMPLATE_VERSION,
  studioCarouselModelInstruction,
} from "./studio-carousel-contract.mjs";
import {
  proveStudioCarouselFitReady,
  STUDIO_CAROUSEL_FIT_PROBE_ATTEMPTS,
  STUDIO_CAROUSEL_FIT_VIRTUAL_TIME_MS,
} from "./studio-carousel-preflight.mjs";

// Rendered slides reference the signed local fonts/images by absolute file://
// URL, so the checkout path is part of the HTML. Strip those URLs before any
// text assertion about the template itself.
const withoutLocalAssetUrls = (html) => html.replace(/file:\/\/[^"')\s]+/g, "file://LOCAL-ASSET");

const expectedTemplateIds = {
  cobalt: "house-cobalt-v1",
  editorial: "house-editorial-v1",
  explainer: "house-explainer-v1",
  manifesto: "house-manifesto-v1",
  threshold: "house-threshold-v1",
};
const expectedDefaultSequences = {
  cobalt: ["cover", "frame", "column", "statement", "photo", "service", "blue_field", "photo", "evidence", "closer"],
  editorial: ["cover", "hook", "body", "body", "body", "quote", "body", "body", "list", "closer"],
  explainer: ["cover", "overview", "definition", "examples", "subcategories", "definition", "examples", "definition", "summary", "closer"],
  manifesto: ["cover", "body", "body", "body", "punch", "body", "body", "list", "punch", "closer"],
  threshold: ["cover", "questions", "body", "photo", "photo", "body", "diagram", "closer_visual", "photo", "closer"],
};
const expectedFontFamilies = {
  cobalt: ["Studio Inter Tight"],
  editorial: ["Studio Fraunces", "Studio Inter", "Studio JetBrains Mono"],
  explainer: ["Studio Inter Tight", "Studio Inter"],
  manifesto: ["Studio Inter Tight"],
  threshold: ["Studio Inter"],
};
const apiRegistry = readFileSync(new URL("../src/lib/studio/carousel-template-registry.ts", import.meta.url), "utf8");

assert.equal(STUDIO_CAROUSEL_CONFIG_KEY, "studio_carousel_config");
assert.equal(STUDIO_CAROUSEL_CONFIG_CONTRACT, "studio_carousel_config_v1");
assert.equal(STUDIO_CAROUSEL_RENDER_CONTRACT, "studio_carousel_render_v1");
assert.equal(STUDIO_CAROUSEL_TEMPLATE_VERSION, "1");
assert.equal(STUDIO_CAROUSEL_SLIDE_COUNT, 10);
assert.equal(STUDIO_CAROUSEL_MAX_SLIDE_WORDS, 28);
assert.equal(STUDIO_CAROUSEL_MAX_COVER_WORDS, 12);
assert.equal(STUDIO_CAROUSEL_MAX_UNBROKEN_CHARS, 24);
assert.deepEqual(STUDIO_CAROUSEL_SLIDE_WORD_LIMITS, { cover: 12, middle: 28, closer: 20 });
assert.equal(STUDIO_CAROUSEL_FIT_MAX_ATTEMPTS, 3);
assert.equal(STUDIO_CAROUSEL_FIT_VIRTUAL_TIME_BUDGET_MS, 30_000);
assert.equal(STUDIO_CAROUSEL_FIT_PROBE_ATTEMPTS, STUDIO_CAROUSEL_FIT_MAX_ATTEMPTS);
assert.equal(STUDIO_CAROUSEL_FIT_VIRTUAL_TIME_MS, STUDIO_CAROUSEL_FIT_VIRTUAL_TIME_BUDGET_MS);
assert.deepEqual(Object.keys(STUDIO_CAROUSEL_LOOK_CONTRACTS), Object.keys(expectedTemplateIds));
assert.match(apiRegistry, /CAROUSEL_CONFIG_KEY = 'studio_carousel_config'/);
assert.match(apiRegistry, /CAROUSEL_CONFIG_CONTRACT_REVISION = 'studio_carousel_config_v1'/);
assert.match(apiRegistry, /CAROUSEL_TEMPLATE_VERSION = '1'/);
for (const [look, templateId] of Object.entries(expectedTemplateIds)) {
  assert.match(
    apiRegistry,
    new RegExp(`${look}: \\{ template_id: '${templateId}', template_version: CAROUSEL_TEMPLATE_VERSION \\}`),
    `${look} API/runner template registry drifted`,
  );
}

const baseSlides = Array.from({ length: STUDIO_CAROUSEL_SLIDE_COUNT }, (_, index) => ({
  layout: "not-a-layout",
  text: `Slide ${index + 1} heading\n\nSlide ${index + 1} supporting paragraph.`,
}));

for (const [look, contract] of Object.entries(STUDIO_CAROUSEL_LOOK_CONTRACTS)) {
  assert.equal(contract.templateId, expectedTemplateIds[look]);
  assert.equal(contract.templateVersion, "1");
  assert.deepEqual(contract.defaultSequence, expectedDefaultSequences[look], `${look} drifted from its signed style-pack grammar`);
  assert.deepEqual(
    [...contract.layouts].sort(),
    [...new Set(expectedDefaultSequences[look])].sort(),
    `${look} exposes a layout outside its actual style-pack grammar`,
  );
  assert.equal(contract.defaultSequence.length, STUDIO_CAROUSEL_SLIDE_COUNT);
  assert.equal(contract.defaultSequence[0], "cover");
  assert.equal(contract.defaultSequence.at(-1), "closer");
  assert(contract.defaultSequence.every((layout) => contract.layouts.includes(layout)));

  const templateSource = readFileSync(new URL(`./carousel-templates/${contract.templateFile}`, import.meta.url), "utf8");
  // Brand leaks are a property of the signed template SOURCE. The rendered
  // HTML embeds absolute file:// asset URLs, so it is checked separately with
  // those URLs removed — a checkout folder named after the vendor must never
  // fail this gate (it did, on the vendor's own home).
  assert.doesNotMatch(templateSource, /\b(?:ZUZU|BRAVEBRAND)\b/i, `${look} template source leaked a client/vendor brand`);
  for (const layout of new Set(expectedDefaultSequences[look])) {
    assert.match(templateSource, new RegExp(`\\.layout-${layout}(?:[\\s.:\\[])`), `${look}/${layout} has no signed CSS treatment`);
  }
  for (const family of expectedFontFamilies[look]) {
    assert.match(templateSource, new RegExp(`(?:font-family|--font-[a-z-]+):[^;}]*["']${family}["']`), `${look} omits its mandated ${family} font stack`);
  }

  const receipt = {
    house_look: look,
    renderer: "content_manager",
    template_id: contract.templateId,
    template_version: "1",
    contract_revision: STUDIO_CAROUSEL_CONFIG_CONTRACT,
  };
  assert.deepEqual(assertStudioCarouselConfigReceipt(receipt), receipt);
  assert.deepEqual(assertStudioCarouselConfigReceipt(JSON.stringify(receipt)), receipt);
  assert.equal(assertStudioCarouselConfigReceipt({ ...receipt, renderer: "factory" }).renderer, "factory");
  assert.throws(
    () => assertStudioCarouselConfigReceipt({ ...receipt, template_id: `${contract.templateId}-wrong` }),
    /does not match/,
  );
  assert.throws(
    () => assertStudioCarouselConfigReceipt({ ...receipt, template_version: 1 }),
    /does not match/,
  );
  assert.throws(
    () => assertStudioCarouselConfigReceipt({ ...receipt, arbitrary_html: "<h1>unsafe</h1>" }),
    /unsupported fields/,
  );

  const allowedMiddle = contract.layouts.find((layout) => layout !== "cover" && layout !== "closer");
  const rawSlides = baseSlides.map((slide) => ({ ...slide }));
  rawSlides[0].layout = "closer";
  rawSlides[1].layout = allowedMiddle;
  rawSlides[9].layout = "cover";
  const normalized = normalizeStudioCarouselPayload({
    contract_version: STUDIO_CAROUSEL_RENDER_CONTRACT,
    slides: rawSlides,
    caption: "Plain caption",
  }, look);
  assert.equal(normalized.slides.length, STUDIO_CAROUSEL_SLIDE_COUNT);
  assert.equal(normalized.slides[0].layout, "cover", `${look} did not force its cover`);
  assert.equal(normalized.slides[1].layout, allowedMiddle, `${look} rejected an allowed layout`);
  assert.equal(normalized.slides[2].layout, contract.defaultSequence[2], `${look} did not apply its default sequence`);
  assert.equal(normalized.slides[9].layout, "closer", `${look} did not force its closer`);

  const defaulted = normalizeStudioCarouselPayload({
    contract_version: STUDIO_CAROUSEL_RENDER_CONTRACT,
    slides: baseSlides,
    caption: "Default sequence proof",
  }, look);
  assert.deepEqual(
    defaulted.slides.map((slide) => slide.layout),
    expectedDefaultSequences[look],
    `${look} did not normalize to its signed 10-slot style-pack sequence`,
  );

  for (let index = 0; index < normalized.slides.length; index++) {
    const html = renderStudioCarouselSlide({ look, slide: normalized.slides[index], number: index + 1 });
    assert.match(html, new RegExp(`data-template-id="${contract.templateId}"`));
    assert.match(html, new RegExp(`data-layout="${normalized.slides[index].layout}"`));
    assert.match(html, new RegExp(`data-slide="${String(index + 1).padStart(2, "0")}"`));
    assert.doesNotMatch(html, /\{\{[^}]+\}\}/, `${look} left an unresolved template token`);
    assert.doesNotMatch(html, /https?:\/\//i, `${look} template depends on a remote asset`);
    assert.doesNotMatch(html, /<script\b/i, `${look} template executes script`);
    assert.doesNotMatch(withoutLocalAssetUrls(html), /\b(?:ZUZU|BRAVEBRAND)\b/i, `${look} template leaked a client/vendor brand`);
  }

  const instruction = studioCarouselModelInstruction(look);
  assert.match(instruction, /exactly 10 slides/i);
  assert.match(instruction, new RegExp(STUDIO_CAROUSEL_RENDER_CONTRACT));
  assert.match(instruction, /Never emit HTML/);
  assert.match(instruction, new RegExp(expectedDefaultSequences[look].join(", ")));
}

assert.throws(
  () => normalizeStudioCarouselPayload({
    contract_version: STUDIO_CAROUSEL_RENDER_CONTRACT,
    slides: baseSlides.slice(0, 9),
  }, "manifesto"),
  /exactly 10 slides/,
);
assert.throws(
  () => normalizeStudioCarouselPayload({
    contract_version: STUDIO_CAROUSEL_RENDER_CONTRACT,
    slides: [...baseSlides, { layout: "body", text: "Eleventh" }],
  }, "manifesto"),
  /exactly 10 slides/,
);
assert.throws(
  () => normalizeStudioCarouselPayload({ contract_version: "legacy", slides: baseSlides }, "manifesto"),
  /studio_carousel_render_v1/,
);
assert.throws(
  () => normalizeStudioCarouselPayload({ contract_version: STUDIO_CAROUSEL_RENDER_CONTRACT, slides: baseSlides }, "unknown"),
  /Unsupported carousel house look/,
);

const twelveWords = "clear systems protect focused work while evidence guides every deliberate decision forward";
const twentyWords = Array.from({ length: 20 }, (_, index) => `close${index + 1}`).join(" ");
const twentyEightWords = Array.from({ length: 28 }, (_, index) => `word${index + 1}`).join(" ");
const twentyNineWords = `${twentyEightWords} overflow`;
const maximumUnbrokenWord = "abcdefghijklmnopqrstuvwx";
const oversizedUnbrokenWord = `${maximumUnbrokenWord}y`;
const twentyEightCjkCharacters = "界".repeat(14) + " " + "語".repeat(14);
const twentyNineCjkCharacters = twentyEightCjkCharacters + "文";
const twentyEightEmoji = "😀".repeat(28);
const twentyNineEmoji = `${twentyEightEmoji}😀`;
assert.equal(countStudioCarouselWords(twelveWords), 12);
assert.equal(countStudioCarouselWords(twentyWords), 20);
assert.equal(countStudioCarouselWords(twentyEightWords), 28);
assert.equal(countStudioCarouselWords(twentyEightCjkCharacters), 28);
assert.equal(countStudioCarouselWords(twentyEightEmoji), 28);
assert.equal(assertStudioCarouselSlideCopy(twelveWords, { layout: "cover", number: 1 }).words, 12);
assert.equal(assertStudioCarouselSlideCopy(twentyWords, { layout: "closer", number: 10 }).words, 20);
assert.equal(assertStudioCarouselSlideCopy(twentyEightWords, { layout: "body", number: 2 }).words, 28);
assert.equal(assertStudioCarouselSlideCopy(twentyEightCjkCharacters, { layout: "body", number: 2 }).words, 28);
assert.equal(assertStudioCarouselSlideCopy(twentyEightEmoji, { layout: "body", number: 2 }).words, 28);
assert.equal(assertStudioCarouselSlideCopy(maximumUnbrokenWord, { layout: "body", number: 2 }).words, 1);
assert.throws(
  () => assertStudioCarouselSlideCopy(`${twelveWords} beyond`, { layout: "cover", number: 1 }),
  /12-word cover fit boundary/,
);
assert.throws(
  () => assertStudioCarouselSlideCopy(`${twentyWords} beyond`, { layout: "closer", number: 10 }),
  /20-word closer fit boundary/,
);
assert.throws(
  () => assertStudioCarouselSlideCopy(twentyNineWords, { layout: "body", number: 2 }),
  /28-word slide fit boundary/,
);
assert.throws(
  () => assertStudioCarouselSlideCopy(twentyNineCjkCharacters, { layout: "body", number: 2 }),
  /28-word slide fit boundary/,
);
assert.throws(
  () => assertStudioCarouselSlideCopy(twentyNineEmoji, { layout: "body", number: 2 }),
  /28-word slide fit boundary/,
);
assert.throws(
  () => assertStudioCarouselSlideCopy(oversizedUnbrokenWord, { layout: "body", number: 2 }),
  /24-character fit boundary/,
);
assert.throws(
  () => assertStudioCarouselSlideCopy("Heading\n\nOne\n\nTwo\n\nThree\n\nFour", { layout: "body", number: 2 }),
  /four-block fit boundary/,
);
assert.throws(
  () => assertStudioCarouselSlideCopy("List\n\n- one\n- two\n- three\n- four\n- five\n- six", { layout: "list", number: 2 }),
  /five-item fit boundary/,
);
const oversizedPayloadSlides = baseSlides.map((slide) => ({ ...slide }));
oversizedPayloadSlides[1].text = twentyNineWords;
assert.throws(
  () => normalizeStudioCarouselPayload({
    contract_version: STUDIO_CAROUSEL_RENDER_CONTRACT,
    slides: oversizedPayloadSlides,
  }, "manifesto"),
  /28-word slide fit boundary/,
);
assert.throws(
  () => renderStudioCarouselSlide({ look: "manifesto", slide: { layout: "body", text: twentyNineWords }, number: 2 }),
  /28-word slide fit boundary/,
);

const safeBlocks = renderStudioCarouselText(
  "A <script>alert(1)</script> & headline\n\nSecond \"paragraph\".\n\n- <img src=x onerror=alert(1)>\n- Safe & sound",
);
assert.match(safeBlocks, /^<h1 class="slide-heading">/);
assert.match(safeBlocks, /<p class="slide-paragraph">Second &quot;paragraph&quot;\.<\/p>/);
assert.match(safeBlocks, /<ul class="slide-list"><li>&lt;img src=x onerror=alert\(1\)&gt;<\/li><li>Safe &amp; sound<\/li><\/ul>/);
assert.doesNotMatch(safeBlocks, /<script>|<img\b/);
assert.match(renderStudioCarouselText("Steps\n\n1. First\n2) Second"), /<ol class="slide-list"><li>First<\/li><li>Second<\/li><\/ol>/);

const contactSources = Array.from({ length: STUDIO_CAROUSEL_SLIDE_COUNT }, (_, index) =>
  `file:///tmp/slide-${index + 1}.png?x=1&safe=yes`
);
const contactSheet = buildStudioCarouselContactSheet({ look: "manifesto", imageSources: contactSources });
assert.equal((contactSheet.match(/class="contact-card"/g) ?? []).length, STUDIO_CAROUSEL_SLIDE_COUNT);
assert.match(contactSheet, /grid-template-columns:repeat\(2,500px\)/);
assert.match(contactSheet, /grid-template-rows:repeat\(5,666px\)/);
assert.match(contactSheet, /data-slide="01"/);
assert.match(contactSheet, /data-slide="10"/);
assert.match(contactSheet, /x=1&amp;safe=yes/);
assert.throws(
  () => buildStudioCarouselContactSheet({ look: "manifesto", imageSources: contactSources.slice(0, 9) }),
  /exactly 10 slide images/,
);

const runner = readFileSync(new URL("./studio-runner.mjs", import.meta.url), "utf8");
assert.match(runner, /assertStudioCarouselConfigReceipt/);
assert.match(runner, /jobResult\?\.config_receipt/);
assert.match(runner, /receipt\.renderer !== "content_manager"/);
assert.match(runner, /buildStudioCarouselContactSheet/);
assert.match(runner, /contact-sheet\.png/);
assert.match(runner, /studio_materialize_carousel_draft/,
  "runner does not use the lease-fenced transactional draft materializer");
assert.match(runner, /async function reportCarouselJob/);
assert.match(runner, /const attempts = terminal \|\| durable \? 3 : 1/);
assert.doesNotMatch(
  runner.slice(runner.indexOf("async function processCarouselJob"), runner.indexOf("async function drainCarouselJobs")),
  /carousel report failed/,
  "carousel progress reporting can fail open before paid model work",
);
assert.match(runner, /carouselDatabaseMutation\(\s*"lease-fenced draft and media materialization"[\s\S]*studio_materialize_carousel_draft/,
  "post/media materialization is not atomic, lease-fenced, and checked through the outcome-unknown boundary");
assert.match(runner, /supabase\.rpc\("studio_cleanup_carousel_draft"/,
  "failed render cleanup bypasses the transactional ownership proof");
assert.doesNotMatch(runner, /supabase\.from\("social_posts"\)\.delete\(\)/,
  "runner can delete a post without the row-locked cleanup RPC");
assert.doesNotMatch(runner, /carousel_template_html/);
assert.doesNotMatch(runner, /\{\{slide_text\}\}/);
assert.doesNotMatch(runner, /\.eq\("key", STUDIO_CAROUSEL_CONFIG_KEY\)/, "runner rereads mutable global carousel config");

const CHROME_CANDIDATES = [
  process.env.STUDIO_CAROUSEL_TEST_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);
const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
assert(chrome, "A real Chrome/Chromium binary is mandatory for the carousel release gate; set STUDIO_CAROUSEL_TEST_CHROME when it is not in a standard location");
execFileSync(chrome, ["--version"], { stdio: "ignore" });

const expectedFontRolePresentation = {
  cobalt: {
    ".slide-heading": ["400", "normal"],
    ".slide-paragraph": ["400", "normal"],
    ".slide-list li": ["400", "normal"],
    ".chrome strong": ["600", "normal"],
  },
  editorial: {
    ".slide-heading": ["400", "normal"],
    ".slide-paragraph": ["400", "normal"],
    ".slide-list li": ["400", "normal"],
    ".masthead": ["400", "normal"],
    ".folio": ["400", "normal"],
  },
  explainer: {
    ".slide-heading": ["900", "italic"],
    ".slide-paragraph": ["500", "normal"],
    ".slide-list li": ["600", "normal"],
    ".topline": ["600", "normal"],
    ".counter": ["600", "normal"],
  },
  manifesto: {
    ".slide-heading": ["800", "normal"],
    ".slide-paragraph": ["500", "normal"],
    ".slide-list li": ["600", "normal"],
    ".chrome": ["700", "normal"],
  },
  threshold: {
    ".slide-heading": ["400", "normal"],
    ".slide-paragraph": ["400", "normal"],
    ".slide-list li": ["400", "normal"],
    ".header strong": ["500", "normal"],
  },
};

function expectedFontPresentation(look, selector, layout) {
  if (look === "editorial" && selector === ".slide-heading") {
    if (layout === "cover") return ["500", "normal"];
    if (layout === "quote") return ["300", "italic"];
  }
  if (look === "manifesto" && selector === ".slide-heading" && (layout === "cover" || layout === "punch")) {
    return ["900", "normal"];
  }
  return expectedFontRolePresentation[look][selector];
}

const listLayouts = new Set(["service", "list", "overview", "examples", "subcategories", "questions", "diagram"]);
const coverBoundaryText = "abcdefghijklmnopqrstuvwx\n\n界界界界\n\n😀😀 reliable proof wraps safely today";
const closerBoundaryText = "abcdefghijklmnopqrstuvwx\n\n界界界界界界界界\n\n😀😀😀 reliable systems wrap safely under narrow visual frames";
const paragraphBoundaryText = "abcdefghijklmnopqrstuvwx proof\n\n界界界界界界界界界界界界\n\n😀😀😀😀😀 reliable systems wrap safely under narrow visual frames time";
const coverListBoundaryText = "Reliable systems\n\n- Clear action\n- Durable proof\n- Focused review\n- Safer delivery\n- Better work";
const closerListBoundaryText = "Clear decisions move work\n\n- Review the strongest evidence\n- Choose one useful direction\n- Protect the durable system\n- Carry that learning forward";
const listBoundaryText = "Reliable systems compound today\n\n- Clear actions protect reliable delivery today\n- Clear actions protect reliable delivery today\n- Clear actions protect reliable delivery today\n- Clear actions protect reliable delivery today";
assert.equal(countStudioCarouselWords(coverBoundaryText), 12);
assert.equal(countStudioCarouselWords(closerBoundaryText), 20);
assert.equal(countStudioCarouselWords(paragraphBoundaryText), 28);
assert.equal(countStudioCarouselWords(coverListBoundaryText), 12);
assert.equal(countStudioCarouselWords(closerListBoundaryText), 20);
assert.equal(countStudioCarouselWords(listBoundaryText), 28);

function copyAtBoundary(layout, number) {
  if (number === 1 || layout === "cover") return coverBoundaryText;
  if (number === STUDIO_CAROUSEL_SLIDE_COUNT || layout === "closer") return closerBoundaryText;
  return listLayouts.has(layout) ? listBoundaryText : paragraphBoundaryText;
}

function alternateCopyAtBoundary(layout, number) {
  if (number === 1 || layout === "cover") return coverListBoundaryText;
  if (number === STUDIO_CAROUSEL_SLIDE_COUNT || layout === "closer") return closerListBoundaryText;
  return listLayouts.has(layout) ? paragraphBoundaryText : listBoundaryText;
}

function addComputedProbe(html, look) {
  return html.replace("</body>", `<script>${studioCarouselFitProbeScript(look)}</script></body>`);
}

function chromeDump(htmlPath, width, height, virtualTimeBudget = STUDIO_CAROUSEL_FIT_VIRTUAL_TIME_BUDGET_MS) {
  return execFileSync(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--allow-file-access-from-files",
    "--run-all-compositor-stages-before-draw",
    `--virtual-time-budget=${virtualTimeBudget}`,
    "--force-device-scale-factor=1",
    `--window-size=${width},${height}`,
    "--dump-dom",
    pathToFileURL(htmlPath).href,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function screenshot(htmlPath, pngPath, width, height) {
  execFileSync(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--allow-file-access-from-files",
    "--run-all-compositor-stages-before-draw",
    `--virtual-time-budget=${STUDIO_CAROUSEL_FIT_VIRTUAL_TIME_BUDGET_MS}`,
    "--force-device-scale-factor=1",
    `--window-size=${width},${height}`,
    `--screenshot=${pngPath}`,
    pathToFileURL(htmlPath).href,
  ], { stdio: "ignore" });
}

async function chromeFitProbe(htmlPath, stem) {
  const proof = await proveStudioCarouselFitReady({
    chrome,
    htmlFile: htmlPath,
    width: 1080,
    height: 1350,
    label: stem,
  });
  return proof.detail;
}

const dir = mkdtempSync(join(tmpdir(), "studio-carousel-contract-test-"));
try {
  const screenshots = [];
  const screenshotHashes = new Set();
  for (const [look, contract] of Object.entries(STUDIO_CAROUSEL_LOOK_CONTRACTS)) {
    const rawSlides = contract.defaultSequence.map((layout, index) => ({
      layout,
      text: copyAtBoundary(layout, index + 1),
    }));
    const payload = normalizeStudioCarouselPayload({
      contract_version: STUDIO_CAROUSEL_RENDER_CONTRACT,
      slides: rawSlides,
      caption: "",
    }, look);
    for (let index = 0; index < payload.slides.length; index++) {
      const number = index + 1;
      const slide = payload.slides[index];
      const stem = `${look}-${String(number).padStart(2, "0")}-${slide.layout}`;
      const htmlPath = join(dir, `${stem}.html`);
      const pngPath = join(dir, `${stem}.png`);
      const html = renderStudioCarouselSlide({ look, slide, number });
      writeFileSync(htmlPath, addComputedProbe(html, look));
      const probe = await chromeFitProbe(htmlPath, stem);
      assert(probe.roles.length >= 2, `${stem} did not exercise enough computed typography roles`);
      for (const role of probe.roles) {
        assert.equal(role.primary, role.family, `${stem}/${role.selector} fell back from ${role.family}`);
        assert.equal(role.loaded, true, `${stem}/${role.selector} did not load ${role.family} ${role.weight} ${role.style}`);
        assert.deepEqual(
          [role.weight, role.style],
          expectedFontPresentation(look, role.selector, slide.layout),
          `${stem}/${role.selector} computed typography drifted`,
        );
      }
      assert.deepEqual(probe.violations, [], `${stem} failed its trusted fit gate`);
      if (look === "cobalt" && slide.layout !== "blue_field") {
        assert.match(probe.beforeImage, /^url\("file:\/\/.+\.(?:webp|jpg)"\)$/i, `${stem} did not use a signed photographic atmosphere`);
        assert.doesNotMatch(probe.beforeImage, /(?:linear|radial)-gradient\(/i, `${stem} used a synthetic Cobalt atmosphere`);
      }
      if (look === "threshold" && (slide.layout === "photo" || slide.layout === "closer")) {
        assert.match(probe.beforeImage, /^url\("file:\/\/.+\.jpg"\)$/i, `${stem} did not use a signed Threshold photograph`);
      }
      screenshot(htmlPath, pngPath, 1080, 1350);
      const png = readFileSync(pngPath);
      assert(png.length > 5_000, `${stem} rendered an empty screenshot`);
      const digest = createHash("sha256").update(png).digest("hex");
      assert(!screenshotHashes.has(digest), `${stem} collapsed to a duplicate rendered artboard`);
      screenshotHashes.add(digest);
      screenshots.push(pathToFileURL(pngPath).href);
    }

    // The canonical ten-slot render above exercises the pack's intended
    // content shape. This batched real-browser matrix exercises the opposite
    // shape on every distinct layout: paragraph layouts receive a max-boundary
    // list, while list layouts receive max-boundary paragraphs containing an
    // unbroken 24-character token, CJK, and emoji. The iframe batch keeps the
    // release gate fast without weakening its real DOM/font/asset proof.
    const alternateFrames = [];
    for (const layout of contract.layouts) {
      const number = contract.defaultSequence.indexOf(layout) + 1;
      assert(number > 0, `${look}/${layout} is not reachable in its signed sequence`);
      const childPath = join(dir, `${look}-matrix-${layout}.html`);
      const childHtml = renderStudioCarouselSlide({
        look,
        slide: { layout, text: alternateCopyAtBoundary(layout, number) },
        number,
      });
      writeFileSync(childPath, addComputedProbe(childHtml, look));
      alternateFrames.push({ look, layout, number, source: pathToFileURL(childPath).href });
    }
    const matrixPath = join(dir, `${look}-matrix.html`);
    const frames = alternateFrames
      .map(({ source, layout }) => `<iframe title="${look}-${layout}" src="${source}"></iframe>`)
      .join("");
    const matrixScript = `<script>(async()=>{try{const frames=[...document.querySelectorAll('iframe')];const wait=async frame=>{if(frame.contentDocument?.readyState!=='complete')await new Promise(resolve=>{frame.addEventListener('load',resolve,{once:true});setTimeout(resolve,8000)});const deadline=performance.now()+8000;while(performance.now()<deadline){const root=frame.contentDocument?.documentElement;const status=root?.getAttribute('data-studio-carousel-fit');if(status)return{title:frame.title,status,detail:root.getAttribute('data-studio-carousel-fit-detail')};await new Promise(resolve=>setTimeout(resolve,25))}return{title:frame.title,status:'missing',detail:null}};const results=await Promise.all(frames.map(wait));document.documentElement.dataset.studioMatrix=btoa(JSON.stringify(results));}catch(error){document.documentElement.dataset.studioMatrix=btoa(JSON.stringify([{status:'error',error:String(error?.stack||error)}]));}})();</script>`;
    writeFileSync(matrixPath, `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:1080px;height:1350px;overflow:hidden}iframe{position:absolute;inset:0;width:1080px;height:1350px;border:0;opacity:.001}</style></head><body>${frames}${matrixScript}</body></html>`);
    const matrixDump = chromeDump(matrixPath, 1080, 1350, STUDIO_CAROUSEL_FIT_VIRTUAL_TIME_BUDGET_MS);
    const matrixEncoded = matrixDump.match(/data-studio-matrix="([A-Za-z0-9+/=]+)"/)?.[1];
    assert(matrixEncoded, `${look} alternate-layout matrix did not complete`);
    const matrixResult = JSON.parse(Buffer.from(matrixEncoded, "base64").toString("utf8"));
    assert.equal(matrixResult.length, contract.layouts.length, `${look} alternate-layout matrix skipped a layout`);
    for (const result of matrixResult) {
      let detail = null;
      if (result.detail) {
        try { detail = JSON.parse(Buffer.from(result.detail, "base64").toString("utf8")); } catch { /* assertion below retains raw evidence */ }
      }
      assert.equal(result.status, "pass", `${result.title} alternate shape failed: ${JSON.stringify(detail ?? result)}`);
    }
  }
  assert.equal(screenshots.length, 50, "Chrome did not render all ten slots for all five looks");

  const contactHtmlPath = join(dir, "contact.html");
  const contactPngPath = join(dir, "contact.png");
  const contactProbe = `<script>${studioCarouselContactSheetProbeScript()}</script>`;
  writeFileSync(contactHtmlPath, buildStudioCarouselContactSheet({
    look: "manifesto",
    imageSources: screenshots.slice(0, 10),
  }).replace("</body>", `${contactProbe}</body>`));
  const contactProof = await proveStudioCarouselFitReady({
    chrome,
    htmlFile: contactHtmlPath,
    width: 1200,
    height: 3600,
    label: "Studio carousel contact sheet",
  });
  const contactResult = contactProof.detail;
  assert.equal(contactResult.kind, "contact_sheet");
  assert.equal(contactResult.cards, 10);
  assert.equal(contactResult.images, 10);
  assert.equal(contactResult.columns.length, 2);
  assert.equal(contactResult.rows.length, 5);
  assert.equal(contactResult.assets.every(asset => asset.loaded), true);
  assert.deepEqual(contactResult.violations, []);
  screenshot(contactHtmlPath, contactPngPath, 1200, 3600);
  assert(readFileSync(contactPngPath).length > 50_000, "contact sheet rendered an empty screenshot");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// Regression: a checkout whose folder is named after the vendor (the vendor's
// own home is `bravebrand-backend`) must pass the brand-leak gate. The path
// legitimately appears inside file:// asset URLs; only template text counts.
{
  const relocated = join(mkdtempSync(join(tmpdir(), "studio-renderer-")), "bravebrand-backend", "scripts");
  try {
    mkdirSync(relocated, { recursive: true });
    for (const entry of ["studio-carousel-contract.mjs", "carousel-templates", "carousel-assets"]) {
      cpSync(fileURLToPath(new URL(`./${entry}`, import.meta.url)), join(relocated, entry), { recursive: true });
    }
    const relocatedContract = await import(pathToFileURL(join(relocated, "studio-carousel-contract.mjs")).href);
    const slide = relocatedContract.normalizeStudioCarouselPayload({
      contract_version: STUDIO_CAROUSEL_RENDER_CONTRACT,
      slides: baseSlides,
      caption: "Relocated checkout proof",
    }, "cobalt").slides[0];
    const html = relocatedContract.renderStudioCarouselSlide({ look: "cobalt", slide, number: 1 });
    assert.match(html, /file:\/\/[^"']*bravebrand-backend[^"']*carousel-assets/, "relocated render did not embed its own asset paths (test premise broken)");
    assert.doesNotMatch(withoutLocalAssetUrls(html), /\b(?:ZUZU|BRAVEBRAND)\b/i,
      "a checkout folder named after the vendor failed the brand-leak gate through its asset paths");
  } finally {
    rmSync(join(relocated, "..", ".."), { recursive: true, force: true });
  }
}

console.log(JSON.stringify({
  suite: "studio-carousel-renderer",
  contract: STUDIO_CAROUSEL_RENDER_CONTRACT,
  config_contract: STUDIO_CAROUSEL_CONFIG_CONTRACT,
  templates: expectedTemplateIds,
  exact_slide_count: STUDIO_CAROUSEL_SLIDE_COUNT,
  forced_endpoints: ["cover", "closer"],
  contact_sheet: "2x5-numbered",
  chrome_smoke: "MANDATORY_PASS",
  status: "PASS",
}, null, 2));
