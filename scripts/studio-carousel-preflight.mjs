import { X_OK } from "node:constants";
import { execFile as execFileCallback } from "node:child_process";
import {
  accessSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseStudioCarouselFitProbeDump,
  renderStudioCarouselSlide,
  studioCarouselFitProbeScript,
  STUDIO_CAROUSEL_FIT_MAX_ATTEMPTS,
  STUDIO_CAROUSEL_FIT_VIRTUAL_TIME_BUDGET_MS,
  STUDIO_CAROUSEL_LOOK_CONTRACTS,
} from "./studio-carousel-contract.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const execFile = promisify(execFileCallback);

export const STUDIO_CAROUSEL_CHROME_CANDIDATES = Object.freeze(
  process.env.STUDIO_CAROUSEL_CHROME_BIN
    ? [process.env.STUDIO_CAROUSEL_CHROME_BIN]
    : [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ],
);

export const STUDIO_CAROUSEL_RUNTIME_ASSETS = Object.freeze([
  "carousel-assets/fonts/Inter-Variable.ttf",
  "carousel-assets/fonts/Inter-Italic-Variable.ttf",
  "carousel-assets/fonts/Inter-Tight-Variable.ttf",
  "carousel-assets/fonts/Inter-Tight-Italic-Variable.ttf",
  "carousel-assets/fonts/Fraunces-Variable.ttf",
  "carousel-assets/fonts/Fraunces-Italic-Variable.ttf",
  "carousel-assets/fonts/JetBrains-Mono-Variable.ttf",
  "carousel-assets/images/cobalt-gradient-01.webp",
  "carousel-assets/images/cobalt-gradient-02.webp",
  "carousel-assets/images/cobalt-gradient-03.webp",
  "carousel-assets/images/cobalt-gradient-04.webp",
  "carousel-assets/images/cobalt-photo-01.jpg",
  "carousel-assets/images/cobalt-photo-02.jpg",
  "carousel-assets/images/threshold-photo-01.jpg",
  "carousel-assets/images/threshold-photo-02.jpg",
  "carousel-assets/images/threshold-photo-03.jpg",
  "carousel-assets/images/threshold-photo-04.jpg",
]);

export function findStudioCarouselChrome(candidates = STUDIO_CAROUSEL_CHROME_CANDIDATES) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      accessSync(candidate, X_OK);
      return candidate;
    } catch {
      // Keep looking. Setup fails closed only after every reviewed candidate.
    }
  }
  return null;
}

/**
 * Side-effect-free local runtime proof. Every signed look is parsed and
 * rendered in memory, and every font/image dependency is read now rather than
 * discovered after a queue claim or model spend.
 */
export function assertStudioCarouselRuntimeReady({
  scriptDir = SCRIPT_DIR,
  chromeCandidates = STUDIO_CAROUSEL_CHROME_CANDIDATES,
} = {}) {
  const chrome = findStudioCarouselChrome(chromeCandidates);
  if (!chrome) {
    throw new Error("No executable Chrome/Chromium was found for Studio carousel rendering. Install Google Chrome, then rerun Studio runner setup.");
  }

  const loadedAssets = [];
  for (const relativePath of STUDIO_CAROUSEL_RUNTIME_ASSETS) {
    const bytes = readFileSync(join(scriptDir, relativePath));
    if (bytes.length < 64) throw new Error(`Studio carousel asset is empty or truncated: ${relativePath}`);
    loadedAssets.push(relativePath);
  }

  const loadedLooks = [];
  for (const [look, contract] of Object.entries(STUDIO_CAROUSEL_LOOK_CONTRACTS)) {
    const templatePath = join(scriptDir, "carousel-templates", contract.templateFile);
    const template = readFileSync(templatePath, "utf8");
    if (!template.trim()) throw new Error(`Studio carousel template is empty: ${contract.templateFile}`);
    const html = renderStudioCarouselSlide({
      look,
      slide: { layout: "cover", text: "Clear work starts with one useful decision" },
      number: 1,
    });
    if (!html.includes(`data-template-id="${contract.templateId}"`) || /\{\{[^}]+\}\}/.test(html)) {
      throw new Error(`Studio carousel template failed its render smoke: ${contract.templateFile}`);
    }
    loadedLooks.push(look);
  }

  return Object.freeze({
    chrome,
    loadedLooks: Object.freeze(loadedLooks),
    loadedAssets: Object.freeze(loadedAssets),
  });
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const defaultChromeRun = async (chrome, args, options) => execFile(chrome, args, options);

// Backward-compatible names for callers that imported the preflight module
// before the constants became part of the signed renderer contract. There is
// one source of truth for setup, release tests, and production capture.
export const STUDIO_CAROUSEL_FIT_PROBE_ATTEMPTS = STUDIO_CAROUSEL_FIT_MAX_ATTEMPTS;
export const STUDIO_CAROUSEL_FIT_VIRTUAL_TIME_MS = STUDIO_CAROUSEL_FIT_VIRTUAL_TIME_BUDGET_MS;

const CAROUSEL_BROWSER_ENV_KEYS = Object.freeze([
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "XDG_CONFIG_HOME",
]);

export function studioCarouselBrowserEnv(source = process.env) {
  const env = {};
  for (const key of CAROUSEL_BROWSER_ENV_KEYS) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  env.PATH ||= "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
  return Object.freeze(env);
}

/**
 * The one trusted browser-fit boundary used by both setup preflight and every
 * production slide capture. Progressive local image decodes can outlive one
 * Chrome dump even with virtual time enabled, so the exact same bounded
 * three-attempt contract is used in both places and fails closed thereafter.
 */
export async function proveStudioCarouselFitReady({
  chrome,
  htmlFile,
  width,
  height,
  label = "Studio carousel",
  runChrome = defaultChromeRun,
  env = studioCarouselBrowserEnv(),
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= STUDIO_CAROUSEL_FIT_PROBE_ATTEMPTS; attempt += 1) {
    try {
      const { stdout = "" } = await runChrome(
        chrome,
        [
          "--headless=new",
          "--disable-gpu",
          "--no-sandbox",
          "--hide-scrollbars",
          "--allow-file-access-from-files",
          "--run-all-compositor-stages-before-draw",
          `--virtual-time-budget=${STUDIO_CAROUSEL_FIT_VIRTUAL_TIME_MS}`,
          "--force-device-scale-factor=1",
          `--window-size=${width},${height}`,
          "--dump-dom",
          pathToFileURL(htmlFile).href,
        ],
        { timeout: 45_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", env },
      );
      return parseStudioCarouselFitProbeDump(stdout);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `${label} browser fit proof failed after ${STUDIO_CAROUSEL_FIT_PROBE_ATTEMPTS} bounded attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/**
 * Execute the member machine's real browser boundary before the queue opens.
 * Each of the five signed looks must load its fonts/images, pass the same DOM
 * fit probe used for production capture, and emit a non-empty PNG. A caller
 * may inject runChrome only for an executable hermetic contract test.
 */
export async function proveStudioCarouselBrowserReady({
  proof,
  runChrome = defaultChromeRun,
  scratchParent = tmpdir(),
  env = studioCarouselBrowserEnv(),
} = {}) {
  if (!proof?.chrome || !Array.isArray(proof?.loadedLooks) || proof.loadedLooks.length !== 5) {
    throw new Error("Studio carousel browser preflight requires the complete local runtime proof");
  }
  const scratch = mkdtempSync(join(scratchParent, "studio-carousel-browser-preflight-"));
  const browserProofs = [];
  try {
    for (const look of proof.loadedLooks) {
      const contract = STUDIO_CAROUSEL_LOOK_CONTRACTS[look];
      if (!contract) throw new Error(`Studio carousel browser preflight found an unknown look: ${look}`);
      const htmlFile = join(scratch, `${look}.html`);
      const pngFile = join(scratch, `${look}.png`);
      const source = renderStudioCarouselSlide({
        look,
        slide: { layout: "cover", text: "Clear systems protect focused work" },
        number: 1,
      });
      const instrumented = source.replace(
        /<\/body>/i,
        `<script>${studioCarouselFitProbeScript(look)}</script></body>`,
      );
      if (instrumented === source) throw new Error(`Studio carousel preflight could not instrument ${look}`);
      writeFileSync(htmlFile, instrumented);

      const commonArgs = [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--hide-scrollbars",
        "--allow-file-access-from-files",
        "--run-all-compositor-stages-before-draw",
        `--virtual-time-budget=${STUDIO_CAROUSEL_FIT_VIRTUAL_TIME_MS}`,
        "--force-device-scale-factor=1",
        "--window-size=1080,1350",
      ];
      const fit = await proveStudioCarouselFitReady({
        chrome: proof.chrome,
        htmlFile,
        width: 1080,
        height: 1350,
        label: `Studio carousel ${look} preflight`,
        runChrome,
        env,
      });
      await runChrome(
        proof.chrome,
        [...commonArgs, `--screenshot=${pngFile}`, pathToFileURL(htmlFile).href],
        { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env },
      );
      if (!existsSync(pngFile)) throw new Error(`Studio carousel ${look} browser preflight produced no PNG`);
      const png = readFileSync(pngFile);
      if (png.length < 64 || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw new Error(`Studio carousel ${look} browser preflight produced an invalid PNG`);
      }
      browserProofs.push(Object.freeze({
        look,
        template_id: contract.templateId,
        fit: fit.status,
        png_bytes: png.length,
      }));
    }
    if (browserProofs.length !== 5) throw new Error("Studio carousel browser preflight did not prove all five signed looks");
    return Object.freeze({
      chrome: proof.chrome,
      browserProofs: Object.freeze(browserProofs),
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
