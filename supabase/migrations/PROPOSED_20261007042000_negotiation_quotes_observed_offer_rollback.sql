-- ROLLBACK for PROPOSED_20261007042000_negotiation_quotes_observed_offer.sql
begin;
set local lock_timeout = '5s';
delete from public.negotiation_quotes where quote_type = 'observed_offer';
alter table public.negotiation_quotes drop constraint if exists negotiation_quotes_amount_by_type;
alter table public.negotiation_quotes add constraint negotiation_quotes_amount_by_type check (
  (quote_type = 'confirm_basics_no_number' and amount is null)
  or (quote_type <> 'confirm_basics_no_number' and amount > 0 and max_offer_at_quote > 0 and amount <= max_offer_at_quote)
);
alter table public.negotiation_quotes drop constraint if exists negotiation_quotes_quote_type_check;
alter table public.negotiation_quotes add constraint negotiation_quotes_quote_type_check
  check (quote_type in ('anchor', 'formal_offer', 'confirm_basics_no_number'));
drop index if exists public.negotiation_quotes_message_event_idx;
alter table public.negotiation_quotes drop column if exists extraction_confidence,
  drop column if exists message_event_id, drop column if exists quote_source;
commit;
