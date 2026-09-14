#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = resolve(dirname(scriptPath), "..");
const workspaceRoute = "/studio/workspace";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const requireFile = (path, message) => {
  assert(existsSync(path) && statSync(path).isFile(), message);
};

const requireDirectory = (path, message) => {
  assert(existsSync(path) && statSync(path).isDirectory(), message);
};

const readBuildId = (path, label) => {
  requireFile(path, `${label} build id is missing: ${path}`);
  const value = readFileSync(path, "utf8").trim();
  assert(value, `${label} build id is empty: ${path}`);
  return value;
};

const staticReferences = (html) => {
  const references = new Set();
  const attribute = /\b(?:src|href)=["'](\/_next\/static\/[^"'?#]+)(?:[?#][^"']*)?["']/g;
  for (const match of html.matchAll(attribute)) references.add(match[1]);
  return [...references].sort();
};

/**
 * Copy the current Next-generated workspace document into Cloudflare's direct
 * Static Assets tree. Validation happens before the atomic rename, and any
 * failure removes both stale and partial destinations so an old shell can
 * never be uploaded with a new Worker build.
 */
export function materializeStudioWorkspaceAsset(projectRoot = defaultProjectRoot) {
  const root = resolve(projectRoot);
  const nextRoot = join(root, ".next");
  const assetsRoot = join(root, ".open-next", "assets");
  const source = join(nextRoot, "server", "app", "studio", "workspace.html");
  const destination = join(assetsRoot, "studio", "workspace.html");
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;

  // Fail closed. A previous successful build must not mask a broken current
  // build when the deploy command uploads .open-next/assets.
  rmSync(destination, { force: true });
  rmSync(temporary, { force: true });

  try {
    const prerenderPath = join(nextRoot, "prerender-manifest.json");
    requireFile(prerenderPath, `Next prerender manifest is missing: ${prerenderPath}`);
    const prerenderManifest = JSON.parse(readFileSync(prerenderPath, "utf8"));
    const prerenderedWorkspace = prerenderManifest.routes?.[workspaceRoute];
    assert(prerenderedWorkspace, `${workspaceRoute} is absent from the Next prerender manifest`);
    assert.equal(
      prerenderedWorkspace.srcRoute,
      workspaceRoute,
      `${workspaceRoute} does not identify itself as the prerender source route`,
    );
    assert.equal(
      prerenderedWorkspace.initialRevalidateSeconds,
      false,
      `${workspaceRoute} is not an immutable build-time prerender`,
    );

    requireFile(source, `Next did not emit the Studio workspace document: ${source}`);
    requireDirectory(assetsRoot, `OpenNext Static Assets output is missing: ${assetsRoot}`);

    const nextBuildId = readBuildId(join(nextRoot, "BUILD_ID"), "Next");
    const assetsBuildId = readBuildId(join(assetsRoot, "BUILD_ID"), "OpenNext assets");
    assert.equal(
      assetsBuildId,
      nextBuildId,
      "Next and OpenNext Static Assets were produced by different builds",
    );

    const sourceBytes = readFileSync(source);
    assert(sourceBytes.length > 0, "Next emitted an empty Studio workspace document");
    const html = sourceBytes.toString("utf8");
    assert.match(html, /^\s*<!doctype html>/i, "Studio workspace output is not a full HTML document");
    assert.match(html, /<\/html>\s*$/i, "Studio workspace HTML document is incomplete");
    assert(
      html.includes(nextBuildId),
      "Studio workspace HTML does not carry the current Next build id",
    );

    const references = staticReferences(html);
    assert(references.length > 0, "Studio workspace HTML has no generated Next static references");
    for (const reference of references) {
      const target = resolve(assetsRoot, reference.slice(1));
      const withinAssets = relative(assetsRoot, target);
      assert(
        withinAssets && withinAssets !== ".." && !withinAssets.startsWith(`..${sep}`),
        `Studio workspace contains an unsafe static reference: ${reference}`,
      );
      requireFile(target, `Studio workspace references a missing OpenNext asset: ${reference}`);
    }

    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(temporary, sourceBytes, { flag: "wx" });
    renameSync(temporary, destination);

    const destinationBytes = readFileSync(destination);
    assert.deepEqual(
      destinationBytes,
      sourceBytes,
      "Materialized Studio workspace differs from the Next-generated document",
    );

    return {
      source,
      destination,
      buildId: nextBuildId,
      sha256: sha256(destinationBytes),
      bytes: destinationBytes.length,
      staticReferences: references.length,
    };
  } catch (error) {
    rmSync(temporary, { force: true });
    rmSync(destination, { force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    console.log(JSON.stringify(materializeStudioWorkspaceAsset(), null, 2));
  } catch (error) {
    console.error(
      `Studio workspace asset materialization failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
