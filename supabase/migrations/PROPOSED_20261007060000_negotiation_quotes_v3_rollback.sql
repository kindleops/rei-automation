-- ROLLBACK for PROPOSED_20261007060000_negotiation_quotes_v3.sql
begin;
set local lock_timeout = '5s';
delete from public.negotiation_quotes where quote_type in ('concession', 'no_number');
alter table public.negotiation_quotes drop constraint if exists negotiation_quotes_autonomous_bound;
alter table public.negotiation_quotes drop constraint if exists negotiation_quotes_amount_by_type;
alter table public.negotiation_quotes add constraint negotiation_quotes_amount_by_type check (
  (quote_type = 'confirm_basics_no_number' and amount is null)
  or (quote_type = 'observed_offer' and amount > 0)
  or (quote_type in ('anchor', 'formal_offer') and amount > 0 and max_offer_at_quote > 0 and amount <= max_offer_at_quote)
);
alter table public.negotiation_quotes drop constraint if exists negotiation_quotes_quote_type_check;
alter table public.negotiation_quotes add constraint negotiation_quotes_quote_type_check
  check (quote_type in ('anchor', 'formal_offer', 'confirm_basics_no_number', 'observed_offer'));
alter table public.negotiation_quotes
  drop column if exists approved_at, drop column if exists approved_by,
  drop column if exists market_evidence, drop column if exists situation_evidence, drop column if exists condition_evidence,
  drop column if exists language_branch, drop column if exists score_version,
  drop column if exists negotiation_config_version, drop column if exists negotiation_engine_version,
  drop column if exists per_unit_high, drop column if exists per_unit_low, drop column if exists unit_count,
  drop column if exists per_unit_amount, drop column if exists lane, drop column if exists fallback_rung,
  drop column if exists confidence_grade, drop column if exists investor_price_at_quote,
  drop column if exists previous_lc_amount, drop column if exists anchor_floor_at_quote,
  drop column if exists autonomous_limit_at_quote, drop column if exists target_at_quote;
commit;
