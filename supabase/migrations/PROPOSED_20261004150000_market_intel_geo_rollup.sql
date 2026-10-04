-- =============================================================================
-- Market Intelligence V1 — nightly geography × period × asset rollup
-- STATUS: PROPOSED (NOT APPLIED). Needs owner approval + a quiet window.
-- =============================================================================
--
-- WHY (measured read-only on prod, 2026-10-04)
--   V1 needs no migration: the API streams public.mv_map_market_sales once per MV
--   refresh into an in-memory index (consistent cursor, sequential scan, ~4.4 s of
--   DB time; 22.6 s wall from a remote client) and then answers every interaction
--   in memory: ZIP dossier 154 ms cold / 2.5 ms warm, national top-100 ZIP ranking
--   1.3 s cold / 21 ms warm, compare 6 markets 485 ms, MF screener across all ZIPs
--   371 ms. What raw cannot fix:
--     - cold start per API instance (every container rebuilds the index);
--     - ~67 MB heap per instance;
--     - exact medians for one level nationally cost 6.6 s per query on raw sales,
--       so the medians cannot be computed per request in SQL instead.
--   This rollup moves the heavy part to one nightly job and lets a cold instance
--   serve rankings / screens / heat from a ~1e5-row table. The in-memory index stays
--   the path for custom windows and trends until a month-grain rollup is approved.
--
-- GRAIN (minimum; every column has a consumer in mi-metric-values.js)
--   geo_level  zip | city | county | market | state | nation
--   geo_key    the Market Intelligence geography key (zip 55411, city MN:minneapolis,
--              county MN:hennepin, market <canonical_markets.id>, state MN, nation US)
--   period     90d | 6m | 1y | 3y | all  (window ends at max(sold_on))
--   asset      all | sfr | mf_2_4 | mf_5_plus | mf | land
--
-- AUTHORITY / PARITY
--   Asset classes: the CASE below mirrors lib/acquisition/assetTaxonomy.js via
--   mi-asset-classes.js for the 7 raw property_type values present in the corpus
--   (audited 2026-10-04). A parity test must compare this SQL with the JS
--   classifier over SELECT DISTINCT property_type, units before any switch; a new
--   raw value falls to 'unknown' here and must be added in both places.
--   Qualified price: mi_qualified_price@1 (same predicate as mi-loader.js).
--   Membership: market by market_zip_membership; county by census ZIP cell, else
--   the ZIP's parcel-majority county (comp_properties), exactly as mi-geography.js.
--
-- REFRESH
--   pg_cron 'refresh_mi_geo_rollup' at 10:52 UTC, after refresh_map_market_sales
--   (10:07) and its VACUUM (10:37). REFRESH CONCURRENTLY (unique index).
--   EXPLAIN (plan only, prod, 2026-10-04): total cost 2.77e7, ~556K output groups.
--   The 5 periods × 6 asset filters cross join fans ~665K sales into ~20M rows
--   ahead of the median sorts, so expect MINUTES, not seconds. Before scheduling:
--   time one refresh on a branch or off-hours. If it exceeds the 120 s budget, split
--   into one MV per period (1y first; it serves the default view) refreshed in
--   sequence with backoff, rather than raising the timeout. work_mem is raised for
--   the job only; lock_timeout 2 s, as in the campaign_audience_* jobs.
--
-- SECURITY: service_role SELECT only (the API). Revoked from PUBLIC/anon/authenticated.
-- LOCKS / VOLUME: CREATE MATERIALIZED VIEW ... WITH NO DATA (instant); the first
--   REFRESH (non-concurrent) runs the full SELECT once in the quiet window.
-- ROLLBACK: PROPOSED_20261004150000_market_intel_geo_rollup_rollback.sql
-- =============================================================================

create materialized view if not exists public.mi_geo_period_rollup as
with zip_county as (
  select substr(c.geo_id, 6) as zip, replace(c.county_geo_id, 'county:', '') as county_key
    from public.exchange_market_fundamentals_cells c
   where c.geo_level = 'zip5' and c.county_geo_id is not null
  union all
  select p.zip, p.county_key from (
    select distinct on (cp.zip5) cp.zip5 as zip,
           upper(cp.state::text) || ':' || regexp_replace(lower(btrim(cp.county_name)), '\s+(county|parish|borough)$', '') as county_key
      from comp_private.comp_properties cp
     where cp.zip5 is not null and cp.county_name is not null
     group by cp.zip5, cp.state, cp.county_name
     order by cp.zip5, count(*) desc
  ) p
  where not exists (select 1 from public.exchange_market_fundamentals_cells c2 where c2.geo_id = 'zip5:' || p.zip and c2.county_geo_id is not null)
), asof as (
  select max(sold_on) as d from public.mv_map_market_sales
), s as (
  select m.sold_on, m.price, m.ppsf, m.units, m.sqft, m.state, m.zip,
         upper(m.state) || ':' || lower(btrim(m.city)) as city_key,
         mz.canonical_market_id as market_key, zc.county_key,
         coalesce(m.is_investor, false) as inv, m.buyer_kind is not null as buyer_known,
         m.is_cash_purchase, coalesce(m.investor_inferred_current_owner, false) as entity,
         coalesce(m.price > 0 and coalesce(m.portfolio_size, 1) < 2 and m.is_arms_length is distinct from false
           and coalesce(m.doc_type, '') !~* 'quit ?claim|gift|transfer on death|correction|re-recorded|public action', false) as q,
         case
           when m.property_type in ('Single Family', 'Multi-Family', 'Apartment', 'Other') and m.units > 1
             then case when m.units >= 5 then 'mf_5_plus' else 'mf_2_4' end
           when m.property_type = 'Single Family' then 'sfr'
           when m.property_type = 'Apartment' then 'mf_5_plus'
           when m.property_type = 'Multi-Family' then 'mf_unknown'
           when m.property_type = 'Vacant Land' then 'land'
           when m.property_type in ('Townhouse', 'Mobile Home') then 'other_res'
           else 'unknown'
         end as asset
    from public.mv_map_market_sales m
    left join public.market_zip_membership mz on mz.zip5 = m.zip and mz.status = 'resolved'
    left join zip_county zc on zc.zip = m.zip
), periods(period, days) as (
  values ('90d', 90), ('6m', 182), ('1y', 365), ('3y', 1095), ('all', null::int)
), assets(asset_filter, members) as (
  values ('all', null::text[]), ('sfr', array['sfr']), ('mf_2_4', array['mf_2_4']), ('mf_5_plus', array['mf_5_plus']),
         ('mf', array['mf_2_4', 'mf_5_plus', 'mf_unknown']), ('land', array['land'])
), x as (
  select s.*, p.period, a.asset_filter,
         (p.days is null or s.sold_on > (select d from asof) - p.days) as in_window
    from s cross join periods p cross join assets a
   where a.members is null or s.asset = any(a.members)
)
select
  case when grouping(x.zip) = 0 then 'zip' when grouping(x.city_key) = 0 then 'city' when grouping(x.county_key) = 0 then 'county'
       when grouping(x.market_key) = 0 then 'market' when grouping(x.state) = 0 then 'state' else 'nation' end as geo_level,
  case when grouping(x.zip) = 0 then x.zip when grouping(x.city_key) = 0 then x.city_key when grouping(x.county_key) = 0 then x.county_key
       when grouping(x.market_key) = 0 then x.market_key when grouping(x.state) = 0 then x.state else 'US' end as geo_key,
  x.period, x.asset_filter as asset,
  count(*) filter (where x.in_window)::int as sale_count,
  count(*) filter (where x.in_window and x.price > 0)::int as priced_sale_count,
  count(*) filter (where x.in_window and x.q)::int as qualified_sale_count,
  percentile_cont(0.5) within group (order by x.price) filter (where x.in_window and x.q) as median_sale_price,
  count(*) filter (where x.in_window and x.q and x.ppsf > 0)::int as ppsf_sample,
  percentile_cont(0.5) within group (order by x.ppsf) filter (where x.in_window and x.q and x.ppsf > 0) as median_ppsf,
  count(*) filter (where x.in_window and x.q and x.asset in ('mf_2_4', 'mf_5_plus') and x.units > 0 and (x.sqft is null or x.sqft / x.units >= 350))::int as ppu_sample,
  percentile_cont(0.5) within group (order by x.price / nullif(x.units, 0))
    filter (where x.in_window and x.q and x.asset in ('mf_2_4', 'mf_5_plus') and x.units > 0 and (x.sqft is null or x.sqft / x.units >= 350)) as median_price_per_unit,
  count(*) filter (where x.in_window and x.inv)::int as investor_purchase_count,
  count(*) filter (where x.in_window and x.buyer_known)::int as buyer_known_count,
  count(*) filter (where x.in_window and x.is_cash_purchase is not null)::int as cash_known_count,
  count(*) filter (where x.in_window and x.is_cash_purchase)::int as cash_purchase_count,
  count(*) filter (where x.entity)::int as entity_owned_count,
  count(*) filter (where x.in_window and x.asset in ('mf_2_4', 'mf_5_plus', 'mf_unknown'))::int as mf_sale_count,
  (select d from asof) as as_of
from x
group by x.period, x.asset_filter, grouping sets ((x.zip), (x.city_key), (x.county_key), (x.market_key), (x.state), ())
having (count(*) filter (where x.in_window) > 0 or count(*) filter (where x.entity) > 0)
   -- a row without a key at its own level (no ZIP / city / county / market) is not a geography
   and (grouping(x.zip) = 1 or x.zip is not null) and (grouping(x.city_key) = 1 or x.city_key is not null)
   and (grouping(x.county_key) = 1 or x.county_key is not null) and (grouping(x.market_key) = 1 or x.market_key is not null)
   and (grouping(x.state) = 1 or x.state is not null)
with no data;

create unique index if not exists mi_geo_period_rollup_pk on public.mi_geo_period_rollup (geo_level, geo_key, period, asset);
create index if not exists mi_geo_period_rollup_rank on public.mi_geo_period_rollup (geo_level, period, asset);

revoke all on public.mi_geo_period_rollup from public, anon, authenticated;
grant select on public.mi_geo_period_rollup to service_role;
comment on materialized view public.mi_geo_period_rollup is
  'PROPOSED Market Intelligence rollup: geography x period x asset counts and exact medians from mv_map_market_sales. Nightly after refresh_map_market_sales. JS (mi-asset-classes.js) is the asset authority; parity test required.';

create or replace function public.refresh_mi_geo_rollup()
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('work_mem', '256MB', true);
  perform set_config('statement_timeout', '120s', true);
  refresh materialized view concurrently public.mi_geo_period_rollup;
end $$;
revoke all on function public.refresh_mi_geo_rollup() from public, anon, authenticated;
grant execute on function public.refresh_mi_geo_rollup() to service_role;

-- First fill (non-concurrent, quiet window, owner present):
--   refresh materialized view public.mi_geo_period_rollup;
-- Then schedule:
--   select cron.schedule('refresh_mi_geo_rollup', '52 10 * * *', $$select public.refresh_mi_geo_rollup()$$);
--
-- POST-APPLY CHECKS (must equal the in-memory index on the same as_of):
--   select sale_count, median_sale_price, investor_purchase_count from public.mi_geo_period_rollup
--    where geo_level = 'zip' and geo_key = '55411' and period = '1y' and asset = 'all';   -- index: 383 · 235000 · 14
--   select count(*) from public.mi_geo_period_rollup where geo_level = 'market' and period = '1y' and asset = 'all';  -- 58 or fewer
