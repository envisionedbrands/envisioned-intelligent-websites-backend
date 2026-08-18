# DM Funnels — the owned ManyChat replacement

Someone comments **MAP** on a reel. They get a private message. They hand over
their email. The link arrives in the DM *and* in their inbox, and the lead lands
in the CRM tagged and enrolled like any other capture.

That whole loop runs on your own infrastructure. One part of ManyChat does not,
and this document is honest about which part and why.

---

## What is owned, and what is not

| Capability | Owned here | Notes |
|---|---|---|
| Comment on a post → open a DM | ✅ | Private Replies. One per comment, 7-day window. |
| DM a keyword → sequence starts | ✅ | Free-form send inside the 24-hour window. |
| Public reply under their comment | ✅ | Optional per funnel. |
| Check whether they follow you, gate on it | ✅ | `is_user_follow_business` on the User Profile API. |
| Collect an email in the DM | ✅ | Parsed out of whatever they type. |
| **Recognise someone already on the list** | ✅ | Don't ask twice. See below — this is the part ManyChat and GoHighLevel don't do. |
| Email the asset + create the CRM lead | ✅ | Reuses `sendCrmEmail` and `upsertLead`. |
| Enroll into a nurture workflow | ✅ | `enroll_workflow_id` on the funnel. |
| **Trigger on a new follower** | ❌ | **Not buildable.** See below. |
| Cold-DM people who never messaged you | ❌ | Nobody can. Platform rule, not a gap. |

### The one real gap: "Follow to DM"

Instagram's `follows` webhook exists in Meta's schema but is **not publicly
subscribable** — it is a private Meta Business Partner beta. ManyChat has it
through a partnership. No amount of App Review, budget, or time gets it for a
first-party app.

So if a "new follower gets a welcome DM" flow is wanted, that is the one thing
worth renting a single ManyChat seat for. Everything else on this page is
better owned: no per-contact pricing, the leads land directly in the CRM
instead of needing a sync, and the copy lives next to the rest of the system.

### The clocks that shape every design decision

* **Private reply** — exactly ONE per comment, within 7 days of that comment.
  This is the only legal way to open a thread with someone who has never
  messaged the account. Spending it twice returns Meta error code 100.
* **24-hour window** — free-form messages only within 24 hours of *their* last
  message. Outside it, sends fail with code 10. There is no automation escape
  hatch; `HUMAN_AGENT` (7 days) is for a human answering an inquiry, and using
  it for automation is a policy violation, not a clever workaround.

Both windows are tracked per run, so an expired conversation fails quietly
instead of burning quota on a call Meta will reject anyway.

---

## Setup

### 1. Run the migration

`supabase/migrations/300_dm_funnels.sql` — adds `dm_funnels`, `dm_subscribers`,
`dm_funnel_runs`, `meta_webhook_events`, `dm_messages`, extends the
`conversation_channel` enum, and widens the `agent_actions` type check to
include `dm_funnel`.

### 2. Environment

```
META_APP_ID                 # already set for social publishing
META_APP_SECRET             # the FACEBOOK app secret — OAuth + webhook signing
META_WEBHOOK_VERIFY_TOKEN   # NEW. A long random string you invent.
META_IG_APP_ID              # NEW, REQUIRED. The INSTAGRAM app id (1065768002535262).
META_IG_APP_SECRET          # NOT optional any more. The INSTAGRAM app secret.
                            # Signs dashboard Test payloads AND is the credential
                            # the whole messaging layer now authenticates with.
```

`META_IG_APP_ID` / `META_IG_APP_SECRET` were an optional convenience when this
was written. They are load-bearing now — messaging runs on Instagram Login. See
§6.

**There are two app secrets, and they are not interchangeable.** The Facebook
app (`922625350891031`) and the Instagram app shown on the Instagram-login setup
page (`1065768002535262`) each have their own. Real Instagram deliveries verified
against the Facebook secret in testing; the dashboard's Test button signs with
the Instagram one. Install the second with
`./scripts/set-ig-app-secret.sh`, which reads it from the clipboard so the value
never reaches a terminal or a log. Revealing it in the dashboard requires the
Facebook account password.

`META_WEBHOOK_VERIFY_TOKEN` is not a Meta-issued credential. It is a password
you make up; Meta echoes it back once on the GET handshake to prove you own the
callback URL. `META_APP_SECRET` does the ongoing work — every POST carries an
`x-hub-signature-256` HMAC, and an unsigned payload is the one thing the
webhook refuses outright.

Set it on the Worker (the dashboard does not work for Workers secrets):

```bash
echo "YOUR-RANDOM-STRING" | npx wrangler secret put META_WEBHOOK_VERIFY_TOKEN --name YOUR-WORKER-NAME
```

### 3. Webhook

A Meta app created after the "Use cases" redesign has **no Webhooks nav item** —
`/apps/<id>/webhooks/` redirects to the Dashboard. The form lives at:

**Use cases → Instagram API → API setup with Instagram login → 3. Configure webhooks**

Yes, the *Instagram-login* tab, even though this backend authenticates via
Facebook Login for Business. The Facebook-login tab only carries a "Learn more"
link.

* **Callback URL:** `https://app.envisioned.me/api/webhooks/meta`
* **Verify token:** the value of `META_WEBHOOK_VERIFY_TOKEN`
* **Fields:** `messages`, `comments`

The Webhook Fields table only appears *after* the callback URL saves — Meta
enforces the ordering, so an empty-looking fields section before saving is not a
fault.

#### Two traps in Meta's own "Test" button

Each field row has a **Test → Send to server** button. It is useful, but it lied
twice here and cost most of a day, so read this before trusting it.

1. **It signs with the wrong secret.** That page also issues an **Instagram app
   ID and Instagram app secret**, separate from the Facebook app's. The test
   payload is signed with the *Instagram* secret, so a handler verifying against
   `META_APP_SECRET` returns 401 and the dashboard still reports success. The
   route now accepts either secret (`META_IG_APP_SECRET` is optional) and logs
   `signer` so you can see which one arrived.
2. **It sends the wrong shape.** The test emits
   `entry[].changes[]` with `field="messages"`, whereas a real Instagram DM
   arrives as `entry[].messaging[]`. The route now folds the first into the
   second, so the button is a genuine end-to-end check rather than a
   false negative.

**Verifying by hand beats both.** Sign a payload with a secret you already hold
and POST it — this exercises parse, dedupe, subscriber upsert and funnel
matching without involving Meta at all:

```bash
node -e '
const {createHmac}=require("crypto"); const s=process.env.META_APP_SECRET;
const b=JSON.stringify({object:"instagram",entry:[{id:"<IG_USER_ID>",time:0,
  messaging:[{sender:{id:"TEST1"},recipient:{id:"<IG_USER_ID>"},timestamp:0,
  message:{mid:"TESTMID1",text:"your keyword"}}]}]});
fetch("https://app.envisioned.me/api/webhooks/meta",{method:"POST",
  headers:{"content-type":"application/json",
  "x-hub-signature-256":"sha256="+createHmac("sha256",s).update(b).digest("hex")},
  body:b}).then(r=>r.text()).then(console.log)'
```

A healthy response is `{"ok":true,"results":[{...}]}`. An empty `results` array
means the payload matched no branch — that is a silent drop, and
`wrangler tail` will show `delivery matched no handler`.

**Read `wrangler tail` before reading the tables.** A rejected signature and a
webhook Meta never sent look identical from Supabase; they look nothing alike in
the log.

⚠️ That section carries Meta's notice *"To receive webhooks, your app must be in
published state."* **Settled 2026-08-15: it is literal.** A Development-Mode app
receives no Instagram webhooks at all — not for testers, not for admins, not for
the owner — while API *calls* work fine. See §5.

### 4. Permissions — four layers that must agree

> **Read §6 first.** This section describes the *Facebook Login for Business*
> path. Layer 4 turned out to be a permanent dead end for messaging, and the
> messaging layer now runs on Instagram Login instead. Layers 1–3 still describe
> how publishing is authorized, which is why this section stays.

This is the step that silently half-works. Adding a permission to the app does
**not** add it to any token.

| Layer | Where | What it does |
|---|---|---|
| 1. App has it | Use cases → **the right use case** → Permissions | Makes it *available* to request |
| 2. Config requests it | Facebook Login for Business → Configurations → Edit → Permissions | Puts it in the OAuth dialog |
| 3. Token carries it | Reconnect the account at `/social/accounts` | Mints a token with those scopes |
| 4. Page is subscribed | `POST /{page-id}/subscribed_apps` | Routes that Page's events to us — **currently blocked, see below** |

**Layer 1 spans more than one use case.** This app has two: *Manage messaging &
content on Instagram* and *Manage everything on your Page*. `instagram_*` lives
in the first; `pages_manage_metadata` lives only in the second. A permission
missing from the login-config dropdown usually means it hasn't been added to
*its own* use case yet — not that it's unavailable.

**Layer 4 is a separate call, not a setting.** The dashboard's callback URL and
field list declare *what* we want; `subscribed_apps` declares *whose* activity
we get. `metaSubscribePageWebhooks()` runs automatically in the OAuth callback
for every Page with a linked IG account, and the result is written to the
Instagram row's `metadata.webhooks_subscribed`. Check it there rather than
guessing.

**Layer 4 currently fails, and that may be fine.** Two dead ends, both measured
against the live Graph API rather than inferred from docs:

* On the **Page** object, subscribing any `messages*` field returns
  `(#200) … one of these permissions is needed: pages_messaging`. That
  permission is in **neither** of this app's two use cases — the Pages API use
  case lists 15 permissions and `pages_messaging` is not among them. It belongs
  to a Messenger use case that would have to be added, dragging Messenger into
  App Review for a product we do not sell.
* On the **Instagram** object, `POST /{ig-user-id}/subscribed_apps` returns
  `(#3) Application does not have the capability to make this API call` — that
  edge is reserved for apps using *Instagram Login*, and this app uses *Facebook
  Login for Business*.

**But layer 4 was never the reason nothing arrived.** For most of the debugging
window every delivery that *did* reach us was being rejected by our own signature
check, which looks — from the tables — exactly like nothing arriving. The receive
path was then proved end to end by signing a payload locally with the Facebook app
secret and POSTing it to production: 200, event claimed, subscriber row created,
inbound message stored. Nothing in the handler was broken. See §3.

Read the tail, not the table — a rejected signature never reaches
`meta_webhook_events`, so an empty table cannot distinguish a rejected delivery
from no delivery at all. Every diagnosis below came from `npx wrangler tail`.

Facebook Login for Business uses `config_id`, not `scope` — the dialog asks for
whatever the saved **login configuration** lists, and nothing else. And a token's
scopes are frozen at mint time: adding a permission later never upgrades an
issued token. So layer 3 is always a **disconnect and reconnect**, and it must
happen *after* layer 2, or it re-mints the identical old token.

Check what a stored token actually carries:

```bash
curl -s "https://graph.facebook.com/v21.0/debug_token?input_token=<TOKEN>&access_token=<APP_ID>|<APP_SECRET>"
```

The `scopes` array in the response is the only authoritative answer.

Permissions to request at review:

| Permission | What it buys |
|---|---|
| `instagram_basic` | Account identity |
| `instagram_manage_messages` | Send and receive DMs, private replies |
| `instagram_manage_comments` | Read comments, post public replies |
| `pages_read_engagement` | Read the Page/IG connection |
| `pages_manage_metadata` | Subscribe the Page to the webhook (layer 4) |

`pages_messaging` is **not requestable here** — it appears in neither use case,
so it cannot go in the login config and cannot reach a token. It is required for
the layer-4 Page subscription and for nothing else we do. **Do not add the
Messenger use case** — see §5; zero deliveries were fully explained by app mode,
and `pages_messaging` explains nothing here.

Sending, receiving and every API call above works in **development mode** for
accounts with a role on the app. Webhooks do not — see §5. That asymmetry is the
single most confusing thing about this platform, and it cost most of a day.

Each one needs a written use case and a screencast. The use case is the same
story told five ways — write it once:

> Our business account posts educational content. When a follower comments an
> agreed keyword on a post, we send them a private reply containing the
> resource they asked for, ask for an email address so we can also deliver it
> to their inbox, and record them in our own CRM. Every message is a direct
> response to an action the person took. We never message anyone who has not
> contacted us first.

The screencast must show, on screen, end to end:

1. Logging into this backend and connecting the Instagram account.
2. A funnel being created (keyword, the exact DM copy, the delivery link).
3. A real comment with the keyword, from a second test account.
4. The public reply appearing under that comment.
5. The private DM arriving in the second account's inbox.
6. Replying with an email address.
7. The delivery DM arriving, and the lead appearing in the CRM.

Recording all seven in one unbroken take passes far more often than a montage.
Business verification must be complete first, or the request stalls before a
reviewer ever sees it. Budget days to weeks, not hours.

### 5. The gate nothing else gets past: the app must be published

A real DM was sent to the account on 2026-08-15 with `wrangler tail` running.
**Zero requests reached the Worker** — not a rejected signature, not a 403,
nothing at all. Meta did not deliver.

The reason is documented, and it sits upstream of every layer in §4:

> Your app must be published, regardless of app review status, to receive
> webhooks.
> — [Meta, Webhooks for Instagram Messaging](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/webhooks)

An app in Development Mode receives **no** Instagram webhooks. Not for testers,
not for admins, not for the app owner. The familiar "dev mode still works for
people with a role on the app" rule is real, but it governs *App Review*, not app
mode — the same page continues:

> If your app has not been approved, pending, or review is not needed, Webhooks
> will only be sent if the person using your app has a role on the app.

Two gates, in this order:

| Gate | Unlocks | Cost |
|---|---|---|
| **Publish the app** (App Dashboard → toggle to Live) | Any webhook at all, for people holding a role on the app | One toggle |
| **Pass App Review** | Webhooks from the general public | Business verification + screencast, days to weeks |

Publishing exposes nothing: until review passes, Meta still delivers only for
role-holders, so a stranger's DM is still ignored. `GET /{app-id}/roles` on
2026-08-15 returned a single `administrators` entry and **no developers or
testers** — so the first post-publish test DM must come from that admin's own
Instagram, or a tester has to be added first.

**An empty `GET /{app-id}/subscriptions` is real. Trust it.** This document
previously said the opposite — that `{"data":[]}` was "most likely a false
negative" and should not be acted on. It was wrong, and it was wrong for about an
hour before the check proved it: the Facebook app genuinely had no `instagram`
webhook subscription registered. `POST /{app-id}/subscriptions` with
`object=instagram` fixed it, `{"success":true}`, and the read-back then showed
`active: true` with Meta verifying the callback live in the tail.

The separate fact that the *Instagram* app node (`1065768002535262`) refuses app
access tokens on both hosts — code 190 on `graph.facebook.com` ("cannot get
application info") and code 190 on `graph.instagram.com` ("token does not contain
a valid app ID") — is true, but it is unqueryability, not emptiness. Conflating
the two produced the wrong call. If a read succeeds and returns nothing, nothing
is there.

### 6. Why messaging runs on Instagram Login instead

Publishing the app did not produce a single webhook. Two more real DMs, ~90
seconds of tail each, zero requests. Publishing was necessary and not sufficient.

The remaining layer is the Page → app subscription, and it is a permanent dead
end on this path:

```
POST /{page-id}/subscribed_apps  →  403
(#200) To subscribe to the messages field, one of these permissions is
needed: pages_messaging
```

Measured with the fully-scoped token and the corrected field list, so this is not
a stale-token artifact. `pages_messaging` belongs to neither of this app's use
cases.

Meta ships a **second, unrelated Instagram architecture** that shares almost all
of the vocabulary — which is why this took a day to see:

| | Facebook Login for Business | Instagram Login |
|---|---|---|
| host | `graph.facebook.com` | `graph.instagram.com` |
| app / secret | `META_APP_ID` / `META_APP_SECRET` | `META_IG_APP_ID` / `META_IG_APP_SECRET` |
| scopes | `instagram_manage_messages`, … | `instagram_business_manage_messages`, … |
| subscribe | `POST /{page-id}/subscribed_apps` | `POST /me/subscribed_apps` |
| Facebook Page | required | **not involved at all** |
| token life | never expires | 60 days, refreshable |

**Decision (owner, 2026-08-15): use both, on purpose.** Publishing stays on
Facebook Login — it works today, and migrating it would risk a working system to
fix a broken one. Messaging moves to Instagram Login, where the subscribe call is
against the Instagram account itself and needs nothing beyond the scopes already
granted.

One Instagram account, two tokens, two jobs:

| Column | Token | Used by |
|---|---|---|
| `social_accounts.access_token` | Facebook Page token, never expires | publishing (`meta.ts`) |
| `social_accounts.dm_access_token` | Instagram Login token, 60 days | messaging (`messaging.ts`, `dm-funnel.ts`) |

They live on the same row rather than two rows because the table is
`unique (platform, external_id)` and both describe the same account — a second
row would collide and overwrite the publishing token.

`getAccount()` reads `dm_access_token` and **does not fall back** to
`access_token`. A fallback would turn "Instagram was never connected for DMs"
into a stream of code-190s from the wrong host, which is far harder to read than
a clean "not connected".

Connect at `/social/accounts` → **Connect Instagram DMs**
(`/api/social/oauth/instagram`). That route subscribes webhooks and then reads
the subscription back, because the subscribe call answering 200 is not proof. If
the read comes back empty it says so in the redirect — a green badge over a deaf
account is the exact failure this whole section exists to prevent. The account
card shows "DMs on" or "DMs not connected" for the same reason.

Two things only the account owner can do, and both must be done before the
Connect button works:

1. Run `supabase/migrations/302_instagram_login.sql`.
2. Register `https://app.envisioned.me/api/social/oauth/instagram` as a valid
   OAuth Redirect URI under Instagram Login in the Meta dashboard.

App Review on this path needs three scopes, not the six in §4:
`instagram_business_basic`, `instagram_business_manage_messages`,
`instagram_business_manage_comments`.

Still open: the 60-day token needs a refresh path (`ig_refresh_token`) before it
silently expires. The Page token never did, so there is no existing machinery to
borrow.

---

## How a funnel runs

```
comment "MAP"
   │
   ├─ public reply under the comment          (optional)
   └─ PRIVATE REPLY → opening_dm              (the one shot, must ask them to reply)
        │
        └─ they reply  ← this is what opens the 24-hour window
             │
             ├─ Gate 1: require_follow?
             │     is_user_follow_business === false → follow_prompt_dm, state = awaiting_follow
             │     (unknown counts as pass — a failed profile lookup must not
             │      accuse a real follower of not following)
             │
             ├─ Gate 2: ask_email?
             │     they typed an address        → use it (always wins)
             │     we already have them on file → use that, don't ask
             │     neither                      → email_prompt_dm, awaiting_email
             │
             └─ DELIVER
                   1. CRM lead written FIRST (tags, source, activity note)
                   2. email_template_id sent to their inbox
                   3. workflow enrollment
                   4. delivery_dm sent last
```

### Two openers, because there are two doors

`opening_dm` is a **private reply to a comment**. It cannot exist on the DM
path — there is no comment to reply to. So someone who messages the keyword
directly skips it entirely and lands on the first gate, which means the first
thing a stranger ever hears from the account is *"send me your email"*. That
reads like a form, and it is how a funnel earns a block.

`welcome_dm` is the DM path's opener. Sent once, on the message that starts the
run, and only when one is written — a funnel with `welcome_dm` null behaves
exactly as it did before.

```
DM "MAP"                          comment "MAP"
   │                                 │
   └─ welcome_dm  (optional)         ├─ public_comment_reply  (optional)
        │                            └─ opening_dm  (private reply, the one shot)
        └────────────┬─────────────────────┘
                     └─ Gate 1 → Gate 2 → DELIVER
```

The two are mutually exclusive per person. Write `welcome_dm` so it stands on
its own, and keep `email_prompt_dm` self-describing too — it is the fallback
first impression whenever a welcome is not set.

Step ordering in `deliver()` is deliberate: everything durable happens
**before** the Instagram call. If Meta fails at that instant, the contact
exists, the asset is already in their inbox, and the only thing lost is a
message — recoverable by hand. The reverse order loses the person entirely.

### Recognition — never ask twice

Governed by `skip_email_if_known` on each funnel. **Default on.**

When someone triggers a funnel, the system asks "do we already have this
person?" *before* it asks them for anything. If we do, the email question is
skipped entirely.

For a comment, this collapses the whole sequence into one message: a returning
reader comments **MAP** and the private reply *is* the delivery. No opening
message, no waiting for a response, no question. They asked; they got it.

Two signals, most-certain first:

1. `dm_subscribers.lead_id` — this exact Instagram-scoped ID finished a funnel
   before and gave an address. Effectively certain.
2. Exact match on `leads.custom->>instagram_username`, which every capture
   writes (lowercased, so casing can't cause a miss). Catches a subscriber row
   that lost its link, and any handle recorded on a lead by hand.

**Names are deliberately not matched.** Two people called Sarah would silently
inherit each other's lead record, and a wrong match here means emailing an
asset to a stranger. One redundant question is cheaper than that.

Three rules that keep it honest:

* **What they type always wins.** Someone who volunteers an address is either
  new or correcting the one we hold. Believe them over the record.
* **Only `subscribed` leads count** — the same rule `sendCrmEmail` suppresses
  on. Someone who unsubscribed, bounced or complained gets asked afresh rather
  than quietly re-served from a record they asked us to stop using.
* **Recognition never skips the follow gate.** The follow flag can only be read
  from a profile lookup keyed on a *messaging* IGSID, and a comment's `from.id`
  isn't guaranteed to be one. On a funnel with `require_follow`, a recognised
  person still gets the normal opening message so the follow can be checked
  properly on their reply.

`stat_recognised` counts these separately from `stat_emails_captured`, so
"emails captured" stays an honest measure of new addresses rather than counting
the same person on every funnel they touch.

Put `{{email}}` in the `delivery_dm` to tell them where it went — it reads
correctly whether they just typed it or we already had it, and it gives them
the opening to correct a stale address.

### Why it does not send duplicates

Three independent layers, because Meta redelivers optimistically and a slow
response means someone gets the opening DM twice:

1. `meta_webhook_events` has `event_key` as its **primary key**, and the insert
   conflict *is* the lock — no read-then-write race.
2. `dm_funnel_runs` is unique on `(funnel_id, subscriber_id)`. Commenting three
   times updates one run instead of starting three sequences.
3. `private_reply_used` records that the one allowed private reply is spent.

### Safe mode

`crm_safe_mode` governs DMs exactly as it governs email. With it on, every
outbound message is written to `dm_messages` with `simulated: true` and **no
API call is made**. The transcript reads correctly, so a whole funnel can be
rehearsed against a real Instagram account before a single message leaves.

Turn it off only after a rehearsal has been read end to end.

---

## Creating a funnel

Through the Operator, in chat — this is what `create_dm_funnel` is for:

> Create a DM funnel on the word MAP. Opening message asks them to reply with
> a word so I can send the link. Ask for their email. Tag them ig-dm and
> map-waitlist.

Three rules the tool enforces, each because the alternative fails silently:

* **Always created as a draft.** Activation is a separate approval, because an
  active funnel messages real people. `propose_dm_funnel_activation` puts the
  full sequence in the approvals queue; approving it flips the status live.
* **One-word keywords only.** A keyword with a space cannot be matched reliably
  against a comment.
* **`ask_email` without `email_prompt_dm` is rejected.** The funnel would stall
  at `awaiting_email` having never asked, which reads to the person as being
  ghosted by a robot.

`skip_email_if_known` defaults on and should almost always stay on. Turn it off
only when a funnel genuinely needs the address re-confirmed.

Keyword matching is whole-word and case-insensitive, so `MAP` does not fire on
"roadmap". Only **active** funnels are held to one-per-keyword — drafts may
share a word, so a replacement can be written before the old one is retired.

---

## Cards and chips

Instagram accepts three message shapes on this rail. Which one to use is not a
styling decision — it changes what the person can do.

**Text.** The default. A URL inside one gets a link-preview panel drawn *above*
it by Instagram, while the raw `https://…` stays in the sentence below. One
message, but the link visibly appears twice, and there is no flag to suppress
the preview or attach a button to it.

**Link card** (generic template). The same preview panel with the URL moved into
a button, so the picture survives and the duplicate does not. Set
`delivery_card_title` on a funnel to switch its delivery over; leaving it null
keeps the old text behaviour, which is what every funnel written before
migration 303 still does. Meta's limits are 80 characters of title, 80 of
subtitle, 3 buttons, 10 cards — enforced in `messaging.ts` and again as a column
constraint, because overrunning any of them is a 400 that costs a delivery.

Cards only go out on the ordinary DM path. A private reply and a public comment
reply are both text-only, so a card requested on those paths falls back to text
— which is why `deliver()` still renders `delivery_dm` even when a card exists.

**Quick replies.** Tappable chips under a text message, up to 13, titles capped
at 20 characters. `content_type: "user_email"` is the valuable one: it offers
the address on the person's Instagram profile as a single tap. The email ask
carries one, because typing an email on a phone keyboard is the widest gap in
this funnel. Their tap arrives as an ordinary inbound message whose text *is*
the address, so `extractEmail` handles it with no new code path.

Neither needs a new permission. Quick replies and `web_url` buttons both arrive
back through the `messages` webhook already subscribed. Only `postback` buttons
would need `messaging_postbacks` added to `subscribed_fields`, which is why
nothing here uses one yet.

---

## What is deliberately NOT built

**A `send_dm` workflow step.** Workflow steps run on a 5-minute cron with delays
measured in days. The DM window is 24 hours from *their* last message. A
`send_dm` step scheduled three days out would fail with code 10 essentially
every time. It would look like a feature and behave like a bug.

**A `dm_keyword` workflow trigger.** `enroll_workflow_id` on the funnel already
does this job at the moment of capture. A second path to the same outcome is
two things to keep in sync.

If DM follow-up beyond the window is ever wanted, the honest mechanism is the
one already in place: capture the email, and follow up by email.
