-- PROPOSED — NOT APPLIED. OWNER APPROVAL REQUIRED. Apply AFTER
-- PROPOSED_20261006120000_negotiation_quotes.sql (this amends that table).
--
-- OBSERVED OFFERS (no-response follow-ups, 2026-10-06): an offer found in one
-- of OUR outbound messages — typed by the owner in the Inbox ("I'd be at
-- $132,000 cash") or sent by automation — is recorded like an automated quote
-- so offer KPIs and the offer follow-up see one ledger.
--   quote_type 'observed_offer'   amount = the number as sent (single, unambiguous)
--   quote_source manual|automated
--   message_event_id              the outbound that carried it
--   extraction_confidence         high (currency / separator / k) | medium (bare 3-digit, v3 rule)
-- max_offer_at_quote is OPTIONAL for observed offers: an owner-typed number is a
-- fact, recorded truthfully even with no engine score (or above it).
-- Writer: apps/api/src/lib/domain/seller-flow/no-response-followup.js buildObservedOfferQuote
-- (called best-effort from delivery-triggered-followup.js; a failed write never blocks).
-- Additive. Rollback: PROPOSED_20261007042000_negotiation_quotes_observed_offer_rollback.sql

begin;
set local lock_timeout = '5s';

alter table public.negotiation_quotes
  add column if not exists quote_source text check (quote_source in ('automated', 'manual')),
  add column if not exists message_event_id text,
  add column if not exists extraction_confidence text;

alter table public.negotiation_quotes drop constraint if exists negotiation_quotes_quote_type_check;
alter table public.negotiation_quotes add constraint negotiation_quotes_quote_type_check
  check (quote_type in ('anchor', 'formal_offer', 'confirm_basics_no_number', 'observed_offer'));

alter table public.negotiation_quotes drop constraint if exists negotiation_quotes_amount_by_type;
alter table public.negotiation_quotes add constraint negotiation_quotes_amount_by_type check (
  (quote_type = 'confirm_basics_no_number' and amount is null)
  or (quote_type = 'observed_offer' and amount > 0)
  or (quote_type in ('anchor', 'formal_offer') and amount > 0 and max_offer_at_quote > 0 and amount <= max_offer_at_quote)
);

create index if not exists negotiation_quotes_message_event_idx on public.negotiation_quotes (message_event_id);

commit;
