/**
 * Content Studio — URL → platform classification.
 * Mirrors Poppy's paste-anything behavior: the URL alone decides the node type.
 */

export type StudioPlatform =
  | "youtube"
  | "instagram"
  | "tiktok"
  | "facebook_ads"
  | "website"
  | "article"
  | "upload";

/**
 * Channel/profile URLs are a different animal from content URLs: they open the
 * channel browser (pick videos to add) instead of ingesting directly. YouTube
 * is browsable today (RSS, no runner needed); Instagram/TikTok profiles are
 * detected so the UI can say "not yet" instead of storing junk.
 */
export function classifyProfileUrl(
  raw: string
): { platform: "youtube" | "instagram" | "tiktok"; url: string } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const path = url.pathname.replace(/\/+$/, "");

  if (host.endsWith("youtube.com")) {
    if (/^\/(@[\w.-]+|channel\/[\w-]+|c\/[\w.-]+|user\/[\w.-]+)$/.test(path)) {
      return { platform: "youtube", url: url.toString() };
    }
    return null;
  }
  if (host.endsWith("instagram.com")) {
    const seg = path.split("/").filter(Boolean);
    if (seg.length === 1 && !["p", "reel", "reels", "stories", "explore", "tv", "accounts"].includes(seg[0])) {
      return { platform: "instagram", url: url.toString() };
    }
    return null;
  }
  if (host.endsWith("tiktok.com")) {
    if (/^\/@[\w.-]+$/.test(path)) return { platform: "tiktok", url: url.toString() };
    return null;
  }
  return null;
}

export function classifyUrl(raw: string): { platform: StudioPlatform; url: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();

  if (host === "youtu.be" || host.endsWith("youtube.com")) {
    return { platform: "youtube", url: url.toString() };
  }
  if (host.endsWith("instagram.com")) {
    return { platform: "instagram", url: url.toString() };
  }
  if (host.endsWith("tiktok.com")) {
    return { platform: "tiktok", url: url.toString() };
  }
  if (host.endsWith("facebook.com") && url.pathname.startsWith("/ads/library")) {
    return { platform: "facebook_ads", url: url.toString() };
  }
  return { platform: "website", url: url.toString() };
}
