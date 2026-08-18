# Meta App Review — submission copy (MI CRM, app 922625350891031)

Prepared 2026-08-15. Paste-ready text for the three Instagram Login scopes.

The submission asks two things per permission: **how you use it** and a
**screencast** proving it. Reviewers reject text that describes a product
generally instead of describing the exact clicks in the video, so each block
below names the same screens the video shows.

Three permissions are in the submission. `instagram_business_content_publish`,
`instagram_business_manage_insights` and Human Agent were removed — publishing
and insights run on the separate Facebook Login for Business rail
(`src/lib/social/meta.ts` requests `pages_manage_posts` /
`instagram_content_publish`), and there is no inbox UI to demonstrate a human
agent with.

---

## 1. instagram_business_basic

> Envisioned Brands runs its own customer-relationship software instead of a
> third-party platform. This permission is used to identify which Instagram
> account the business has connected, and to resolve the username and profile
> name of a person who has messaged that account, so their conversation can be
> shown to the business owner under a name rather than a numeric ID.
>
> In the screencast: the business owner signs in to the back office, opens
> Social → Accounts, and connects the Instagram professional account
> @envisionedbrands. The connected account's username and profile picture then
> appear on the account card. Later in the video, when a message arrives, the
> sender's username is shown on the conversation record — that display name is
> the only other use of this permission.
>
> No data is used for advertising, is sold, or is shared with third parties.

## 2. instagram_business_manage_messages

> This permission delivers a lead-capture conversation that the business
> currently pays a third-party tool to run, and wants to own.
>
> The flow, exactly as shown in the screencast: the business publishes a post
> inviting people to send a keyword. A person sends a direct message containing
> that keyword. The software receives the message, replies asking for the email
> address the requested resource should be sent to, and — once the person
> replies with it — sends a final message containing the link, emails the
> resource, and records the person as a contact in the business's own CRM.
>
> Every message sent is a direct reply inside the 24-hour window opened by the
> person's own message, or a one-time private reply to a comment they left. The
> business does not initiate conversations, does not broadcast, and does not
> message anyone who has not messaged first. A person who stops replying
> receives nothing further.
>
> Stored data and the deletion route are described at
> https://app.envisioned.me/data-deletion

## 3. instagram_business_manage_comments

> The same lead-capture flow can be started from a comment instead of a direct
> message, which is how most people respond to a post.
>
> In the screencast: a person comments the keyword under a post. The software
> reads the comment, posts a short public reply under it, and sends that person
> a one-time private reply that opens the direct-message thread. From there the
> flow is identical to the one above.
>
> Comments are read only to detect the keyword the business asked people to
> send. Comments are not moderated, hidden, or deleted, and comment text is not
> used for any purpose other than matching that keyword.

---

## Screencast — what has to be on screen

One recording covers all three. Roughly 3 minutes. Reviewers are not signed in
to the app, so the video must show login too.

1. Sign in at `app.envisioned.me` — show the login screen and the dashboard.
2. Social → Accounts → show @envisionedbrands connected, "DMs on".
3. Show the funnel configuration (keyword, what gets sent).
4. On a phone or second window, from a **different Instagram account**, comment
   the keyword under a real post. Show the public reply appearing and the
   private reply landing in that account's inbox.
5. Reply with an email address from that same account.
6. Show the delivery message arriving, and the new contact appearing in the CRM.
7. Show `app.envisioned.me/data-deletion`.

The second Instagram account must hold a role on the app (App roles → Testers)
or Meta will not deliver its messages while access is still Standard.

## Before submitting — app-level settings the reviewer also checks

- App icon — done (1024×1024, uploaded 2026-08-15)
- Privacy Policy URL → `https://codifiedinthecity.com/privacy-policy` (live, 17KB)
- Terms of Service URL → `https://codifiedinthecity.com/terms-and-conditions`
  (**not** `/terms` — that path silently serves the homepage)
- User data deletion → `https://app.envisioned.me/data-deletion`
- Category → Business and Pages
- Business verification — required for these scopes; separate queue, start early

## The funnel must be live for the video

`dm_funnels.status` is `draft` for "Behind on AI — essay delivery"
(`67473985-6753-4cb6-b6a9-6ca85e8cf506`). A draft funnel receives messages and
sends nothing, which is the correct safety default but makes the screencast
impossible. Set it active for the recording — that is an owner decision, and it
means real strangers can trigger real replies from that moment on.
