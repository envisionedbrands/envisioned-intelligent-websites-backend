import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const STUDIO_CAROUSEL_CONFIG_KEY = "studio_carousel_config";
export const STUDIO_CAROUSEL_CONFIG_CONTRACT = "studio_carousel_config_v1";
export const STUDIO_CAROUSEL_RENDER_CONTRACT = "studio_carousel_render_v1";
export const STUDIO_CAROUSEL_TEMPLATE_VERSION = "1";
export const STUDIO_CAROUSEL_SLIDE_COUNT = 10;
export const STUDIO_CAROUSEL_MAX_SLIDE_WORDS = 28;
export const STUDIO_CAROUSEL_MAX_COVER_WORDS = 12;
export const STUDIO_CAROUSEL_MAX_UNBROKEN_CHARS = 24;
export const STUDIO_CAROUSEL_FIT_MAX_ATTEMPTS = 3;
export const STUDIO_CAROUSEL_FIT_VIRTUAL_TIME_BUDGET_MS = 30_000;
export const STUDIO_CAROUSEL_FIT_READINESS_POLL_MS = 25;
export const STUDIO_CAROUSEL_FIT_READINESS_MAX_POLLS = 200;
export const STUDIO_CAROUSEL_SLIDE_WORD_LIMITS = Object.freeze({
  cover: STUDIO_CAROUSEL_MAX_COVER_WORDS,
  middle: STUDIO_CAROUSEL_MAX_SLIDE_WORDS,
  closer: 20,
});

const MAX_SLIDE_TEXT_CHARS = 1_600;
const MAX_CAPTION_CHARS = 2_000;
const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "carousel-templates");
const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), "carousel-assets");
const REQUIRED_TEMPLATE_TOKENS = [
  "{{font_faces}}",
  "{{contract_version}}",
  "{{template_id}}",
  "{{slide_layout}}",
  "{{slide_content}}",
  "{{slide_number}}",
  "{{slide_total}}",
  "{{asset_preloads}}",
];

const FONT_ASSETS = Object.freeze({
  inter: Object.freeze({
    family: "Studio Inter",
    normal: "fonts/Inter-Variable.ttf",
    italic: "fonts/Inter-Italic-Variable.ttf",
  }),
  interTight: Object.freeze({
    family: "Studio Inter Tight",
    normal: "fonts/Inter-Tight-Variable.ttf",
    italic: "fonts/Inter-Tight-Italic-Variable.ttf",
  }),
  fraunces: Object.freeze({
    family: "Studio Fraunces",
    normal: "fonts/Fraunces-Variable.ttf",
    italic: "fonts/Fraunces-Italic-Variable.ttf",
  }),
  jetBrainsMono: Object.freeze({
    family: "Studio JetBrains Mono",
    normal: "fonts/JetBrains-Mono-Variable.ttf",
  }),
});

const LOOK_FONT_ASSETS = Object.freeze({
  cobalt: Object.freeze(["interTight"]),
  editorial: Object.freeze(["fraunces", "inter", "jetBrainsMono"]),
  explainer: Object.freeze(["interTight", "inter"]),
  manifesto: Object.freeze(["interTight"]),
  threshold: Object.freeze(["inter"]),
});

const LOOK_IMAGE_ASSETS = Object.freeze({
  cobalt: Object.freeze({
    "{{photo_asset_1}}": "images/cobalt-photo-01.jpg",
    "{{photo_asset_2}}": "images/cobalt-photo-02.jpg",
    "{{gradient_asset_1}}": "images/cobalt-gradient-01.webp",
    "{{gradient_asset_2}}": "images/cobalt-gradient-02.webp",
    "{{gradient_asset_3}}": "images/cobalt-gradient-03.webp",
    "{{gradient_asset_4}}": "images/cobalt-gradient-04.webp",
  }),
  threshold: Object.freeze({
    "{{photo_asset_1}}": "images/threshold-photo-01.jpg",
    "{{photo_asset_2}}": "images/threshold-photo-02.jpg",
    "{{photo_asset_3}}": "images/threshold-photo-03.jpg",
    "{{photo_asset_4}}": "images/threshold-photo-04.jpg",
  }),
});

export const STUDIO_CAROUSEL_FONT_FACE_EXPECTATIONS = Object.freeze(
  Object.fromEntries(Object.entries(LOOK_FONT_ASSETS).map(([look, names]) => [
    look,
    Object.freeze(names.flatMap((name) => {
      const font = FONT_ASSETS[name];
      return [
        Object.freeze([font.family, "normal", font.normal]),
        ...(font.italic ? [Object.freeze([font.family, "italic", font.italic])] : []),
      ];
    })),
  ])),
);

export const STUDIO_CAROUSEL_FONT_ROLE_EXPECTATIONS = Object.freeze({
  cobalt: Object.freeze([
    Object.freeze([".slide-heading", "Studio Inter Tight"]),
    Object.freeze([".slide-paragraph", "Studio Inter Tight"]),
    Object.freeze([".slide-list li", "Studio Inter Tight"]),
    Object.freeze([".chrome strong", "Studio Inter Tight"]),
  ]),
  editorial: Object.freeze([
    Object.freeze([".slide-heading", "Studio Fraunces"]),
    Object.freeze([".slide-paragraph", "Studio Inter"]),
    Object.freeze([".slide-list li", "Studio Inter"]),
    Object.freeze([".masthead", "Studio Inter"]),
    Object.freeze([".folio", "Studio JetBrains Mono"]),
  ]),
  explainer: Object.freeze([
    Object.freeze([".slide-heading", "Studio Inter Tight"]),
    Object.freeze([".slide-paragraph", "Studio Inter"]),
    Object.freeze([".slide-list li", "Studio Inter"]),
    Object.freeze([".topline", "Studio Inter"]),
    Object.freeze([".counter", "Studio Inter"]),
  ]),
  manifesto: Object.freeze([
    Object.freeze([".slide-heading", "Studio Inter Tight"]),
    Object.freeze([".slide-paragraph", "Studio Inter Tight"]),
    Object.freeze([".slide-list li", "Studio Inter Tight"]),
    Object.freeze([".chrome", "Studio Inter Tight"]),
  ]),
  threshold: Object.freeze([
    Object.freeze([".slide-heading", "Studio Inter"]),
    Object.freeze([".slide-paragraph", "Studio Inter"]),
    Object.freeze([".slide-list li", "Studio Inter"]),
    Object.freeze([".header strong", "Studio Inter"]),
  ]),
});

export const STUDIO_CAROUSEL_FIT_ATTRIBUTE = "data-studio-carousel-fit";
export const STUDIO_CAROUSEL_FIT_DETAIL_ATTRIBUTE = "data-studio-carousel-fit-detail";
const CONFIG_RECEIPT_KEYS = [
  "contract_revision",
  "house_look",
  "renderer",
  "template_id",
  "template_version",
];

const freezeContract = (contract) => Object.freeze({
  ...contract,
  layouts: Object.freeze([...contract.layouts]),
  defaultSequence: Object.freeze([...contract.defaultSequence]),
  contactSheet: Object.freeze({ ...contract.contactSheet }),
});

/**
 * The IDs and version below are the canonical parity boundary shared with the
 * backend's studio_carousel_config receipt. Templates are local signed assets:
 * arbitrary HTML from backend_settings never crosses the renderer boundary.
 */
export const STUDIO_CAROUSEL_LOOK_CONTRACTS = Object.freeze({
  cobalt: freezeContract({
    templateId: "house-cobalt-v1",
    templateVersion: STUDIO_CAROUSEL_TEMPLATE_VERSION,
    templateFile: "house-cobalt-v1.html",
    layouts: ["cover", "frame", "column", "statement", "photo", "service", "blue_field", "evidence", "closer"],
    defaultSequence: ["cover", "frame", "column", "statement", "photo", "service", "blue_field", "photo", "evidence", "closer"],
    contactSheet: { background: "#070A12", foreground: "#F6F8FF", accent: "#315BFF" },
  }),
  editorial: freezeContract({
    templateId: "house-editorial-v1",
    templateVersion: STUDIO_CAROUSEL_TEMPLATE_VERSION,
    templateFile: "house-editorial-v1.html",
    layouts: ["cover", "hook", "body", "quote", "list", "closer"],
    defaultSequence: ["cover", "hook", "body", "body", "body", "quote", "body", "body", "list", "closer"],
    contactSheet: { background: "#DED8CE", foreground: "#211E1B", accent: "#9B3D2E" },
  }),
  explainer: freezeContract({
    templateId: "house-explainer-v1",
    templateVersion: STUDIO_CAROUSEL_TEMPLATE_VERSION,
    templateFile: "house-explainer-v1.html",
    layouts: ["cover", "overview", "definition", "examples", "subcategories", "summary", "closer"],
    defaultSequence: ["cover", "overview", "definition", "examples", "subcategories", "definition", "examples", "definition", "summary", "closer"],
    contactSheet: { background: "#F2E8D8", foreground: "#17202B", accent: "#E2603F" },
  }),
  manifesto: freezeContract({
    templateId: "house-manifesto-v1",
    templateVersion: STUDIO_CAROUSEL_TEMPLATE_VERSION,
    templateFile: "house-manifesto-v1.html",
    layouts: ["cover", "body", "punch", "list", "closer"],
    defaultSequence: ["cover", "body", "body", "body", "punch", "body", "body", "list", "punch", "closer"],
    contactSheet: { background: "#000000", foreground: "#FFFFFF", accent: "#FFFFFF" },
  }),
  threshold: freezeContract({
    templateId: "house-threshold-v1",
    templateVersion: STUDIO_CAROUSEL_TEMPLATE_VERSION,
    templateFile: "house-threshold-v1.html",
    layouts: ["cover", "questions", "body", "photo", "diagram", "closer_visual", "closer"],
    defaultSequence: ["cover", "questions", "body", "photo", "photo", "body", "diagram", "closer_visual", "photo", "closer"],
    contactSheet: { background: "#D8CDBE", foreground: "#1A1612", accent: "#E86A2C" },
  }),
});

const templateCache = new Map();

const plainObject = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const normalizedText = (value, label, maxChars) => {
  if (typeof value !== "string") throw new Error(`${label} must be plain text`);
  const text = value.replace(/\r\n?/g, "\n").replaceAll("\0", "").trim();
  if (!text) throw new Error(`${label} must not be empty`);
  if (text.length > maxChars) throw new Error(`${label} exceeds ${maxChars} characters`);
  return text;
};

export function countStudioCarouselWords(value) {
  const text = typeof value === "string" ? value.normalize("NFKC") : "";
  // Count scripts without whitespace (CJK) per character and pictographs per
  // glyph instead of treating an entire run as one "word". Space-delimited
  // scripts such as Hangul stay in ordinary letter/number runs; counting every
  // Korean syllable as a word rejected otherwise valid copy. The TypeScript
  // checkpoint validator deliberately carries this same state machine.
  let count = 0;
  let inWord = false;
  for (const character of text) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(character)) {
      count += 1;
      inWord = false;
    } else if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(character)) {
      count += 1;
      inWord = false;
    } else if (/[\p{L}\p{N}]/u.test(character)) {
      if (!inWord) count += 1;
      inWord = true;
    } else if (!(/[\p{M}’']/u.test(character) && inWord)) {
      inWord = false;
    }
  }
  return count;
}

function studioCarouselTextBlocks(text) {
  const blocks = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: "paragraph", text: paragraph.join(" ").replace(/\s+/g, " ").trim() });
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push(list);
    list = null;
  };

  for (const sourceLine of text.split("\n")) {
    const line = sourceLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }
    const unordered = line.match(/^(?:[-*•])\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    const item = unordered?.[1] ?? ordered?.[1];
    if (item) {
      flushParagraph();
      const orderedList = Boolean(ordered);
      if (!list || list.ordered !== orderedList) {
        flushList();
        list = { type: "list", ordered: orderedList, items: [] };
      }
      list.items.push(item.trim());
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}

export function assertStudioCarouselSlideCopy(value, { layout, number } = {}) {
  const text = normalizedText(value, `Slide ${number ?? "?"} text`, MAX_SLIDE_TEXT_CHARS);
  const isCover = layout === "cover" || number === 1;
  const isCloser = layout === "closer" || number === STUDIO_CAROUSEL_SLIDE_COUNT;
  const wordLimit = isCover
    ? STUDIO_CAROUSEL_SLIDE_WORD_LIMITS.cover
    : isCloser
      ? STUDIO_CAROUSEL_SLIDE_WORD_LIMITS.closer
      : STUDIO_CAROUSEL_SLIDE_WORD_LIMITS.middle;
  const characterLimit = isCover ? 140 : isCloser ? 240 : 360;
  const words = countStudioCarouselWords(text);
  if (words > wordLimit) {
    throw new Error(`Slide ${number ?? "?"} exceeds the ${wordLimit}-word ${isCover ? "cover" : isCloser ? "closer" : "slide"} fit boundary`);
  }
  if (text.length > characterLimit) {
    throw new Error(`Slide ${number ?? "?"} exceeds the ${characterLimit}-character fit boundary`);
  }
  const tokens = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.some((token) => [...token].length > STUDIO_CAROUSEL_MAX_UNBROKEN_CHARS)) {
    throw new Error(`Slide ${number ?? "?"} contains a word longer than the ${STUDIO_CAROUSEL_MAX_UNBROKEN_CHARS}-character fit boundary`);
  }
  const blocks = studioCarouselTextBlocks(text);
  if (blocks.length > 4) {
    throw new Error(`Slide ${number ?? "?"} exceeds the four-block fit boundary`);
  }
  const lists = blocks.filter((block) => block.type === "list");
  if (lists.length > 1 || lists.some((list) => list.items.length > 5)) {
    throw new Error(`Slide ${number ?? "?"} exceeds the one-list/five-item fit boundary`);
  }
  return Object.freeze({ text, words, wordLimit, characterLimit, blocks: Object.freeze(blocks) });
}

function studioCarouselFontFaces(look) {
  const names = LOOK_FONT_ASSETS[look];
  if (!names) throw new Error(`No signed font registry exists for ${look}`);
  return names.flatMap((name) => {
    const font = FONT_ASSETS[name];
    if (!font) throw new Error(`Unknown signed carousel font: ${name}`);
    const faces = [["normal", font.normal], ["italic", font.italic]].filter(([, file]) => Boolean(file));
    return faces.map(([style, file]) => {
      const source = pathToFileURL(join(ASSET_DIR, file)).href;
      return `@font-face{font-family:"${font.family}";src:url("${source}") format("truetype");font-style:${style};font-weight:100 900;font-display:block}`;
    });
  }).join("");
}

function studioCarouselAssetReplacements(look) {
  return Object.entries(LOOK_IMAGE_ASSETS[look] ?? {}).map(([token, file]) => [
    token,
    pathToFileURL(join(ASSET_DIR, file)).href,
  ]);
}

function studioCarouselAssetPreloads(look, layout, number) {
  let files = [];
  if (look === "cobalt") {
    if (layout === "photo") files = [number === 8 ? "images/cobalt-photo-02.jpg" : "images/cobalt-photo-01.jpg"];
    else if (layout === "frame" || layout === "statement") files = ["images/cobalt-gradient-02.webp"];
    else if (layout === "column") files = ["images/cobalt-gradient-03.webp"];
    else if (layout === "service") files = ["images/cobalt-gradient-04.webp"];
    else if (layout !== "blue_field") files = ["images/cobalt-gradient-01.webp"];
  } else if (look === "threshold") {
    if (layout === "closer") files = ["images/threshold-photo-04.jpg"];
    else if (layout === "photo") {
      files = [number === 5
        ? "images/threshold-photo-02.jpg"
        : number === 9
          ? "images/threshold-photo-03.jpg"
          : "images/threshold-photo-01.jpg"];
    }
  }
  return files.map((file) => {
    const source = pathToFileURL(join(ASSET_DIR, file)).href;
    return `<img src="${source}" alt="" style="display:block;width:1px;height:1px">`;
  }).join("");
}

export function studioCarouselContractForLook(look) {
  const contract = STUDIO_CAROUSEL_LOOK_CONTRACTS[look];
  if (!contract) throw new Error(`Unsupported carousel house look: ${String(look)}`);
  return contract;
}

export function assertStudioCarouselConfigReceipt(rawReceipt) {
  let receipt = rawReceipt;
  if (typeof rawReceipt === "string") {
    try {
      receipt = JSON.parse(rawReceipt);
    } catch {
      throw new Error("Carousel configuration receipt is not valid JSON");
    }
  }
  if (!plainObject(receipt)) throw new Error("Carousel configuration receipt is missing");
  const keys = Object.keys(receipt).sort();
  if (keys.length !== CONFIG_RECEIPT_KEYS.length || CONFIG_RECEIPT_KEYS.some((key, index) => keys[index] !== key)) {
    throw new Error("Carousel configuration receipt has unsupported fields");
  }
  if (receipt.contract_revision !== STUDIO_CAROUSEL_CONFIG_CONTRACT) {
    throw new Error(`Carousel configuration contract must be ${STUDIO_CAROUSEL_CONFIG_CONTRACT}`);
  }
  if (receipt.renderer !== "content_manager" && receipt.renderer !== "factory") {
    throw new Error("Carousel configuration renderer must be content_manager or factory");
  }
  const look = typeof receipt.house_look === "string" ? receipt.house_look : "";
  const contract = studioCarouselContractForLook(look);
  if (receipt.template_id !== contract.templateId || receipt.template_version !== contract.templateVersion) {
    throw new Error(`Carousel template receipt does not match ${look} (${contract.templateId}@${contract.templateVersion})`);
  }
  return Object.freeze({
    contract_revision: receipt.contract_revision,
    renderer: receipt.renderer,
    house_look: look,
    template_id: contract.templateId,
    template_version: contract.templateVersion,
  });
}

export function normalizeStudioCarouselPayload(payload, look) {
  if (!plainObject(payload)) throw new Error("Carousel model response must be a plain JSON object");
  if (payload.contract_version !== STUDIO_CAROUSEL_RENDER_CONTRACT) {
    throw new Error(`Carousel model response must use ${STUDIO_CAROUSEL_RENDER_CONTRACT}`);
  }
  if (!Array.isArray(payload.slides) || payload.slides.length !== STUDIO_CAROUSEL_SLIDE_COUNT) {
    throw new Error(`Carousel must contain exactly ${STUDIO_CAROUSEL_SLIDE_COUNT} slides`);
  }

  const contract = studioCarouselContractForLook(look);
  const allowed = new Set(contract.layouts);
  const slides = payload.slides.map((raw, index) => {
    if (!plainObject(raw)) throw new Error(`Slide ${index + 1} must be a plain JSON object`);
    const text = normalizedText(raw.text, `Slide ${index + 1} text`, MAX_SLIDE_TEXT_CHARS);
    const proposed = typeof raw.layout === "string" ? raw.layout.trim().toLowerCase() : "";
    let layout = contract.defaultSequence[index];
    if (index === 0) layout = "cover";
    else if (index === STUDIO_CAROUSEL_SLIDE_COUNT - 1) layout = "closer";
    else if (allowed.has(proposed) && proposed !== "cover" && proposed !== "closer") layout = proposed;
    assertStudioCarouselSlideCopy(text, { layout, number: index + 1 });
    return Object.freeze({ text, layout });
  });

  const caption = typeof payload.caption === "string"
    ? payload.caption.replace(/\r\n?/g, "\n").replaceAll("\0", "").trim().slice(0, MAX_CAPTION_CHARS)
    : "";
  return Object.freeze({
    contract_version: STUDIO_CAROUSEL_RENDER_CONTRACT,
    house_look: look,
    template_id: contract.templateId,
    template_version: contract.templateVersion,
    slides: Object.freeze(slides),
    caption,
  });
}

export function studioCarouselModelInstruction(look) {
  const contract = studioCarouselContractForLook(look);
  const middleLayouts = contract.layouts.filter((layout) => layout !== "cover" && layout !== "closer");
  return (
    `Return ONLY JSON using this exact contract: ` +
    `{"contract_version":"${STUDIO_CAROUSEL_RENDER_CONTRACT}",` +
    `"slides":[{"layout":"...","text":"..."}],"caption":"..."}. ` +
    `Return exactly ${STUDIO_CAROUSEL_SLIDE_COUNT} slides. ` +
    `Allowed middle-slide layouts for ${look}: ${middleLayouts.join(", ")}. ` +
    `The house style's canonical 10-slot sequence is: ${contract.defaultSequence.join(", ")}. ` +
    `Slide 1 is always a scroll-stopping cover (max 12 words). ` +
    `Slide 10 is always a soft closer/CTA (max 20 words). One idea per slide, max 28 words, plain text only. ` +
    `No unbroken word may exceed ${STUDIO_CAROUSEL_MAX_UNBROKEN_CHARS} characters. ` +
    `Use no more than four text blocks and no more than five list items. ` +
    `Use blank lines for deliberate paragraphs and hyphen-prefixed lines for lists. Never emit HTML. Never invent statistics.`
  );
}

export function escapeStudioCarouselHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderStudioCarouselText(text) {
  const blocks = studioCarouselTextBlocks(normalizedText(text, "Slide text", MAX_SLIDE_TEXT_CHARS));
  let firstParagraph = true;
  return blocks.map((block) => {
    if (block.type === "paragraph") {
      const tag = firstParagraph ? "h1" : "p";
      const className = firstParagraph ? "slide-heading" : "slide-paragraph";
      firstParagraph = false;
      return `<${tag} class="${className}">${escapeStudioCarouselHtml(block.text)}</${tag}>`;
    }
    const tag = block.ordered ? "ol" : "ul";
    const items = block.items
      .map((item) => `<li>${escapeStudioCarouselHtml(item)}</li>`)
      .join("");
    return `<${tag} class="slide-list">${items}</${tag}>`;
  }).join("");
}

function loadStudioCarouselTemplate(look) {
  if (templateCache.has(look)) return templateCache.get(look);
  const contract = studioCarouselContractForLook(look);
  const template = readFileSync(join(TEMPLATE_DIR, contract.templateFile), "utf8");
  for (const token of REQUIRED_TEMPLATE_TOKENS) {
    if (!template.includes(token)) throw new Error(`${contract.templateFile} is missing ${token}`);
  }
  if (/https?:\/\//i.test(template) || /<script\b/i.test(template)) {
    throw new Error(`${contract.templateFile} must be a self-contained, script-free runtime template`);
  }
  templateCache.set(look, template);
  return template;
}

export function renderStudioCarouselSlide({ look, slide, number }) {
  const contract = studioCarouselContractForLook(look);
  if (!plainObject(slide) || !contract.layouts.includes(slide.layout)) {
    throw new Error(`Slide ${number} has an invalid ${look} layout`);
  }
  if (!Number.isInteger(number) || number < 1 || number > STUDIO_CAROUSEL_SLIDE_COUNT) {
    throw new Error("Carousel slide number is out of range");
  }
  const expectedLayout = number === 1
    ? "cover"
    : number === STUDIO_CAROUSEL_SLIDE_COUNT
      ? "closer"
      : slide.layout;
  if (slide.layout !== expectedLayout) throw new Error(`Slide ${number} must use ${expectedLayout}`);
  assertStudioCarouselSlideCopy(slide.text, { layout: slide.layout, number });

  const replacements = new Map([
    ["{{font_faces}}", studioCarouselFontFaces(look)],
    ["{{contract_version}}", STUDIO_CAROUSEL_RENDER_CONTRACT],
    ["{{template_id}}", contract.templateId],
    ["{{slide_layout}}", slide.layout],
    ["{{slide_content}}", renderStudioCarouselText(slide.text)],
    ["{{slide_number}}", String(number).padStart(2, "0")],
    ["{{slide_total}}", String(STUDIO_CAROUSEL_SLIDE_COUNT).padStart(2, "0")],
    ["{{asset_preloads}}", studioCarouselAssetPreloads(look, slide.layout, number)],
    ...studioCarouselAssetReplacements(look),
  ]);
  let html = loadStudioCarouselTemplate(look);
  for (const [token, value] of replacements) html = html.replaceAll(token, value);
  if (/\{\{[^}]+\}\}/.test(html)) throw new Error(`${contract.templateFile} contains an unresolved placeholder`);
  return html;
}

/**
 * Trusted, deterministic browser-side fit proof used by both the real Chrome
 * release gate and the runner immediately before it captures a slide. The
 * model cannot influence this source: only its escaped text is present in the
 * already-rendered document.
 */
export function studioCarouselFitProbeScript(look) {
  studioCarouselContractForLook(look);
  const expectations = JSON.stringify(STUDIO_CAROUSEL_FONT_ROLE_EXPECTATIONS[look]);
  return String.raw`(()=>{
    const root=document.documentElement;
    const encode=value=>{const bytes=new TextEncoder().encode(JSON.stringify(value));let binary="";for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary)};
    const finish=(status,detail)=>{root.setAttribute("${STUDIO_CAROUSEL_FIT_ATTRIBUTE}",status);root.setAttribute("${STUDIO_CAROUSEL_FIT_DETAIL_ATTRIBUTE}",encode(detail))};
    let readinessPoll=0;
    const run=()=>{try{
      const readinessFonts=[...document.fonts];
      const rolePending=${expectations}.some(([selector,family])=>{const element=document.querySelector(selector);if(!element)return false;const style=getComputedStyle(element);return !readinessFonts.some(face=>face.family.replace(/["']/g,"")===family&&face.style===style.fontStyle&&face.status==="loaded")});
      const imagePending=[...document.images].some(image=>!image.complete||image.naturalWidth<1||image.naturalHeight<1);
      if((rolePending||imagePending)&&readinessPoll<${STUDIO_CAROUSEL_FIT_READINESS_MAX_POLLS}){
        readinessPoll+=1;
        setTimeout(run,${STUDIO_CAROUSEL_FIT_READINESS_POLL_MS});
        return;
      }
      const slide=document.querySelector(".slide");
      const content=document.querySelector(".slide-content");
      const header=document.querySelector(".chrome,.masthead,.topline,.header");
      const footer=document.querySelector(".index,.folio,.counter,.footer");
      if(!slide||!content||!header||!footer)throw new Error("signed carousel frame is incomplete");
      const rect=value=>({left:value.left,right:value.right,top:value.top,bottom:value.bottom,width:value.width,height:value.height});
      const inside=(inner,outer,tolerance=1)=>inner.left>=outer.left-tolerance&&inner.right<=outer.right+tolerance&&inner.top>=outer.top-tolerance&&inner.bottom<=outer.bottom+tolerance;
      const slideRect=slide.getBoundingClientRect();
      const contentRect=content.getBoundingClientRect();
      const headerRect=header.getBoundingClientRect();
      const footerRect=footer.getBoundingClientRect();
      const violations=[];
      if(!inside(contentRect,slideRect))violations.push({selector:".slide-content",reason:"outside_artboard",rect:rect(contentRect)});
      if(contentRect.top<headerRect.bottom-1)violations.push({selector:".slide-content",reason:"header_overlap",rect:rect(contentRect),boundary:rect(headerRect)});
      if(contentRect.bottom>footerRect.top+1)violations.push({selector:".slide-content",reason:"footer_overlap",rect:rect(contentRect),boundary:rect(footerRect)});
      const contentStyle=getComputedStyle(content);
      const clippedWidth=contentStyle.overflowX!=="visible"&&content.scrollWidth>content.clientWidth+1;
      const clippedHeight=contentStyle.overflowY!=="visible"&&content.scrollHeight>content.clientHeight+1;
      if(clippedWidth||clippedHeight)violations.push({selector:".slide-content",reason:"clipped_scroll_overflow",overflow:[contentStyle.overflowX,contentStyle.overflowY],client:[content.clientWidth,content.clientHeight],scroll:[content.scrollWidth,content.scrollHeight]});
      const textNodes=[...document.querySelectorAll(".slide-heading,.slide-paragraph,.slide-list,.slide-list li")];
      if(!textNodes.some(element=>element.matches(".slide-heading")))throw new Error("slide heading is missing");
      for(const element of textNodes){
        const style=getComputedStyle(element);
        if(style.overflowWrap!=="anywhere")violations.push({selector:element.className,reason:"unsafe_overflow_wrap",actual:style.overflowWrap});
        const range=document.createRange();
        range.selectNodeContents(element);
        const fragments=[...range.getClientRects()];
        for(const fragment of fragments){
          if(!inside(fragment,slideRect,2))violations.push({selector:element.className,reason:"text_outside_artboard",rect:rect(fragment)});
          const elementRect=element.getBoundingClientRect();
          if(fragment.left<elementRect.left-3||fragment.right>elementRect.right+3)violations.push({selector:element.className,reason:"uncontained_text_width",rect:rect(fragment),boundary:rect(elementRect)});
        }
      }
      const declaredFonts=[...document.fonts];
      const roles=[];
      for(const [selector,family] of ${expectations}){
        const element=document.querySelector(selector);
        if(!element)continue;
        const style=getComputedStyle(element);
        const primary=style.fontFamily.split(",")[0].replace(/["']/g,"").trim();
        const query=(style.fontStyle==="normal"?"":style.fontStyle+" ")+style.fontWeight+" 48px \""+family+"\"";
        const faceLoaded=declaredFonts.some(face=>face.family.replace(/["']/g,"")===family&&face.style===style.fontStyle&&face.status==="loaded");
        const loaded=faceLoaded&&document.fonts.check(query);
        roles.push({selector,family,primary,weight:style.fontWeight,style:style.fontStyle,loaded});
        if(primary!==family||!loaded)violations.push({selector,reason:"font_fallback",family,primary,weight:style.fontWeight,style:style.fontStyle,loaded});
      }
      if(roles.length<2)violations.push({selector:"typography",reason:"insufficient_roles",count:roles.length});
      const roleFamilies=new Set(${expectations}.map(([,family])=>family));
      const faces=declaredFonts.filter(face=>roleFamilies.has(face.family.replace(/["']/g,""))).map(face=>({family:face.family.replace(/["']/g,""),style:face.style,weight:face.weight,status:face.status}));
      const preloadImages=[...document.images];
      const assetUrls=new Set(preloadImages.map(image=>image.currentSrc||image.src).filter(Boolean));
      const backgroundTargets=[slide,...slide.querySelectorAll("*")];
      for(const element of backgroundTargets){
        for(const pseudo of [null,"::before","::after"]){
          const backgroundStyle=getComputedStyle(element,pseudo);
          if(backgroundStyle.display==="none")continue;
          const background=backgroundStyle.backgroundImage;
          for(const match of background.matchAll(/url\((?:"([^"]+)"|'([^']+)'|([^)'\"]+))\)/g))assetUrls.add(match[1]||match[2]||match[3]);
        }
      }
      const assets=[];
      for(const url of assetUrls){
        const asset={url,loaded:false,width:0,height:0};
        if(!url.startsWith("file:")){
          violations.push({selector:"asset",reason:"non_local_asset",url});
          assets.push(asset);
          continue;
        }
        const image=preloadImages.find(candidate=>(candidate.currentSrc||candidate.src)===url);
        if(!image){
          asset.error="missing_signed_preload";
          violations.push({selector:"asset",reason:"image_decode_failed",url,error:asset.error});
          assets.push(asset);
          continue;
        }
        try{
          const canvas=document.createElement("canvas");
          canvas.width=2;canvas.height=2;
          const context=canvas.getContext("2d",{willReadFrequently:true});
          if(!image.complete||image.naturalWidth<1||image.naturalHeight<1)throw new Error("image_not_complete");
          context.drawImage(image,0,0,2,2);
          context.getImageData(0,0,2,2);
          asset.loaded=true;
        }catch(error){asset.error=String(error?.message||error)}
        asset.width=image.naturalWidth;
        asset.height=image.naturalHeight;
        if(!asset.loaded)violations.push({selector:"asset",reason:"image_decode_failed",url:asset.url,error:asset.error});
        assets.push(asset);
      }
      const detail={look:"${look}",layout:slide.dataset.layout,slide:slide.dataset.slide,fontStatus:document.fonts.status,beforeImage:getComputedStyle(slide,"::before").backgroundImage,faces,roles,assets,violations};
      if(violations.length)finish("fail",detail);else finish("pass",detail);
    }catch(error){finish("fail",{look:"${look}",error:String(error?.stack||error)})}};
    if(document.readyState==="complete")run();else window.addEventListener("load",run,{once:true});
  })();`;
}

/**
 * Trusted contact-sheet boundary. This deliberately writes the same signed
 * fit attributes as the per-slide probe so setup, production, and release
 * tests can all use proveStudioCarouselFitReady's identical 3 x 30s gate.
 * It accepts no model-controlled input and proves every one of the ten local
 * slide PNGs has really decoded before a screenshot can be taken.
 */
export function studioCarouselContactSheetProbeScript() {
  return String.raw`(()=>{
    const root=document.documentElement;
    const encode=value=>{const bytes=new TextEncoder().encode(JSON.stringify(value));let binary="";for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary)};
    const finish=(status,detail)=>{root.setAttribute("${STUDIO_CAROUSEL_FIT_ATTRIBUTE}",status);root.setAttribute("${STUDIO_CAROUSEL_FIT_DETAIL_ATTRIBUTE}",encode(detail))};
    let readinessPoll=0;
    const run=()=>{try{
      const images=[...document.images];
      const imagePending=images.length!==${STUDIO_CAROUSEL_SLIDE_COUNT}||images.some(image=>!image.complete||image.naturalWidth<1||image.naturalHeight<1);
      if(imagePending&&readinessPoll<${STUDIO_CAROUSEL_FIT_READINESS_MAX_POLLS}){
        readinessPoll+=1;
        setTimeout(run,${STUDIO_CAROUSEL_FIT_READINESS_POLL_MS});
        return;
      }
      const grid=document.querySelector(".contact-grid");
      const cards=[...document.querySelectorAll(".contact-card")];
      if(!grid)throw new Error("signed carousel contact grid is missing");
      const violations=[];
      const rect=value=>({left:value.left,right:value.right,top:value.top,bottom:value.bottom,width:value.width,height:value.height});
      const inside=(inner,outer,tolerance=1)=>inner.left>=outer.left-tolerance&&inner.right<=outer.right+tolerance&&inner.top>=outer.top-tolerance&&inner.bottom<=outer.bottom+tolerance;
      const gridRect=grid.getBoundingClientRect();
      const viewport={left:0,top:0,right:document.documentElement.clientWidth,bottom:document.documentElement.clientHeight};
      if(cards.length!==${STUDIO_CAROUSEL_SLIDE_COUNT})violations.push({selector:".contact-card",reason:"wrong_card_count",actual:cards.length,expected:${STUDIO_CAROUSEL_SLIDE_COUNT}});
      if(images.length!==${STUDIO_CAROUSEL_SLIDE_COUNT})violations.push({selector:".contact-card img",reason:"wrong_image_count",actual:images.length,expected:${STUDIO_CAROUSEL_SLIDE_COUNT}});
      if(!inside(gridRect,viewport))violations.push({selector:".contact-grid",reason:"outside_artboard",rect:rect(gridRect),boundary:viewport});
      const gridStyle=getComputedStyle(grid);
      const columns=gridStyle.gridTemplateColumns.split(/\s+/).filter(Boolean);
      const rows=gridStyle.gridTemplateRows.split(/\s+/).filter(Boolean);
      if(columns.length!==2)violations.push({selector:".contact-grid",reason:"wrong_column_count",actual:columns});
      if(rows.length!==5)violations.push({selector:".contact-grid",reason:"wrong_row_count",actual:rows});
      const expectedSlides=Array.from({length:${STUDIO_CAROUSEL_SLIDE_COUNT}},(_,index)=>String(index+1).padStart(2,"0"));
      const actualSlides=cards.map(card=>card.dataset.slide);
      if(JSON.stringify(actualSlides)!==JSON.stringify(expectedSlides))violations.push({selector:".contact-card",reason:"wrong_slide_order",actual:actualSlides,expected:expectedSlides});
      const assets=[];
      for(const [index,image] of images.entries()){
        const url=image.currentSrc||image.src;
        const asset={index:index+1,url,loaded:false,width:image.naturalWidth,height:image.naturalHeight};
        if(!url.startsWith("file:")){
          asset.error="non_local_asset";
          violations.push({selector:".contact-card img",reason:"non_local_asset",index:index+1,url});
        }else{
          try{
            if(!image.complete||image.naturalWidth<1||image.naturalHeight<1)throw new Error("image_not_complete");
            const canvas=document.createElement("canvas");
            canvas.width=2;canvas.height=2;
            const context=canvas.getContext("2d",{willReadFrequently:true});
            context.drawImage(image,0,0,2,2);
            context.getImageData(0,0,2,2);
            asset.loaded=true;
          }catch(error){asset.error=String(error?.message||error)}
          if(!asset.loaded)violations.push({selector:".contact-card img",reason:"image_decode_failed",index:index+1,url,error:asset.error});
        }
        const card=cards[index];
        if(card){
          const cardRect=card.getBoundingClientRect();
          const imageRect=image.getBoundingClientRect();
          if(!inside(cardRect,gridRect,1))violations.push({selector:".contact-card",reason:"card_outside_grid",index:index+1,rect:rect(cardRect),boundary:rect(gridRect)});
          if(!inside(imageRect,cardRect,1))violations.push({selector:".contact-card img",reason:"image_outside_card",index:index+1,rect:rect(imageRect),boundary:rect(cardRect)});
          if(Math.abs(cardRect.width-500)>1||Math.abs(cardRect.height-666)>1)violations.push({selector:".contact-card",reason:"wrong_card_size",index:index+1,rect:rect(cardRect)});
          if(Math.abs(imageRect.width-480)>1||Math.abs(imageRect.height-600)>1)violations.push({selector:".contact-card img",reason:"wrong_image_size",index:index+1,rect:rect(imageRect)});
        }
        assets.push(asset);
      }
      const detail={kind:"contact_sheet",cards:cards.length,images:images.length,columns,rows,assets,violations};
      if(violations.length)finish("fail",detail);else finish("pass",detail);
    }catch(error){finish("fail",{kind:"contact_sheet",error:String(error?.stack||error)})}};
    if(document.readyState==="complete")run();else window.addEventListener("load",run,{once:true});
  })();`;
}

export function parseStudioCarouselFitProbeDump(html) {
  const source = typeof html === "string" ? html : "";
  const status = source.match(new RegExp(`${STUDIO_CAROUSEL_FIT_ATTRIBUTE}="(pass|fail)"`))?.[1];
  const encoded = source.match(new RegExp(`${STUDIO_CAROUSEL_FIT_DETAIL_ATTRIBUTE}="([A-Za-z0-9+/=]+)"`))?.[1];
  if (!status || !encoded) throw new Error("Studio carousel fit proof did not complete");
  let detail;
  try {
    detail = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    throw new Error("Studio carousel fit proof returned malformed detail");
  }
  if (status !== "pass") throw new Error(`Studio carousel fit proof failed: ${JSON.stringify(detail)}`);
  return Object.freeze({ status, detail: Object.freeze(detail) });
}

export function buildStudioCarouselContactSheet({ look, imageSources }) {
  const contract = studioCarouselContractForLook(look);
  if (!Array.isArray(imageSources) || imageSources.length !== STUDIO_CAROUSEL_SLIDE_COUNT) {
    throw new Error(`Contact sheet requires exactly ${STUDIO_CAROUSEL_SLIDE_COUNT} slide images`);
  }
  const cards = imageSources.map((source, index) => {
    if (typeof source !== "string" || !source.trim()) throw new Error(`Contact sheet slide ${index + 1} is missing`);
    const number = String(index + 1).padStart(2, "0");
    return `<figure class="contact-card" data-slide="${number}"><figcaption>${number}</figcaption><img src="${escapeStudioCarouselHtml(source)}" alt="Slide ${number}"></figure>`;
  }).join("");

  return `<!doctype html>
<html lang="en" data-carousel-contract="${STUDIO_CAROUSEL_RENDER_CONTRACT}" data-template-id="${contract.templateId}">
<head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:1200px;height:3600px;overflow:hidden}body{padding:48px;background:${contract.contactSheet.background};color:${contract.contactSheet.foreground};font-family:Arial,sans-serif}.contact-grid{display:grid;grid-template-columns:repeat(2,500px);grid-template-rows:repeat(5,666px);gap:24px 32px;justify-content:center}.contact-card{margin:0;width:500px;height:666px;padding:12px;background:#fff;border:1px solid ${contract.contactSheet.accent};position:relative;overflow:hidden}.contact-card figcaption{height:17px;margin:0 0 8px;color:#111;font-size:16px;line-height:17px;font-weight:800;letter-spacing:.12em}.contact-card img{display:block;width:480px;height:600px;object-fit:cover;background:#111}
</style></head><body><main class="contact-grid">${cards}</main></body></html>`;
}
