-- Migration 307: name the offer on a deal.
--
-- A deal previously carried only a name and a value, so the offer lived inside
-- the name string ("Sarah — CITC"). That reads fine and filters terribly:
-- "how much Codified in the City is in flight?" was unanswerable.
--
-- Stages describe how far along someone is; the OFFER is what the deal is for.
-- Keeping them separate is what lets one pipeline serve every offer.

alter table opportunities
  add column if not exists offer_slug text,
  add column if not exists source text;

create index if not exists idx_opportunities_offer on opportunities(offer_slug);
