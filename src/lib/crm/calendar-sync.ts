/**
 * External calendar sync — pulls busy times from .ics feeds into
 * booking_blackouts so the public booking pages can't offer a slot she's
 * already committed to.
 *
 * Runs on the engine tick. Feed rows own their blackouts (source='feed'),
 * so a re-sync replaces its own rows and never touches manual ones.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { parseIcs } from "./ics";

type AdminClient = SupabaseClient<Database>;

/** How far ahead we mirror. Matches the longest booking window. */
const WINDOW_DAYS = 90;

/**
 * Safety margin on every imported event. A private .ics is regenerated on
 * the provider's schedule, not instantly, so a freshly-accepted meeting can
 * be invisible for a while. Padding the busy block absorbs some of that —
 * it costs a little availability and buys not double-booking her.
 */
const PAD_MINUTES = 15;

export type FeedSyncResult = {
  feed: string;
  status: "ok" | "error";
  events?: number;
  error?: string;
};

export async function syncCalendarFeeds(supabase: AdminClient): Promise<FeedSyncResult[]> {
  const { data: feeds } = await supabase
    .from("calendar_feeds")
    .select("*")
    .eq("is_active", true);

  if (!feeds?.length) return [];

  const results: FeedSyncResult[] = [];
  for (const feed of feeds) {
    results.push(await syncOne(supabase, feed));
  }
  return results;
}

async function syncOne(
  supabase: AdminClient,
  feed: Database["public"]["Tables"]["calendar_feeds"]["Row"]
): Promise<FeedSyncResult> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + WINDOW_DAYS * 86400000);

  try {
    const res = await fetch(feed.ics_url, {
      headers: { Accept: "text/calendar,text/plain,*/*" },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`feed responded ${res.status}`);

    const body = await res.text();
    if (!body.includes("BEGIN:VCALENDAR")) {
      throw new Error("not an iCalendar feed (no BEGIN:VCALENDAR)");
    }

    const events = parseIcs(body, now, windowEnd).filter(
      (e) => !(feed.busy_only && e.transparent)
    );

    // A modified instance (RECURRENCE-ID) can land on the same uid::start as
    // the series expansion of that instant, so the same external_uid appears
    // twice in one batch. Last write wins — the override is the truer row.
    const deduped = Array.from(
      new Map(events.map((e) => [e.uid.slice(0, 500), e])).values()
    );

    const rows = deduped.map((e) => ({
      feed_id: feed.id,
      external_uid: e.uid.slice(0, 500),
      source: "feed",
      event_type_id: null, // blocks every event type
      starts_at: new Date(e.start.getTime() - PAD_MINUTES * 60000).toISOString(),
      ends_at: new Date(e.end.getTime() + PAD_MINUTES * 60000).toISOString(),
      reason: e.summary ? `${feed.name}: ${e.summary}` : feed.name,
    }));

    // Replace this feed's window wholesale — deletions upstream (a cancelled
    // meeting) must free the slot again, which a pure upsert wouldn't do.
    await supabase
      .from("booking_blackouts")
      .delete()
      .eq("feed_id", feed.id)
      .gte("ends_at", now.toISOString());

    if (rows.length) {
      // Plain insert, not upsert: the delete above already cleared this
      // feed's window, and ON CONFLICT can't target a partial unique index.
      // Chunked — a busy calendar exceeds a single insert comfortably.
      for (let i = 0; i < rows.length; i += 200) {
        const { error } = await supabase
          .from("booking_blackouts")
          .insert(rows.slice(i, i + 200));
        if (error) throw new Error(error.message);
      }
    }

    await supabase
      .from("calendar_feeds")
      .update({
        last_synced_at: now.toISOString(),
        last_status: "ok",
        last_error: null,
        last_event_count: rows.length,
        updated_at: now.toISOString(),
      })
      .eq("id", feed.id);

    return { feed: feed.name, status: "ok", events: rows.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : "sync failed";
    // Leave existing blackouts in place on failure — stale busy is safer
    // than suddenly-open.
    await supabase
      .from("calendar_feeds")
      .update({
        last_synced_at: now.toISOString(),
        last_status: "error",
        last_error: message,
        updated_at: now.toISOString(),
      })
      .eq("id", feed.id);
    return { feed: feed.name, status: "error", error: message };
  }
}
