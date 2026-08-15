/**
 * DM funnel runner — the state machine behind "comment MAP and I'll send it".
 *
 * The shape of a run:
 *
 *   comment matches keyword
 *        ├─ public reply under the comment          (optional, visible)
 *        └─ PRIVATE REPLY opens the thread          (one shot, 7-day window)
 *                        ↓  they answer  →  24-hour window opens
 *   require_follow? ──no──┐
 *        │ yes            │
 *        ├ not following ─→ ask them to follow, re-check on their next message
 *        └ following ─────┤
 *                         ↓
 *   ask_email? ──yes──→ ask for it → parse it out of whatever they typed
 *                         ↓
 *   DELIVER: link in the DM + the thing to their inbox + lead in the CRM,
 *   tagged, enrolled, indistinguishable from any other capture downstream.
 *
 * Safe mode (the same flag that governs email) suppresses every outbound call
 * and writes the transcript as `simulated`. That is what lets the whole funnel
 * be rehearsed against a real Instagram account before a single DM leaves.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCrmSettings } from "@/lib/crm/settings";
import { upsertLead } from "@/lib/crm/leads";
import { sendCrmEmail } from "@/lib/crm/email";
import { enrollLead } from "@/lib/crm/engine";
import { logActivity } from "@/lib/crm/activity";
import type { AdminClient } from "@/lib/crm/types";
import {
  extractEmail,
  getDmUserProfile,
  isWindowOpen,
  matchesKeyword,
  MetaSendError,
  renderDmCopy,
  replyToComment,
  sendDm,
  sendPrivateReply,
  windowExpiresAt,
} from "./messaging";

/**
 * The DM tables arrived in migration 300. `src/types/database.ts` is shared
 * verbatim with the frontend repo and regenerated rather than hand-edited, so
 * rather than scatter `as any` across every query, the untyping happens once,
 * here, with the row shapes declared below.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DmClient = SupabaseClient<any, "public", any>;
function dm(supabase: AdminClient): DmClient {
  return supabase as unknown as DmClient;
}

export interface DmFunnel {
  id: string;
  name: string;
  keyword: string;
  status: "draft" | "active" | "paused";
  account_id: string | null;
  trigger_source: "comment" | "dm" | "both";
  media_id: string | null;
  public_comment_reply: string | null;
  /** The private reply to a comment. Comment path only — see `welcome_dm`. */
  opening_dm: string;
  /** The cold-DM hello. Null = go straight to the first gate. */
  welcome_dm: string | null;
  follow_prompt_dm: string | null;
  email_prompt_dm: string | null;
  delivery_dm: string;
  already_done_dm: string | null;
  require_follow: boolean;
  ask_email: boolean;
  skip_email_if_known: boolean;
  delivery_link: string | null;
  tags: string[];
  email_template_id: string | null;
  enroll_workflow_id: string | null;
}

export interface DmSubscriber {
  id: string;
  igsid: string;
  username: string | null;
  name: string | null;
  is_follower: boolean | null;
  lead_id: string | null;
  last_inbound_at: string | null;
}

export interface DmRun {
  id: string;
  funnel_id: string;
  subscriber_id: string;
  state: "opened" | "awaiting_follow" | "awaiting_email" | "delivered" | "expired" | "failed";
  private_reply_used: boolean;
  email_captured: string | null;
}

interface Account {
  id: string;
  external_id: string;
  access_token: string;
}

export interface DmEventResult {
  handled: boolean;
  funnel?: string;
  state?: string;
  note?: string;
}

// ── Account ─────────────────────────────────────────────────────────────────

/**
 * The account this layer sends as.
 *
 * `dm_access_token` only — deliberately NOT falling back to `access_token`.
 * That column holds the Facebook Page token used for publishing, and messaging
 * now speaks to graph.instagram.com, where a Page token is not merely
 * insufficient but wrong. A fallback would turn "you never connected Instagram
 * for DMs" into a stream of opaque 190s from the wrong host, which is the
 * expensive kind of bug. Absent token → null → the caller reports the account
 * as unconnected, which is the truth.
 */
async function getAccount(supabase: AdminClient, accountId?: string | null): Promise<Account | null> {
  let q = dm(supabase)
    .from("social_accounts")
    .select("id, external_id, dm_access_token")
    .eq("platform", "instagram")
    .eq("status", "active");
  if (accountId) q = q.eq("id", accountId);
  const { data } = await q.limit(1).maybeSingle();
  const token = (data as { dm_access_token?: string | null } | null)?.dm_access_token;
  if (!data || !token) return null;
  return { ...(data as object), access_token: token } as Account;
}

// ── Outbound, with safe mode and the transcript ─────────────────────────────

type SendMethod = "send_api" | "private_reply" | "comment_reply";

async function recordMessage(
  supabase: AdminClient,
  row: {
    subscriber_id: string;
    run_id?: string | null;
    direction: "inbound" | "outbound";
    body?: string | null;
    external_id?: string | null;
    method?: SendMethod | null;
    simulated?: boolean;
    error?: string | null;
  }
) {
  await dm(supabase).from("dm_messages").insert(row);
}

/**
 * Every outbound message funnels through here so safe mode, the transcript and
 * error capture can never be forgotten at a call site.
 *
 * Returns false when the send did not reach Instagram — the caller decides
 * whether that ends the run. A shut window is not an error worth shouting
 * about; it is the single most common way a funnel ends.
 */
async function send(
  supabase: AdminClient,
  account: Account,
  subscriber: DmSubscriber,
  text: string,
  opts: { runId?: string; method?: SendMethod; commentId?: string; safeMode: boolean }
): Promise<boolean> {
  const method = opts.method ?? "send_api";

  if (opts.safeMode) {
    await recordMessage(supabase, {
      subscriber_id: subscriber.id,
      run_id: opts.runId ?? null,
      direction: "outbound",
      body: text,
      method,
      simulated: true,
    });
    return true;
  }

  try {
    let messageId: string | undefined;
    if (method === "private_reply" && opts.commentId) {
      ({ messageId } = await sendPrivateReply(account.external_id, account.access_token, opts.commentId, text));
    } else if (method === "comment_reply" && opts.commentId) {
      const res = await replyToComment(opts.commentId, account.access_token, text);
      messageId = res.id;
    } else {
      ({ messageId } = await sendDm(account.external_id, account.access_token, subscriber.igsid, text));
    }
    await recordMessage(supabase, {
      subscriber_id: subscriber.id,
      run_id: opts.runId ?? null,
      direction: "outbound",
      body: text,
      external_id: messageId ?? null,
      method,
    });
    return true;
  } catch (err) {
    const e = err as MetaSendError;
    await recordMessage(supabase, {
      subscriber_id: subscriber.id,
      run_id: opts.runId ?? null,
      direction: "outbound",
      body: text,
      method,
      error: e.message,
    });
    if (opts.runId) {
      await dm(supabase)
        .from("dm_funnel_runs")
        .update({
          last_error: e.message,
          // A closed window is a natural ending, not a fault to be retried.
          ...(e.code === 10 ? { state: "expired" } : {}),
        })
        .eq("id", opts.runId);
    }
    return false;
  }
}

// ── Subscriber + run bookkeeping ────────────────────────────────────────────

async function upsertSubscriber(
  supabase: AdminClient,
  igsid: string,
  patch: Partial<DmSubscriber> & { platform?: string } = {}
): Promise<DmSubscriber> {
  const { data: existing } = await dm(supabase)
    .from("dm_subscribers")
    .select("*")
    .eq("platform", patch.platform ?? "instagram")
    .eq("igsid", igsid)
    .maybeSingle();

  if (existing) {
    const { data: updated } = await dm(supabase)
      .from("dm_subscribers")
      .update({
        // Never overwrite a known value with a blank — webhooks arrive with
        // partial payloads depending on the event type.
        username: patch.username ?? existing.username,
        name: patch.name ?? existing.name,
        is_follower: patch.is_follower ?? existing.is_follower,
        last_inbound_at: patch.last_inbound_at ?? existing.last_inbound_at,
        lead_id: patch.lead_id ?? existing.lead_id,
      })
      .eq("id", existing.id)
      .select("*")
      .single();
    return (updated ?? existing) as DmSubscriber;
  }

  const { data: inserted, error } = await dm(supabase)
    .from("dm_subscribers")
    .insert({ platform: patch.platform ?? "instagram", igsid, ...patch })
    .select("*")
    .single();
  if (error || !inserted) throw new Error(`dm_subscriber insert failed: ${error?.message}`);
  return inserted as DmSubscriber;
}

async function findFunnelByKeyword(
  supabase: AdminClient,
  text: string,
  source: "comment" | "dm",
  mediaId?: string | null
): Promise<DmFunnel | null> {
  const { data } = await dm(supabase).from("dm_funnels").select("*").eq("status", "active");
  const funnels = (data ?? []) as DmFunnel[];
  return (
    funnels.find(
      (f) =>
        (f.trigger_source === "both" || f.trigger_source === source) &&
        (!f.media_id || f.media_id === mediaId) &&
        matchesKeyword(text, f.keyword)
    ) ?? null
  );
}

async function getOrCreateRun(
  supabase: AdminClient,
  funnel: DmFunnel,
  subscriber: DmSubscriber,
  source: "comment" | "dm",
  extra: { comment_id?: string; media_id?: string | null } = {}
): Promise<{ run: DmRun; created: boolean }> {
  const { data: existing } = await dm(supabase)
    .from("dm_funnel_runs")
    .select("*")
    .eq("funnel_id", funnel.id)
    .eq("subscriber_id", subscriber.id)
    .maybeSingle();
  if (existing) return { run: existing as DmRun, created: false };

  const { data: inserted, error } = await dm(supabase)
    .from("dm_funnel_runs")
    .insert({
      funnel_id: funnel.id,
      subscriber_id: subscriber.id,
      trigger_source: source,
      comment_id: extra.comment_id ?? null,
      media_id: extra.media_id ?? null,
      state: "opened",
    })
    .select("*")
    .single();
  if (error || !inserted) throw new Error(`dm_funnel_run insert failed: ${error?.message}`);

  await bumpStat(supabase, funnel.id, "stat_triggered");
  return { run: inserted as DmRun, created: true };
}

async function bumpStat(supabase: AdminClient, funnelId: string, column: string) {
  const { data } = await dm(supabase).from("dm_funnels").select(column).eq("id", funnelId).maybeSingle();
  const current = (data as Record<string, number> | null)?.[column] ?? 0;
  await dm(supabase)
    .from("dm_funnels")
    .update({ [column]: current + 1 })
    .eq("id", funnelId);
}

async function setState(supabase: AdminClient, runId: string, patch: Record<string, unknown>) {
  await dm(supabase).from("dm_funnel_runs").update(patch).eq("id", runId);
}

// ── Recognition ─────────────────────────────────────────────────────────────

export interface RecognisedLead {
  email: string;
  firstName: string | null;
  /** How we knew them — surfaced in the run log so a wrong match is traceable. */
  via: "subscriber_link" | "instagram_username";
}

/**
 * "Do we already have this person?" — asked before we ask them for an email.
 *
 * Two signals, most-certain first:
 *   1. dm_subscribers.lead_id — this exact Instagram-scoped ID finished a funnel
 *      before and handed over an address. Effectively certain.
 *   2. An exact match on leads.custom->>instagram_username, which deliver()
 *      writes on every capture. Catches a subscriber row that lost its link,
 *      and any handle recorded on a lead by hand.
 *
 * Deliberately NOT matched on name. Two people called Sarah would silently
 * receive each other's lead record, and a wrong match here means emailing an
 * asset to a stranger — far worse than one redundant question.
 *
 * Only 'subscribed' leads count — the same rule sendCrmEmail suppresses on.
 * Someone who unsubscribed, bounced or complained is asked afresh rather than
 * quietly re-served from a record they asked us to stop using.
 */
async function recogniseLead(
  supabase: AdminClient,
  subscriber: DmSubscriber
): Promise<RecognisedLead | null> {
  const usable = (lead: { email: string | null; email_status: string | null }) =>
    Boolean(lead.email) && lead.email_status === "subscribed";

  if (subscriber.lead_id) {
    const { data } = await supabase
      .from("leads")
      .select("email, first_name, email_status")
      .eq("id", subscriber.lead_id)
      .maybeSingle();
    if (data && usable(data)) {
      return { email: data.email as string, firstName: data.first_name, via: "subscriber_link" };
    }
  }

  if (subscriber.username) {
    const { data } = await supabase
      .from("leads")
      .select("email, first_name, email_status")
      .eq("custom->>instagram_username", subscriber.username.toLowerCase())
      .maybeSingle();
    if (data && usable(data)) {
      return { email: data.email as string, firstName: data.first_name, via: "instagram_username" };
    }
  }

  return null;
}

// ── Delivery ────────────────────────────────────────────────────────────────

/**
 * The payoff. Creates/updates the lead, tags it, sends the link in the DM,
 * emails the thing, and enrolls them in the follow-up workflow.
 *
 * Order matters: the CRM record is written FIRST. If Instagram then refuses
 * the DM, she still has the lead and the email still goes — losing the contact
 * because a message failed would be the expensive failure.
 */
async function deliver(
  supabase: AdminClient,
  account: Account,
  funnel: DmFunnel,
  subscriber: DmSubscriber,
  run: DmRun,
  email: string | null,
  opts: {
    safeMode: boolean;
    recognisedVia?: RecognisedLead["via"];
    /**
     * How to send the delivery message. Defaults to a normal DM, which needs an
     * open 24-hour window. Delivering straight off a comment has no such window
     * — nobody has messaged us yet — so that path must go out as the private
     * reply instead.
     */
    sendAs?: { method: SendMethod; commentId: string };
  }
): Promise<void> {
  const safeMode = opts.safeMode;
  const recognised = Boolean(opts.recognisedVia);
  let leadId = subscriber.lead_id;

  if (email) {
    const { lead } = await upsertLead(
      supabase,
      {
        email,
        name: subscriber.name || subscriber.username || null,
        source: `instagram-dm:${funnel.keyword.toLowerCase()}`,
        form: `dm-funnel:${funnel.keyword.toLowerCase()}`,
        tags: funnel.tags,
        custom: {
          // Lowercased because this is what recogniseLead() matches on next
          // time — a handle stored with different casing is a handle we fail
          // to recognise.
          instagram_username: subscriber.username?.toLowerCase() ?? null,
          dm_funnel: funnel.name,
        },
      },
      { actor: "dm-funnel" }
    );
    leadId = lead.id;
    await upsertSubscriber(supabase, subscriber.igsid, { lead_id: lead.id });
    // A returning person is not a new capture. Counting them as one would
    // inflate the number she'd use to judge whether the funnel works.
    await bumpStat(supabase, funnel.id, recognised ? "stat_recognised" : "stat_emails_captured");

    await logActivity(supabase, {
      lead_id: lead.id,
      activity_type: "note",
      title: `Instagram DM funnel: ${funnel.name}`,
      body: recognised
        ? `Asked for "${funnel.keyword}"${
            subscriber.username ? ` from @${subscriber.username}` : ""
          } — already on file, so we didn't ask for their email again.`
        : `Captured via keyword "${funnel.keyword}"${
            subscriber.username ? ` from @${subscriber.username}` : ""
          }.`,
      data: {
        funnel_id: funnel.id,
        run_id: run.id,
        recognised_via: opts.recognisedVia ?? null,
      },
      actor: "dm-funnel",
    });

    // The asset, to their inbox. This is the half ManyChat cannot do, because
    // it does not own the mailing list.
    if (funnel.email_template_id) {
      const { data: tpl } = await supabase
        .from("email_templates")
        .select("*")
        .eq("id", funnel.email_template_id)
        .maybeSingle();
      if (tpl) {
        await sendCrmEmail(supabase, {
          lead,
          subject: tpl.subject,
          bodyMd: tpl.body_md,
          preheader: tpl.preheader,
          templateId: tpl.id,
          actor: "dm-funnel",
        });
      }
    }

    if (funnel.enroll_workflow_id) {
      const { data: wf } = await supabase
        .from("workflows")
        .select("*")
        .eq("id", funnel.enroll_workflow_id)
        .maybeSingle();
      if (wf) await enrollLead(supabase, wf, lead, `dm-funnel:${funnel.keyword}`);
    }
  }

  const copy = renderDmCopy(funnel.delivery_dm, {
    first_name: subscriber.name?.split(/\s+/)[0] || null,
    username: subscriber.username,
    keyword: funnel.keyword,
    link: funnel.delivery_link,
    email,
  });
  await send(supabase, account, subscriber, copy, {
    runId: run.id,
    safeMode,
    method: opts.sendAs?.method,
    commentId: opts.sendAs?.commentId,
  });

  await setState(supabase, run.id, {
    state: "delivered",
    email_captured: email,
    delivered_at: new Date().toISOString(),
    ...(opts.sendAs?.method === "private_reply" ? { private_reply_used: true } : {}),
  });
  await bumpStat(supabase, funnel.id, "stat_delivered");
  void leadId;
}

// ── Entry point: a comment arrived ──────────────────────────────────────────

export async function handleComment(
  supabase: AdminClient,
  event: { commentId: string; mediaId?: string | null; text: string; fromId: string; username?: string }
): Promise<DmEventResult> {
  const funnel = await findFunnelByKeyword(supabase, event.text, "comment", event.mediaId);
  if (!funnel) return { handled: false, note: "no active funnel matched" };

  const account = await getAccount(supabase, funnel.account_id);
  if (!account) return { handled: false, note: "no active instagram account" };

  // Never answer ourselves. Her own replies under her own posts contain the
  // keyword constantly.
  if (event.fromId === account.external_id) return { handled: false, note: "own comment" };

  const cfg = await getCrmSettings(supabase);
  const subscriber = await upsertSubscriber(supabase, event.fromId, { username: event.username });
  const { run, created } = await getOrCreateRun(supabase, funnel, subscriber, "comment", {
    comment_id: event.commentId,
    media_id: event.mediaId,
  });

  if (!created && run.state === "delivered") {
    // They already have it. Say so only if we can — and only if she wrote copy
    // for it. Silence beats a stray message.
    if (funnel.already_done_dm && isWindowOpen(subscriber.last_inbound_at)) {
      await send(supabase, account, subscriber, renderDmCopy(funnel.already_done_dm, {
        first_name: subscriber.name?.split(/\s+/)[0] || null,
        link: funnel.delivery_link,
      }), { runId: run.id, safeMode: cfg.safe_mode });
    }
    return { handled: true, funnel: funnel.name, state: "delivered", note: "already delivered" };
  }

  if (run.private_reply_used) {
    return { handled: true, funnel: funnel.name, state: run.state, note: "private reply already spent" };
  }

  // The visible half — "sent! check your DMs".
  if (funnel.public_comment_reply) {
    await send(supabase, account, subscriber, renderDmCopy(funnel.public_comment_reply, {
      username: event.username,
      keyword: funnel.keyword,
    }), { runId: run.id, method: "comment_reply", commentId: event.commentId, safeMode: cfg.safe_mode });
  }

  // ── Already ours? Then skip the dance entirely ────────────────────────────
  // If we hold this person's email, the whole ask-and-wait sequence is friction
  // for no gain: the private reply can just BE the delivery.
  //
  // Not attempted when the funnel gates on following. The follow flag can only
  // be read from a profile lookup keyed on a *messaging* IGSID, and a comment's
  // from.id is not guaranteed to be one — so we let them reply first and check
  // properly, rather than skip a gate she asked for.
  if (funnel.ask_email && funnel.skip_email_if_known && !funnel.require_follow) {
    const known = await recogniseLead(supabase, subscriber);
    if (known) {
      await deliver(supabase, account, funnel, subscriber, run, known.email, {
        safeMode: cfg.safe_mode,
        recognisedVia: known.via,
        sendAs: { method: "private_reply", commentId: event.commentId },
      });
      return {
        handled: true,
        funnel: funnel.name,
        state: "delivered",
        note: `recognised via ${known.via} — delivered without asking`,
      };
    }
  }

  // The one shot that opens the thread.
  const opened = await send(
    supabase,
    account,
    subscriber,
    renderDmCopy(funnel.opening_dm, {
      first_name: subscriber.name?.split(/\s+/)[0] || null,
      username: event.username,
      keyword: funnel.keyword,
    }),
    { runId: run.id, method: "private_reply", commentId: event.commentId, safeMode: cfg.safe_mode }
  );

  await setState(supabase, run.id, { private_reply_used: true, state: opened ? "opened" : "failed" });
  return { handled: true, funnel: funnel.name, state: opened ? "opened" : "failed" };
}

// ── Entry point: a DM arrived ───────────────────────────────────────────────

export async function handleMessage(
  supabase: AdminClient,
  event: { igsid: string; text: string; messageId?: string }
): Promise<DmEventResult> {
  const now = new Date().toISOString();
  let subscriber = await upsertSubscriber(supabase, event.igsid, { last_inbound_at: now });

  await recordMessage(supabase, {
    subscriber_id: subscriber.id,
    direction: "inbound",
    body: event.text,
    external_id: event.messageId ?? null,
  });

  // Is there a run mid-flight? That takes priority over keyword matching —
  // someone answering "yes please" is not starting a new funnel.
  const { data: openRuns } = await dm(supabase)
    .from("dm_funnel_runs")
    .select("*")
    .eq("subscriber_id", subscriber.id)
    .in("state", ["opened", "awaiting_follow", "awaiting_email"])
    .order("created_at", { ascending: false })
    .limit(1);

  let run = (openRuns?.[0] ?? null) as DmRun | null;
  let funnel: DmFunnel | null = null;
  // Whether this message is the one that *starts* the run, which is the only
  // moment a welcome belongs. Answering "yes please" must not re-greet them.
  let startsRun = false;

  if (run) {
    const { data } = await dm(supabase).from("dm_funnels").select("*").eq("id", run.funnel_id).maybeSingle();
    funnel = data as DmFunnel | null;
  } else {
    funnel = await findFunnelByKeyword(supabase, event.text, "dm");
    if (!funnel) return { handled: false, note: "no run in flight, no keyword matched" };
    const created = await getOrCreateRun(supabase, funnel, subscriber, "dm");
    run = created.run;
    startsRun = created.created;
  }
  if (!funnel || !run) return { handled: false };

  const account = await getAccount(supabase, funnel.account_id);
  if (!account) return { handled: false, note: "no active instagram account" };

  const cfg = await getCrmSettings(supabase);

  await setState(supabase, run.id, { dm_window_expires_at: windowExpiresAt(now).toISOString() });

  // Refresh who they are — and, critically, whether they follow. This is the
  // only place the follow flag can be read: the profile endpoint needs an IGSID
  // that came from a messaging webhook.
  const profile = await getDmUserProfile(event.igsid, account.access_token);
  if (profile) {
    subscriber = await upsertSubscriber(supabase, event.igsid, {
      name: profile.name ?? null,
      username: profile.username ?? null,
      is_follower: profile.is_user_follow_business ?? null,
    });
    await dm(supabase)
      .from("dm_subscribers")
      .update({ follower_count: profile.follower_count ?? null, follow_checked_at: now })
      .eq("id", subscriber.id);
  }

  const firstName = subscriber.name?.split(/\s+/)[0] || null;
  const vars = {
    first_name: firstName,
    username: subscriber.username,
    keyword: funnel.keyword,
    link: funnel.delivery_link,
  };

  // ── The welcome ───────────────────────────────────────────────────────────
  // A cold DM never touches the comment path, so `opening_dm` — which is a
  // private reply and needs a comment to reply to — never fires. Without this,
  // the first thing a stranger hears from the account is a request for their
  // email address, which reads like a form rather than a person. Sent once, on
  // the message that starts the run, and only when she has written one.
  if (startsRun && funnel.welcome_dm) {
    await send(supabase, account, subscriber, renderDmCopy(funnel.welcome_dm, vars), {
      runId: run.id,
      safeMode: cfg.safe_mode,
    });
  }

  // ── Gate 1: the follow ────────────────────────────────────────────────────
  // Only gates when we actually know they don't follow. An unreadable profile
  // must not lock someone out of the thing they asked for.
  if (funnel.require_follow && subscriber.is_follower === false) {
    if (run.state !== "awaiting_follow" && funnel.follow_prompt_dm) {
      await send(supabase, account, subscriber, renderDmCopy(funnel.follow_prompt_dm, vars), {
        runId: run.id,
        safeMode: cfg.safe_mode,
      });
    }
    await setState(supabase, run.id, { state: "awaiting_follow" });
    return { handled: true, funnel: funnel.name, state: "awaiting_follow" };
  }

  // ── Gate 2: the email ─────────────────────────────────────────────────────
  if (funnel.ask_email) {
    // What they typed always wins. Someone who volunteers an address is either
    // new or correcting the one we hold — either way, believe them over the
    // record.
    const typed = extractEmail(event.text);
    const known = typed || !funnel.skip_email_if_known ? null : await recogniseLead(supabase, subscriber);
    const email = typed || known?.email || null;

    if (!email) {
      if (run.state !== "awaiting_email" && funnel.email_prompt_dm) {
        await send(supabase, account, subscriber, renderDmCopy(funnel.email_prompt_dm, vars), {
          runId: run.id,
          safeMode: cfg.safe_mode,
        });
      }
      await setState(supabase, run.id, { state: "awaiting_email" });
      return { handled: true, funnel: funnel.name, state: "awaiting_email" };
    }

    await deliver(supabase, account, funnel, subscriber, run, email, {
      safeMode: cfg.safe_mode,
      recognisedVia: known?.via,
    });
    return {
      handled: true,
      funnel: funnel.name,
      state: "delivered",
      note: known ? `recognised via ${known.via} — didn't ask for their email` : undefined,
    };
  }

  await deliver(supabase, account, funnel, subscriber, run, null, { safeMode: cfg.safe_mode });
  return { handled: true, funnel: funnel.name, state: "delivered" };
}
