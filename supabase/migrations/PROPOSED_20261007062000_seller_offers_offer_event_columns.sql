-- PROPOSED — NOT APPLIED. Additive columns; no data change; safe to apply early.
--
-- STRICT OFFER-EVENT INVARIANT (owner 2026-10-07): an automated move to Offer
-- needs a real offer event — amount, source (engine | operator), engine_version
-- or operator id, timestamp, deal / conversation id, quote type. seller_offers
-- (the Offer Term Authority) already carries amount (purchase_price), sent_at,
-- opportunity_id, thread_key, ade_snapshot_id, policy_version. The rest lives in
-- metadata.offer_event today (stage-advance-guard.js offerEventFromSellerOffer
-- reads both); these columns make it first-class and queryable.

begin;
set local lock_timeout = '5s';

alter table public.seller_offers
  add column if not exists offer_source text check (offer_source in ('engine', 'operator')),
  add column if not exists operator_id text,
  add column if not exists engine_version text,
  add column if not exists quote_type text check (quote_type in ('FORMAL_OFFER', 'NEGOTIATION_ANCHOR', 'CONCESSION'));

-- Backfill from metadata.offer_event (the 6 reconciled operator rows, when applied) and engine provenance.
update public.seller_offers
   set offer_source   = coalesce(offer_source, metadata->'offer_event'->>'source', case when ade_snapshot_id is not null or policy_version is not null then 'engine' end),
       operator_id    = coalesce(operator_id, metadata->'offer_event'->>'operator_id'),
       engine_version = coalesce(engine_version, metadata->'offer_event'->>'engine_version', case when (metadata->'offer_event'->>'source') is distinct from 'operator' then policy_version end),
       quote_type     = coalesce(quote_type, metadata->'offer_event'->>'quote_type', 'FORMAL_OFFER')
 where offer_source is null or quote_type is null;

commit;
