/**
 * Native-post import — makes the Social calendar the one honest record.
 *
 * Posts made directly in the Instagram/Facebook/Substack apps never pass
 * through this system, so the calendar could not show them. Every tick, this pulls each
 * active account's recent posts from Meta and records the ones we have no
 * target for as read-only PUBLISHED entries (created_by 'native-import').
 *
 * Deliberately lean and unable to harm publishing:
 *  - read-only towards Meta (one GET per account per tick);
 *  - dedup by social_post_targets.external_id, so system-published posts and
 *    already-imported ones are never duplicated;
 *  - no media bytes are copied — Meta CDN media URLs expire, so the durable
 *    reference is the permalink on the target row (media rows are omitted);
 *  - post_type maps into the schema's two values: VIDEO → video, all else
 *    (single images, albums) → carousel — the same mapping the publisher uses.
 */
import type { AdminClient } from "@/lib/crm/types";
import { listOwnNotes, noteUrl, substackConfigured, SubstackAuthError } from "./substack";

const GRAPH = "https://graph.facebook.com/v21.0";
const PER_ACCOUNT_LIMIT = 20;

type ImportSummary = { checked: number; imported: number; errors: string[] };

export async function importNativePosts(supabase: AdminClient): Promise<ImportSummary> {
  const summary: ImportSummary = { checked: 0, imported: 0, errors: [] };

  const { data: accounts } = await supabase
    .from("social_accounts")
    .select("id, platform, external_id, access_token")
    .eq("status", "active")
    // Meta only — Substack has its own importer below and no token on the row.
    .in("platform", ["instagram", "facebook"]);

  const { data: targets } = await supabase
    .from("social_post_targets")
    .select("external_id")
    .not("external_id", "is", null);
  const known = new Set((targets || []).map((t) => t.external_id as string));

  for (const acc of accounts || []) {
    if (!acc.access_token || !acc.external_id) continue;
    try {
      const items =
        acc.platform === "instagram"
          ? await igMedia(acc.external_id, acc.access_token)
          : await fbPosts(acc.external_id, acc.access_token);
      for (const item of items) {
        summary.checked++;
        if (known.has(item.externalId)) continue;
        const { data: post, error } = await supabase
          .from("social_posts")
          .insert({
            title: item.title,
            caption: item.caption,
            post_type: item.postType,
            status: "published",
            published_at: item.publishedAt,
            created_by: "native-import",
          })
          .select("id")
          .single();
        if (error || !post) {
          summary.errors.push(`${acc.platform}: ${error?.message || "insert failed"}`);
          continue;
        }
        // The unique index on external_id makes concurrent ticks race-proof:
        // the loser's insert is refused (23505) and its post row is removed so
        // no orphan can ever duplicate on a later run. Plain insert, NOT an
        // upsert: the live index is partial (WHERE external_id IS NOT NULL),
        // and ON CONFLICT (external_id) can't match a partial index, so every
        // upsert failed with 42P10 — proven 2026-10-04, nothing imported since
        // the index went in on 2026-09-16.
        const { data: target, error: targetError } = await supabase
          .from("social_post_targets")
          .insert(
            {
              post_id: post.id,
              account_id: acc.id,
              platform: acc.platform,
              status: "published",
              external_id: item.externalId,
              external_url: item.permalink,
              published_at: item.publishedAt,
            })
          .select("id");
        if (targetError || !target?.length) {
          await supabase.from("social_posts").delete().eq("id", post.id).eq("created_by", "native-import");
          // 23505 = another tick recorded it first: expected, not an error.
          if (targetError && targetError.code !== "23505") summary.errors.push(`target ${item.externalId}: ${targetError.message}`);
          continue;
        }
        known.add(item.externalId);
        summary.imported++;
      }
    } catch (e) {
      summary.errors.push(`${acc.platform} ${acc.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const substack = await importSubstackNotes(supabase, known);
  summary.checked += substack.checked;
  summary.imported += substack.imported;
  summary.errors.push(...substack.errors);
  return summary;
}

/**
 * Notes she posts straight from the Substack app, recorded the same way so
 * the calendar and the stats cover every Note, not just the ones sent from
 * here. One GET per tick (her newest page of Notes). Substack is also where
 * a dead session first shows up, so this flips the account to 'error' when
 * Substack refuses the login and back to 'active' when it works again.
 */
async function importSubstackNotes(supabase: AdminClient, known: Set<string>): Promise<ImportSummary> {
  const summary: ImportSummary = { checked: 0, imported: 0, errors: [] };
  if (!substackConfigured()) return summary;

  const { data: accounts } = await supabase
    .from("social_accounts")
    .select("id, external_id, username, status")
    .eq("platform", "substack")
    .in("status", ["active", "error"]);

  for (const acc of accounts || []) {
    try {
      const notes = await listOwnNotes(acc.external_id, 1);
      if (acc.status === "error") {
        await supabase.from("social_accounts").update({ status: "active" }).eq("id", acc.id);
      }
      for (const note of notes) {
        summary.checked++;
        if (known.has(note.id)) continue;
        const { data: post, error } = await supabase
          .from("social_posts")
          .insert({
            title: titleFrom(note.body, "Substack note"),
            caption: note.body,
            post_type: "text",
            status: "published",
            published_at: note.date,
            created_by: "native-import",
          })
          .select("id")
          .single();
        if (error || !post) {
          summary.errors.push(`substack: ${error?.message || "insert failed"}`);
          continue;
        }
        const { data: target, error: targetError } = await supabase
          .from("social_post_targets")
          .insert(
            {
              post_id: post.id,
              account_id: acc.id,
              platform: "substack",
              status: "published",
              external_id: note.id,
              external_url: noteUrl(acc.username, note.id),
              published_at: note.date,
            })
          .select("id");
        if (targetError || !target?.length) {
          await supabase.from("social_posts").delete().eq("id", post.id).eq("created_by", "native-import");
          // 23505 = another tick recorded it first: expected, not an error.
          if (targetError && targetError.code !== "23505") summary.errors.push(`substack target ${note.id}: ${targetError.message}`);
          continue;
        }
        known.add(note.id);
        summary.imported++;
      }
    } catch (e) {
      if (e instanceof SubstackAuthError) {
        await supabase.from("social_accounts").update({ status: "error" }).eq("id", acc.id);
      }
      summary.errors.push(`substack ${acc.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return summary;
}

type NativeItem = {
  externalId: string;
  title: string;
  caption: string;
  postType: "video" | "carousel";
  publishedAt: string;
  permalink: string | null;
};

function titleFrom(caption: string, fallback: string): string {
  const first = (caption || "").split("\n")[0].trim();
  return (first || fallback).slice(0, 80);
}

async function igMedia(igId: string, token: string): Promise<NativeItem[]> {
  const res = await fetch(
    `${GRAPH}/${igId}/media?fields=id,caption,timestamp,media_type,permalink&limit=${PER_ACCOUNT_LIMIT}&access_token=${token}`
  );
  if (!res.ok) throw new Error(`ig media ${res.status}`);
  const json = (await res.json()) as { data?: Array<Record<string, string>> };
  return (json.data || []).map((m) => ({
    externalId: m.id,
    title: titleFrom(m.caption || "", "Instagram post"),
    caption: m.caption || "",
    postType: m.media_type === "VIDEO" ? "video" : "carousel",
    publishedAt: m.timestamp,
    permalink: m.permalink || null,
  }));
}

async function fbPosts(pageId: string, token: string): Promise<NativeItem[]> {
  const res = await fetch(
    `${GRAPH}/${pageId}/posts?fields=id,message,created_time,permalink_url,attachments{media_type}&limit=${PER_ACCOUNT_LIMIT}&access_token=${token}`
  );
  if (!res.ok) throw new Error(`fb posts ${res.status}`);
  const json = (await res.json()) as {
    data?: Array<{ id: string; message?: string; created_time: string; permalink_url?: string; attachments?: { data?: Array<{ media_type?: string }> } }>;
  };
  return (json.data || []).map((p) => ({
    externalId: p.id,
    title: titleFrom(p.message || "", "Facebook post"),
    caption: p.message || "",
    postType: p.attachments?.data?.[0]?.media_type === "video" ? "video" : "carousel",
    publishedAt: p.created_time,
    permalink: p.permalink_url || null,
  }));
}
