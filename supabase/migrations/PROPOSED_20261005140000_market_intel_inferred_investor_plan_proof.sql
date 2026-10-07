-- PLAN PROOF for the pre-step index (PROPOSED_20261005140000_market_intel_inferred_investor_pre_index.sql). GENERATED; READ-ONLY.
-- Run outside 05:00-08:59 / 09:15-11:59 UTC with SET statement_timeout = '30s', once BEFORE and once AFTER
-- the pre-step. It is one i:link slice's join on a ~1/64 property_id sub-range (owner columns included),
-- against mv_map_market_sales directly (the view gains property_id only with the migration).
-- Expect BEFORE: comp_properties via "Index Scan using comp_properties_property_id_key" with shared read
--   ~= 1 heap page per sale (2026-10-07 09:08Z per-row form: read=12,971 for 10,165 lookups, 13.7 s).
-- Expect AFTER: "Index Only Scan using comp_properties_mi_owner_cover", Heap Fetches ~0, reads ~1/100 per sale.
-- Transfers already use comp_canon_tx_property_idx index-only (Heap Fetches 0) and contacts are 12 MB:
-- neither needs a new index, so none is proposed.
explain (analyze, buffers, timing off)
with s as materialized (
  select v.comp_id, v.property_id, v.sold_on, v.sold_on = max(v.sold_on) over (partition by v.property_id) as latest
    from public.mv_map_market_sales v
   where v.sold_on is not null and v.property_id >= '2166291597' and v.property_id < '2168000000'
), tx as (
  select t.primary_property_id as property_id, max(t.event_date) as last_event from comp_private.comp_canonical_transactions t
   where t.primary_property_id >= '2166291597' and t.primary_property_id < '2168000000' group by 1
), pc as (
  select c.property_id, bool_or(c.resident and c.likely_owner) as resident from comp_private.comp_property_contacts c
   where c.property_id >= '2166291597' and c.property_id < '2168000000' group by 1
)
select count(*) as sales,
       count(*) filter (where s.latest and not coalesce(tx.last_event > s.sold_on + 45, false)
                          and cp.last_observed_at::date - s.sold_on >= 30) as linked,
       count(*) filter (where cp.is_corporate_owner) as corp, count(*) filter (where cp.is_trust) as trust,
       count(*) filter (where cp.out_of_state_owner) as oos, count(cp.owner_mailing_identity_key_v1) as mail_key,
       count(*) filter (where pc.resident) as resident
  from s
  left join comp_private.comp_properties cp on cp.property_id = s.property_id and cp.property_id >= '2166291597' and cp.property_id < '2168000000'
  left join tx on tx.property_id = s.property_id
  left join pc on pc.property_id = s.property_id;
