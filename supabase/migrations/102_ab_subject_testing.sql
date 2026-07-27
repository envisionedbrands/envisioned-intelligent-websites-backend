-- Migration 102 (Digital Home Upgrade): A/B subject-line testing inside workflows.
-- A template with subject_b set is an active test: the engine alternates
-- subjects per send and records which variant went out; the tick auto-promotes
-- the winner once both variants have enough opens data.

alter table email_templates add column if not exists subject_b text;

alter table email_sends add column if not exists variant text
  check (variant in ('a', 'b'));

comment on column email_templates.subject_b is
  'Challenger subject line. Non-null = A/B test running; cleared on promotion.';
comment on column email_sends.variant is
  'Which subject variant this send used (a = subject, b = subject_b).';
