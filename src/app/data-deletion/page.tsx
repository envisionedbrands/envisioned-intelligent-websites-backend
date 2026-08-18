/**
 * Public data-deletion instructions.
 *
 * Meta requires a *publicly reachable* URL for "User data deletion" before it
 * will pass App Review, and the reviewer opens it while logged out. That makes
 * this the only page in the Backend that is deliberately not behind auth — see
 * the allowlist in `middleware.ts` and the sidebar suppression in
 * `components/sidebar.tsx`. Adding another public page means editing all three
 * places, not just dropping a file in `app/`.
 *
 * The content has to describe the *actual* data the DM funnel stores, not a
 * generic template — a reviewer who finds a boilerplate page that doesn't match
 * the requested permissions rejects the submission. What we store lives in
 * `dm_subscribers`, `dm_messages`, `meta_webhook_events` and `leads`; keep this
 * page in step with `docs/dm-funnels.md` if that ever changes.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Data deletion — Envisioned',
  description:
    'How to request deletion of the data Envisioned stores about your Instagram messages and comments.',
  // Overrides the root layout's blanket noindex. A page Meta must be able to
  // find should not be hidden from crawlers.
  robots: 'index, follow',
};

const CONTACT = 'hello@mariaines.co';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="text-[15px] font-semibold text-white mb-3">{title}</h2>
      <div className="text-[14px] leading-relaxed text-zinc-400 flex flex-col gap-3">{children}</div>
    </section>
  );
}

export default function DataDeletionPage() {
  return (
    <div className="h-full w-full overflow-y-auto bg-minimal-bg">
      <div className="max-w-[640px] mx-auto px-8 py-20">
        <p className="text-[12px] uppercase tracking-[0.14em] text-zinc-600 mb-3">Envisioned</p>
        <h1 className="text-[26px] font-semibold text-white mb-4">Deleting your data</h1>
        <p className="text-[14px] leading-relaxed text-zinc-400 mb-12">
          If you have messaged or commented on the Instagram account{' '}
          <strong className="text-zinc-200">@envisionedbrands</strong>, this page tells you exactly
          what is kept, how to have it deleted, and how long that takes.
        </p>

        <Section title="What is stored">
          <p>
            When you send a direct message to that Instagram account, or comment on one of its
            posts, Instagram passes the message to software Envisioned runs on its own servers so
            that it can reply. That software stores:
          </p>
          <ul className="list-disc pl-5 flex flex-col gap-1.5">
            <li>
              Your Instagram-scoped user ID — an identifier Instagram generates for this account
              only, which cannot be used to identify you anywhere else
            </li>
            <li>Your Instagram username and profile name, if Instagram supplies them</li>
            <li>The text of the messages and comments you send, and the replies sent back to you</li>
            <li>The time each message was sent</li>
            <li>
              Your email address and first name — only if you typed them yourself in reply to a
              request for them
            </li>
          </ul>
          <p>
            Nothing is bought, sold, or shared with advertisers. The data exists so a conversation
            you started can be answered and followed up.
          </p>
        </Section>

        {/*
          Email only, on purpose. A "DM the word DELETE" route would be friendlier,
          but no such handler exists in dm-funnel.ts — promising one here would be
          a live promise to strangers that the software cannot keep. If that
          handler is ever built, add it back to this list and not before.
        */}
        <Section title="How to have it deleted">
          <p>
            Email{' '}
            <a className="text-zinc-200 underline underline-offset-2" href={`mailto:${CONTACT}`}>
              {CONTACT}
            </a>{' '}
            with the subject <strong className="text-zinc-200">Delete my data</strong>, and include
            the Instagram handle you messaged from. That is the whole process.
          </p>
          <p>
            You do not need an account with Envisioned, you do not have to give a reason, and there
            is no form to fill in.
          </p>
        </Section>

        <Section title="What happens next">
          <p>
            Your request is confirmed within 7 days and everything listed above is erased within 30
            days. Erased means removed from the live database, not hidden — the conversation record,
            the stored messages, and any email address you gave are all deleted.
          </p>
          <p>
            One exception: if you have bought something, the transaction record required by Dutch
            and EU tax law is kept for as long as the law requires it. That record contains the
            purchase, not your messages.
          </p>
        </Section>

        <Section title="Questions">
          <p>
            Write to{' '}
            <a className="text-zinc-200 underline underline-offset-2" href={`mailto:${CONTACT}`}>
              {CONTACT}
            </a>
            . The full privacy policy is at{' '}
            <a
              className="text-zinc-200 underline underline-offset-2"
              href="https://codifiedinthecity.com/privacy-policy"
            >
              codifiedinthecity.com/privacy-policy
            </a>
            .
          </p>
        </Section>

        <p className="text-[12px] text-zinc-600 pt-6 border-t border-minimal-border">
          Envisioned Brands · Rooijsestraat 5, 6621AH Dreumel, Netherlands
        </p>
      </div>
    </div>
  );
}
