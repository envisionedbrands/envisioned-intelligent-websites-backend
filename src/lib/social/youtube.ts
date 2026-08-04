/**
 * YouTube Data API v3 client — Shorts are just regular uploads that happen to
 * be vertical and ≤3 minutes; YouTube classifies them automatically.
 *
 * Auth model: one offline refresh_token per channel (Google OAuth with
 * access_type=offline). Access tokens are minted per tick and never stored.
 *
 * Upload path: unlike Meta, YouTube won't pull from a URL — we open the
 * hosted video and stream its body straight into a resumable upload session,
 * so nothing is buffered in worker memory.
 */
import type { MetricSnapshot } from "./types";

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const YT = "https://www.googleapis.com/youtube/v3";

export function googleOAuthConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function googleAuthorizeUrl(redirectUri: string, state: string): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID!);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "scope",
    // force-ssl is what unlocks captions.download, so agents can work from a
    // video's real transcript, not just its title. Adding a scope means an
    // already-connected channel must reconnect before it takes effect
    // (prompt=consent below re-mints the refresh token with the new scope).
    [
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/youtube.force-ssl",
    ].join(" ")
  );
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent"); // force refresh_token on re-connect
  url.searchParams.set("state", state);
  return url.toString();
}

export async function googleExchangeCode(
  code: string,
  redirectUri: string
): Promise<{ accessToken: string; refreshToken: string | null }> {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    error_description?: string;
  };
  if (!data.access_token) throw new Error(data.error_description || "Google code exchange failed");
  return { accessToken: data.access_token, refreshToken: data.refresh_token || null };
}

export async function googleRefreshAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json()) as { access_token?: string; error_description?: string };
  if (!data.access_token) {
    throw new Error(data.error_description || "YouTube token refresh failed — reconnect the channel");
  }
  return data.access_token;
}

export async function ytOwnChannel(
  accessToken: string
): Promise<{ id: string; title: string; customUrl: string | null; thumbnail: string | null }> {
  const url = new URL(`${YT}/channels`);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("mine", "true");
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json()) as {
    items?: Array<{
      id: string;
      snippet?: { title?: string; customUrl?: string; thumbnails?: { default?: { url?: string } } };
    }>;
    error?: { message?: string };
  };
  const ch = data.items?.[0];
  if (!ch) throw new Error(data.error?.message || "No YouTube channel on this Google account");
  return {
    id: ch.id,
    title: ch.snippet?.title || "YouTube channel",
    customUrl: ch.snippet?.customUrl || null,
    thumbnail: ch.snippet?.thumbnails?.default?.url || null,
  };
}

/**
 * Upload a hosted video to YouTube. Synchronous from our side — once the
 * bytes land, YouTube's own processing continues but the video id is final.
 */
export async function ytUploadVideo(
  accessToken: string,
  opts: { videoUrl: string; title: string; description: string }
): Promise<{ videoId: string; url: string }> {
  const source = await fetch(opts.videoUrl);
  if (!source.ok || !source.body) {
    throw new Error(`Could not read video from storage (HTTP ${source.status})`);
  }
  const contentLength = source.headers.get("content-length");
  if (!contentLength) throw new Error("Storage did not report a video size");

  // Session init: metadata only. Title caps at 100 chars on YouTube.
  const initRes = await fetch(
    `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": contentLength,
        "X-Upload-Content-Type": "video/mp4",
      },
      body: JSON.stringify({
        snippet: {
          title: opts.title.slice(0, 100) || "Short",
          description: opts.description.slice(0, 5000),
          categoryId: "22", // People & Blogs
        },
        status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
      }),
    }
  );
  if (!initRes.ok) {
    const err = (await initRes.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`YouTube upload init failed: ${err.error?.message || `HTTP ${initRes.status}`}`);
  }
  const uploadUrl = initRes.headers.get("location");
  if (!uploadUrl) throw new Error("YouTube did not return a resumable upload URL");

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Length": contentLength,
      "Content-Type": "video/mp4",
    },
    body: source.body,
    // Required for streaming request bodies under Node (next dev); harmless in workerd.
    ...({ duplex: "half" } as Record<string, unknown>),
  });
  const video = (await putRes.json().catch(() => ({}))) as {
    id?: string;
    error?: { message?: string };
  };
  if (!putRes.ok || !video.id) {
    throw new Error(`YouTube upload failed: ${video.error?.message || `HTTP ${putRes.status}`}`);
  }
  return { videoId: video.id, url: `https://www.youtube.com/shorts/${video.id}` };
}

export async function ytFetchMetrics(
  accessToken: string,
  videoId: string
): Promise<MetricSnapshot> {
  const url = new URL(`${YT}/videos`);
  url.searchParams.set("part", "statistics");
  url.searchParams.set("id", videoId);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json()) as {
    items?: Array<{
      statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
    }>;
    error?: { message?: string };
  };
  if (data.error) throw new Error(data.error.message || "YouTube stats fetch failed");
  const s = data.items?.[0]?.statistics;
  return {
    views: Number(s?.viewCount || 0),
    likes: Number(s?.likeCount || 0),
    comments: Number(s?.commentCount || 0),
    shares: 0,
    saves: 0,
    reach: 0,
    raw: { statistics: s || null },
  };
}
