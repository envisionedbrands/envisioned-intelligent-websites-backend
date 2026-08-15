-- Instagram Login, alongside Facebook Login rather than instead of it.
--
-- Meta ships two unrelated Instagram architectures. Publishing works today over
-- *Facebook Login for Business* (a Page token against graph.facebook.com) and is
-- not being touched. Messaging cannot work that way: receiving DMs requires the
-- Page to be subscribed to the app, which requires `pages_messaging`, which is
-- in none of this app's use cases. *Instagram Login* needs no Facebook Page at
-- all and is the path Meta now points this use case at.
--
-- So one Instagram account, two tokens, two jobs. Storing the second token in
-- its own columns on the same row — rather than as a second `social_accounts`
-- row — is deliberate: the table is unique on (platform, external_id), and both
-- connections describe the SAME Instagram account, so a second row would either
-- collide and overwrite the publishing token or need a fake external_id. Neither
-- is worth a nicer-looking schema.

alter table social_accounts add column if not exists dm_access_token text;
alter table social_accounts add column if not exists dm_token_expires_at timestamptz;

comment on column social_accounts.dm_access_token is
  'Instagram Login token (graph.instagram.com), used only by the DM funnel layer for messages and comments. Null = this account has not been connected for messaging; the DM layer then has no way to send. Distinct from access_token, which is the Facebook Page token used for publishing.';

comment on column social_accounts.dm_token_expires_at is
  'Instagram Login tokens live 60 days and must be refreshed, unlike the never-expiring Page token in access_token. Null means unknown, not never.';
