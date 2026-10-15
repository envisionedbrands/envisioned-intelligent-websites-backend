/**
 * Substack Notes — the two operations the rest of the app calls:
 *
 *  scheduleSubstackNote  turns approved words into a scheduled Note. Callers
 *                        are the gate: the owner's logged-in session
 *                        (/api/social/substack/schedule) or an approved
 *                        `social_post` action (agent/actions.ts). Never call it
 *                        from an API-key path — that would let an agent publish
 *                        under her name without her yes.
 *  substackNoteStats     ranks recent Notes by what they actually did,
 *                        subscribers first (WriteStack's headline number).
 */
import type { AdminClient } from "@/lib/crm/types";

/** Substack has no published cap; this keeps a runaway draft from posting. */
const MAX_NOTE_CHARS = 5000;
/** A time this far in the past is a mistake, not "post now". */
const PAST_TOLERANCE_MS = 10 * 60 * 1000;
const MAX_AHEAD_MS = 365 * 86_400_000;

export class ScheduleError extends Error {}

/** The derivative's full Note: body (which already opens with the hook) + CTA. */
export function derivativeNoteText(d: { body: string; cta: string | null }): string {
  const body = d.body.trim();
  const cta = (d.cta || "").trim();
  if (!cta || body.includes(cta)) return body;
  return `${body}\n\n${cta}`;
}

export async function scheduleSubstackNote(
  supabase: AdminClient,
  input: { derivativeId?: string | null; text?: string | null; scheduledAt: string; createdBy: string }
): Promise<{ postId: string; scheduledAt: string; handle: string | null; text: string }> {
  const when = new Date(input.scheduledAt);
  if (Number.isNaN(when.getTime())) throw new ScheduleError("scheduled_at is not a valid date/time");
  const now = Date.now();
  if (when.getTime() < now - PAST_TOLERANCE_MS) throw new ScheduleError("That time has already passed");
  if (when.getTime() > now + MAX_AHEAD_MS) throw new ScheduleError("Schedule within the next year");
  const scheduledAt = new Date(Math.max(when.getTime(), now)).toISOString();

  const { data: accounts } = await supabase
    .from("social_accounts")
    .select("id, username, status")
    .eq("platform", "substack");
  const account = (accounts || []).find((a) => a.status === "active");
  if (!account) {
    throw new ScheduleError(
      (accounts || []).length
        ? "Substack is connected but its login has stopped working — reconnect it on the Accounts page"
        : "Connect Substack on the Accounts page first"
    );
  }

  let text = (input.text || "").trim();
  let derivativeId: string | null = null;
  if (input.derivativeId) {
    const { data: d } = await supabase
      .from("content_derivatives")
      .select("id, kind, body, cta, status")
      .eq("id", input.derivativeId)
      .maybeSingle();
    if (!d) throw new ScheduleError("Draft not found");
    if (d.kind !== "substack_note") throw new ScheduleError("Only Substack note drafts can be scheduled as Notes");
    if (d.status === "published") throw new ScheduleError("This draft has already been published");
    if (d.status === "archived") throw new ScheduleError("This draft is archived");
    const { data: live } = await supabase
      .from("social_posts")
      .select("id, status")
      .eq("source_derivative_id", d.id)
      .not("status", "in", "(canceled,failed)");
    if (live?.length) throw new ScheduleError("This draft is already scheduled");
    derivativeId = d.id;
    if (!text) text = derivativeNoteText(d);
  }
  if (!text) throw new ScheduleError("Nothing to post — the Note is empty");
  if (text.length > MAX_NOTE_CHARS) throw new ScheduleError(`A Note this long (${text.length} characters) is almost certainly a mistake`);

  const { data: post, error: postError } = await supabase
    .from("social_posts")
    .insert({
      title: text.split("\n")[0].slice(0, 80),
      caption: text,
      post_type: "text",
      status: "scheduled",
      scheduled_at: scheduledAt,
      created_by: input.createdBy,
      source_derivative_id: derivativeId,
    })
    .select("id")
    .single();
  if (postError || !post) throw new Error(`Could not create the Note: ${postError?.message}`);

  const { error: targetError } = await supabase.from("social_post_targets").insert({
    post_id: post.id,
    account_id: account.id,
    platform: "substack",
    status: "pending",
  });
  if (targetError) {
    await supabase.from("social_posts").delete().eq("id", post.id);
    throw new Error(`Could not attach Substack to the Note: ${targetError.message}`);
  }

  if (derivativeId) {
    await supabase
      .from("content_derivatives")
      .update({ status: "scheduled", scheduled_for: scheduledAt, updated_at: new Date().toISOString() })
      .eq("id", derivativeId);
  }

  return { postId: post.id, scheduledAt, handle: account.username, text };
}

export interface NoteStatRow {
  post_id: string;
  external_id: string;
  url: string | null;
  published_at: string | null;
  excerpt: string;
  impressions: number;
  reach: number;
  likes: number;
  replies: number;
  restacks: number;
  link_clicks: number;
  new_free_subscribers: number;
  new_paid_subscribers: number;
  captured_at: string | null;
  sent_from: "crm" | "substack app";
}

/** Recent Notes with their latest snapshot, best subscriber drivers first. */
export async function substackNoteStats(
  supabase: AdminClient,
  opts: { days?: number; limit?: number } = {}
): Promise<{ notes: NoteStatRow[]; totals: Record<string, number>; days: number }> {
  const days = Math.min(365, Math.max(1, opts.days || 30));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data: targets, error } = await supabase
    .from("social_post_targets")
    .select("id, post_id, external_id, external_url, published_at, post:social_posts(caption, created_by)")
    .eq("platform", "substack")
    .eq("status", "published")
    .gte("published_at", since)
    .order("published_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  if (!targets?.length) return { notes: [], totals: {}, days };

  const { data: snaps } = await supabase
    .from("social_metrics")
    .select("target_id, captured_at, views, likes, comments, reach, raw")
    .in("target_id", targets.map((t) => t.id))
    .order("captured_at", { ascending: false });
  const latest = new Map<string, NonNullable<typeof snaps>[number]>();
  for (const s of snaps || []) if (!latest.has(s.target_id)) latest.set(s.target_id, s);

  const rows: NoteStatRow[] = targets.map((t) => {
    const s = latest.get(t.id);
    const raw = (s?.raw || {}) as Record<string, number>;
    const post = t.post as unknown as { caption: string; created_by: string } | null;
    return {
      post_id: t.post_id,
      external_id: t.external_id || "",
      url: t.external_url,
      published_at: t.published_at,
      excerpt: (post?.caption || "").replace(/\s+/g, " ").slice(0, 140),
      impressions: Number(s?.views) || 0,
      reach: Number(s?.reach) || 0,
      likes: Number(s?.likes) || 0,
      replies: Number(s?.comments) || 0,
      restacks: Number(raw.restacks) || 0,
      link_clicks: Number(raw.link_clicks) || 0,
      new_free_subscribers: Number(raw.new_free_subscribers) || 0,
      new_paid_subscribers: Number(raw.new_paid_subscribers) || 0,
      captured_at: s?.captured_at || null,
      sent_from: post?.created_by === "native-import" ? "substack app" : "crm",
    };
  });

  rows.sort(
    (a, b) =>
      b.new_paid_subscribers - a.new_paid_subscribers ||
      b.new_free_subscribers - a.new_free_subscribers ||
      b.impressions - a.impressions
  );

  const totals = rows.reduce(
    (acc, r) => {
      acc.notes++;
      acc.impressions += r.impressions;
      acc.link_clicks += r.link_clicks;
      acc.new_free_subscribers += r.new_free_subscribers;
      acc.new_paid_subscribers += r.new_paid_subscribers;
      return acc;
    },
    { notes: 0, impressions: 0, link_clicks: 0, new_free_subscribers: 0, new_paid_subscribers: 0 }
  );

  return { notes: rows.slice(0, Math.min(200, opts.limit || 50)), totals, days };
}
