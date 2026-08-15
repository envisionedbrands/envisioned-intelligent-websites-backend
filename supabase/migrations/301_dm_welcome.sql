-- Migration 301: the cold-DM welcome message.
--
-- `opening_dm` is a *private reply to a comment* — it can only exist on the
-- comment path, because that is the only path with a comment to reply to.
-- Someone who DMs the keyword directly skipped that entirely, so the first
-- thing they ever heard from the account was `email_prompt_dm` asking for
-- their address. Cold, and it reads like a form.
--
-- `welcome_dm` is that missing hello. Optional: leave it null and the funnel
-- behaves exactly as before.

alter table dm_funnels add column if not exists welcome_dm text;

comment on column dm_funnels.welcome_dm is
  'Sent once, on the message that starts a run, when the trigger was a direct message rather than a comment. Null = go straight to the first gate.';
