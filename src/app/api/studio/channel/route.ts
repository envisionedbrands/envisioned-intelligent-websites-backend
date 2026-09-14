/**
 * GET /api/studio/channel?url= — browse a YouTube channel for the Studio's
 * channel browser (paste a channel → pick videos → they land as a group).
 *
 * No API key, no runner: the channel page yields the channelId, YouTube's
 * public RSS feed yields the latest ~15 videos WITH view counts, and the
 * outlier multiple is computed against the feed's median views (the same
 * yardstick the runner's Outlier Radar uses). Instagram/TikTok profiles need
 * yt-dlp and return a clear "not yet".
 */
import { NextRequest, NextResponse } from "next/server";
import { studioAuth } from "@/lib/studio/auth";
import { classifyProfileUrl } from "@/lib/studio/platform";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export async function GET(request: NextRequest) {
  const auth = await studioAuth(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });

  const raw = request.nextUrl.searchParams.get("url") ?? "";
  const profile = classifyProfileUrl(raw);
  if (!profile) return NextResponse.json({ error: "Not a channel or profile URL" }, { status: 400 });
  if (profile.platform !== "youtube") {
    return NextResponse.json(
      { error: `${profile.platform === "instagram" ? "Instagram" : "TikTok"} profile browsing isn't wired yet — paste an individual post/Reel URL for now.` },
      { status: 400 }
    );
  }

  // channelId: straight from a /channel/UC… URL, otherwise mined from the page.
  let channelId = raw.match(/\/channel\/(UC[\w-]{22})/)?.[1] ?? null;
  let title: string | null = null;
  if (!channelId || !title) {
    // SOCS=CAI skips YouTube's consent interstitial (which otherwise replaces
    // the page for data-center IPs and hides every id pattern below).
    const page = await fetch(profile.url, {
      headers: { "User-Agent": UA, "Accept-Language": "en", Cookie: "SOCS=CAI" },
    });
    if (page.ok) {
      const html = await page.text();
      // The id appears in different shapes depending on the page build —
      // ytInitialData JSON, the RSS <link>, or the canonical channel URL.
      channelId =
        channelId ??
        html.match(/"channelId":"(UC[\w-]{22})"/)?.[1] ??
        html.match(/channel_id=(UC[\w-]{22})/)?.[1] ??
        html.match(/youtube\.com\/channel\/(UC[\w-]{22})/)?.[1] ??
        null;
      title =
        html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] ??
        html.match(/<title>([^<]+)<\/title>/)?.[1]?.replace(/ - YouTube$/, "") ??
        null;
    }
  }
  if (!channelId) {
    return NextResponse.json(
      { error: "Couldn't resolve the channel id from that URL. Try the channel's /channel/UC… URL." },
      { status: 422 }
    );
  }

  const feedRes = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {
    headers: { "User-Agent": UA },
  });
  if (!feedRes.ok) {
    return NextResponse.json({ error: `YouTube feed returned ${feedRes.status}` }, { status: 502 });
  }
  const xml = await feedRes.text();

  const videos: { id: string; url: string; title: string; published: string | null; views: number; thumbnail: string }[] = [];
  for (const entry of xml.split("<entry>").slice(1)) {
    const id = entry.match(/<yt:videoId>([\w-]+)<\/yt:videoId>/)?.[1];
    if (!id) continue;
    const vTitle = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? id;
    const published = entry.match(/<published>([^<]+)<\/published>/)?.[1] ?? null;
    const views = Number(entry.match(/<media:statistics views="(\d+)"/)?.[1] ?? 0);
    videos.push({
      id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: vTitle.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
      published,
      views,
      thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    });
  }
  if (!videos.length) {
    return NextResponse.json({ error: "The channel feed came back empty" }, { status: 502 });
  }

  const sorted = [...videos.map((v) => v.views)].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 1;
  const out = videos.map((v) => ({ ...v, outlier: Math.round((v.views / median) * 10) / 10 }));

  const feedTitle = xml.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? null;
  return NextResponse.json({
    channel: { id: channelId, title: title ?? feedTitle ?? "YouTube channel", url: profile.url },
    median,
    videos: out,
  });
}
