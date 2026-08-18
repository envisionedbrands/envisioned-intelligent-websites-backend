-- 303: deliver the asset as a link card instead of a text message.
--
-- Instagram renders a text message containing a URL as a link-preview panel
-- with the raw https:// still sitting in the sentence underneath. One message,
-- but it reads as the same link sent twice. A generic template is the same
-- panel with the URL moved into a tappable button — the picture stays, the
-- duplicate goes.
--
-- All four columns are nullable and every existing funnel keeps sending plain
-- text until a title is set. `delivery_card_title` is the switch.

alter table dm_funnels
  add column if not exists delivery_card_title    text,
  add column if not exists delivery_card_subtitle text,
  add column if not exists delivery_card_image    text,
  add column if not exists delivery_button_label  text;

-- Meta rejects the whole send with a 400 if either string overruns, so the
-- limit is enforced at the column rather than trusted to the form. Losing a
-- delivery to a headline someone made 82 characters long is not a failure
-- worth allowing.
alter table dm_funnels
  add constraint dm_funnels_card_title_len
    check (delivery_card_title is null or char_length(delivery_card_title) <= 80) not valid,
  add constraint dm_funnels_card_subtitle_len
    check (delivery_card_subtitle is null or char_length(delivery_card_subtitle) <= 80) not valid;

comment on column dm_funnels.delivery_card_title is
  'Headline on the delivery card. Null = send the delivery as plain text (old behaviour). Max 80 chars — Meta''s limit.';
comment on column dm_funnels.delivery_card_image is
  'Hero image URL shown on the card. Must be publicly reachable — Meta fetches it.';
comment on column dm_funnels.delivery_button_label is
  'Wording on the button. Defaults to "Read it" when blank.';

-- ── Switch the live funnel over ────────────────────────────────────────────
-- Title and image are the article's own, read from content_objects, so the
-- card carries the same picture that appeared in the preview panel before.
-- The closing line moves into the subtitle, which is why it is shorter: 80
-- characters is Meta's ceiling, not an edit for its own sake.
update dm_funnels
set delivery_card_title    = 'You Are Not Behind on AI. You Are Behind on Yourself.',
    delivery_card_subtitle = 'In your inbox too. If it names what you''ve been avoiding, that''s the point.',
    delivery_card_image    = 'https://aqylffhuzunpimrebgye.supabase.co/storage/v1/object/public/images/articles/you-are-not-behind-on-ai-you-are-cover.png',
    delivery_button_label  = 'Read the essay',
    -- Saved before keyword normalisation shipped, so it holds the same word
    -- three times. Harmless — matching de-duplicates — but it reads as a bug
    -- on the screen.
    keyword                = 'behind'
where name = 'Behind on AI — essay delivery';
