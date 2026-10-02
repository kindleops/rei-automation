-- =============================================================================
-- Map 8.2 — sold comps + investor lenses read the canonical transaction pipeline
-- STATUS: PROPOSED (not applied). Apply with the owner present.
-- Apply AFTER 20261002120000_map_lens_bbox_numeric.sql (its bbox fix is carried here).
-- Scope: the Map's visualisation datasets only. Valuation, get_comp_candidates_for_subject
-- and deal_market_demand are NOT touched (deal_market_demand keeps reading the legacy
-- mv_map_sold_comps; see the note at the end).
-- =============================================================================
--
-- ROOT CAUSE OF THE STALENESS (prod, read-only, 2026-10-02)
--   public.mv_map_sold_comps (94,268 rows, latest sold_on 2026-05-08) is built from
--     public.v_recent_sold_comps        (buyer_comp_raw_v2; latest 2026-05-08, 47,956 rows)
--     public.recently_sold_properties   (latest 2026-02-06, 55,893 rows)
--   Both are frozen legacy imports, and there is NO refresh job for the MV (cron.job has
--   only refresh_entity_graph_read_model and refresh_comp_market_evidence). The Sept 30
--   canonical import (comp_private.comp_canonical_transactions: 890,317 rows, latest
--   event_date 2026-09-10; comp_private.comp_properties: 596,073) never reached the Map.
--
-- WHAT
--   1. public.mv_map_market_sales — one row per deduplicated transaction, last 5 years,
--      geocoded. Same column contract as mv_map_sold_comps (so every Map RPC keeps its
--      return shape) plus provenance and the IC8 investor flag.
--        sources   comp_private.comp_canonical_transactions (deeds; comp + seller corpora)
--                  public.v_recent_sold_comps (engine pool; the only MLS-closed channel)
--        geo       comp_private.comp_properties → public.properties → the pool row
--        dedupe    ic8_txn_dedupe@1 parity (apps/api/src/lib/domain/intelligence/transactions/
--                  dedupe.js): same parcel; across sources within 10 days unless two prices
--                  differ by > 5%; 11–45 days only on an identical price (0.5%); within one
--                  source only the same day with an identical / absent price. Chained in date
--                  order — no transitive-merge guard (documented divergence).
--        price     price = the canonical deduped price when > 0, else NULL. A priced sale is
--                  price > 0 and nothing else (eligibility.js isEligiblePricedSale, owner rule
--                  2026-10-02). Price record order: positive first, then MLS > recorded deed >
--                  pool public record > affidavit > transfer tax > estimate (SOURCE_PRIORITY).
--        investor  is_investor = company buyer kind OR a buyer-index investor archetype OR
--                  institutional (features/sale-type.js isInvestorPurchase parity). Counted
--                  regardless of price (market-sales-provenance.js). The buyer kind / company
--                  regexes are the ones mv_comp_market_evidence already uses. Person buyer
--                  names are never exposed (buyer = company name only).
--        portfolio same recorded buyer, same date, same price on ≥ 2 parcels.
--        source    'mls' when the cluster contains an MLS close, else 'public_record'.
--                  ('investor' is no longer a source: buyer_class / is_investor carry it.)
--        comp_id   't:<canonical txn id>' (any deed in the cluster) else 'p:<pool id>'.
--      Verified read-only on prod (the SELECT below, 2026-10-02): 650,054 rows, comp_id
--      unique, latest sold_on 2026-09-10 (was 2026-05-08); 219,688 after 2026-05-08;
--      534,664 priced; 11,820 with an MLS close; 24,896 pool-only; ~15K cross-source merges;
--      investor (IC8) 11,252 in 2 years, institutional ~1.6K. SELECT runtime 60–80 s;
--      ~175 MB heap + ~70 MB indexes (legacy MV: 47 MB). REFRESH CONCURRENTLY ≈ 2–4 min.
--   2. Indexes: unique comp_id (CONCURRENTLY refresh), a covering (lat, lng) index for the
--      lens / cluster RPCs, sold_on, buyer, portfolio, property_id.
--   3. public.refresh_map_market_sales() + pg_cron 'refresh_map_market_sales' at 10:07 UTC
--      daily (after refresh_comp_market_evidence at 09:47) and a VACUUM ANALYZE at 10:37 so the
--      covering index stays index-only.
--   4. The six Map RPCs read mv_map_market_sales (live bodies verbatim except: the MV name;
--      investor predicates use m.is_investor (and the comp filter's 'investor' source chip means
--      is_investor; comp markers / list show priced sales only); get_map_sold_comp reads 't:' details from the
--      canonical transaction and 'p:' from the pool; bbox predicates on properties use numeric
--      bounds — 20261002120000).
--
-- SECURITY
--   The MV is not exposed: revoked from PUBLIC / anon / authenticated, SELECT for
--   service_role. The Map RPCs are SECURITY DEFINER (owner postgres) and keep their ACLs.
--   (Finding, unchanged here: all six RPCs are EXECUTE-able by anon and PUBLIC today.)
--
-- LOCKS / VOLUME
--   CREATE MATERIALIZED VIEW ... WITH DATA runs the 60 s SELECT once (reads only; no lock on
--   source tables beyond ACCESS SHARE). CREATE OR REPLACE FUNCTION is instant.
--   mv_map_sold_comps is left in place (deal_market_demand reads it; rollback needs nothing).
--
-- ROLLBACK: supabase/rollbacks/20261002122000_map_market_sales_canonical_ROLLBACK.sql
-- POST-APPLY CHECK:
--   select count(*), max(sold_on), count(*) filter (where is_investor) from public.mv_map_market_sales;
--   select count(*) from public.get_map_lens_points('investor_buys', 44.6, -93.9, 45.3, -92.7, 9);
--   select get_map_sold_comp((select comp_id from public.mv_map_market_sales where sold_on > '2026-08-01' limit 1)) ->> 'sold_on';
-- =============================================================================

create materialized view if not exists public.mv_map_market_sales as
WITH obs AS (
  -- Canonical deed transactions (comp + seller corpora, already merged across corpora at import).
  SELECT 'T'::text AS src, t.id::text AS rec_id, t.id AS txn_id, t.primary_property_id AS pid, t.event_date AS d,
         CASE WHEN t.price > 0 THEN t.price::numeric END AS price,
         false AS is_mls,
         CASE
           WHEN t.price_code ~* 'estimated' THEN 8
           WHEN t.price_source = 'recorded_full' THEN 2
           WHEN t.price_code ~* 'affidavit' THEN 4
           WHEN t.price_code ~* 'transfer tax|excise' THEN 5
           ELSE 9
         END AS prio,
         t.price_source, t.doc_type, t.buyer_1_name AS buyer_raw, t.is_cash_purchase, t.is_arms_length,
         COALESCE(t.observation_count, 1) AS obs_n, array_to_string(t.corpus_membership, '+') AS corpus,
         NULL::double precision AS p_lat, NULL::double precision AS p_lng, NULL::text AS p_addr, NULL::text AS p_city,
         NULL::text AS p_state, NULL::text AS p_zip, NULL::text AS p_type
  FROM comp_private.comp_canonical_transactions t
  WHERE t.event_date IS NOT NULL
    AND t.event_date >= (current_date - interval '5 years')::date
    AND t.event_date <= current_date
  UNION ALL
  -- Engine pool (buyer_comp_raw_v2 via v_recent_sold_comps): the only MLS-closed channel.
  SELECT 'P', v.id::text, NULL::bigint, NULLIF(btrim(v.property_id), ''),
         COALESCE(v.mls_sold_date, v.sale_date),
         COALESCE(NULLIF(v.mls_sold_price, 0), NULLIF(v.sale_price, 0)),
         (v.sale_source ~~* 'MLS%' AND COALESCE(v.mls_sold_price, 0) > 0),
         CASE WHEN v.sale_source ~~* 'MLS%' AND COALESCE(v.mls_sold_price, 0) > 0 THEN 1 ELSE 3 END,
         v.sale_source, NULL::text, NULL::text, NULL::boolean, NULL::boolean, 1, 'pool',
         v.latitude::double precision, v.longitude::double precision, COALESCE(v.property_address_full, v.property_address),
         v.property_address_city, v.property_address_state, left(v.property_address_zip, 5), v.property_type
  FROM public.v_recent_sold_comps v
  WHERE COALESCE(v.mls_sold_date, v.sale_date) IS NOT NULL
    AND NULLIF(btrim(v.property_id), '') IS NOT NULL
    AND COALESCE(v.mls_sold_date, v.sale_date) >= (current_date - interval '5 years')::date
    AND COALESCE(v.mls_sold_date, v.sale_date) <= current_date
), seq AS (
  SELECT o.*, lag(o.d) OVER w AS pd, lag(o.price) OVER w AS pp, lag(o.src) OVER w AS psrc
  FROM obs o
  WINDOW w AS (PARTITION BY o.pid ORDER BY o.d, o.src, o.rec_id)
), flagged AS (
  -- ic8_txn_dedupe@1 parity (dedupe.js): same parcel; cross-source within 10 days unless two prices
  -- disagree by > 5%; 11-45 days only on an identical price (0.5%); same source only on the same
  -- day with an identical (or absent) price. Chained over date order (no transitive-merge guard).
  SELECT s.*,
    CASE WHEN s.pd IS NULL THEN 1
      WHEN s.src <> s.psrc AND s.d - s.pd <= 10
           AND (s.price IS NULL OR s.pp IS NULL OR abs(s.price - s.pp) <= 0.05 * greatest(s.price, s.pp)) THEN 0
      WHEN s.src <> s.psrc AND s.d - s.pd <= 45 AND s.price IS NOT NULL AND s.pp IS NOT NULL
           AND abs(s.price - s.pp) <= 0.005 * greatest(s.price, s.pp) THEN 0
      WHEN s.src = s.psrc AND s.d = s.pd
           AND ((s.price IS NULL AND s.pp IS NULL) OR (s.price IS NOT NULL AND s.pp IS NOT NULL AND abs(s.price - s.pp) <= 0.005 * greatest(s.price, s.pp))) THEN 0
      ELSE 1 END AS new_txn
  FROM seq s
), clustered AS (
  SELECT f.*, sum(f.new_txn) OVER (PARTITION BY f.pid ORDER BY f.d, f.src, f.rec_id) AS cl FROM flagged f
), cluster_facts AS (
  SELECT c.pid, c.cl, min(c.d) AS first_d, bool_or(c.is_mls) AS any_mls, count(*)::int AS members,
         string_agg(DISTINCT c.src, '') AS srcs,
         max(c.txn_id) FILTER (WHERE c.src = 'T') AS deed_txn_id,
         max(c.buyer_raw) FILTER (WHERE c.src = 'T') AS deed_buyer
  FROM clustered c GROUP BY c.pid, c.cl
), winner AS (
  -- Canonical price record: positive price first, then the source ladder (MLS > recorded deed >
  -- pool public record > affidavit > transfer tax > estimate), then observations, then id.
  SELECT DISTINCT ON (c.pid, c.cl) c.*
  FROM clustered c
  ORDER BY c.pid, c.cl, (c.price IS NOT NULL) DESC, c.prio, c.obs_n DESC, c.src, c.rec_id
), txn AS (
  SELECT w.pid, cf.first_d AS sold_on, w.price, w.src AS price_src, w.rec_id AS price_rec_id, w.price_source,
         cf.any_mls, cf.members, cf.srcs, COALESCE(cf.deed_txn_id, w.txn_id) AS txn_id,
         COALESCE(cf.deed_buyer, w.buyer_raw) AS buyer_raw, w.doc_type, w.is_cash_purchase, w.is_arms_length,
         w.p_lat, w.p_lng, w.p_addr, w.p_city, w.p_state, w.p_zip, w.p_type,
         CASE WHEN cf.deed_txn_id IS NOT NULL THEN 't:' || cf.deed_txn_id::text ELSE 'p:' || w.rec_id END AS comp_id
  FROM winner w JOIN cluster_facts cf ON cf.pid = w.pid AND cf.cl = w.cl
), geo AS (
  SELECT x.*,
    COALESCE(cp.latitude::double precision, p.latitude::double precision, x.p_lat) AS lat,
    COALESCE(cp.longitude::double precision, p.longitude::double precision, x.p_lng) AS lng,
    COALESCE(cp.address_full, p.property_address_full, x.p_addr) AS address,
    COALESCE(cp.city, p.property_address_city, x.p_city) AS city,
    upper(COALESCE(cp.state::text, p.property_address_state, x.p_state)) AS state,
    lpad(COALESCE(cp.zip5::text, left(p.property_address_zip, 5), x.p_zip), 5, '0') AS zip,
    COALESCE(cp.property_type, p.property_type, x.p_type) AS property_type,
    COALESCE(cp.bedrooms::numeric, p.total_bedrooms::numeric) AS beds,
    COALESCE(cp.baths, p.total_baths::numeric) AS baths,
    COALESCE(cp.building_sqft::numeric, p.building_square_feet::numeric) AS sqft,
    COALESCE(cp.year_built::integer, NULLIF(p.year_built, 0)::integer) AS year_built,
    COALESCE(cp.units_count::numeric, p.units_count::numeric) AS units,
    COALESCE(cp.estimated_value::numeric, p.estimated_value::numeric) AS estimated_value,
    cp.is_corporate_owner AS owner_corporate_now,
    (x.sold_on = max(x.sold_on) OVER (PARTITION BY x.pid)) AS is_latest_sale
  FROM txn x
  LEFT JOIN comp_private.comp_properties cp ON cp.property_id = x.pid
  LEFT JOIN public.properties p ON p.property_id::text = x.pid AND cp.property_id IS NULL
), buyer AS (
  SELECT DISTINCT ON (l.canonical_transaction_id) l.canonical_transaction_id, b.entity_type, b.archetype,
         CASE WHEN b.entity_type = 'company' THEN b.display_name END AS company_name
  FROM comp_private.w8c_transaction_buyer_links l
  JOIN public.eg_buyer_index b ON b.entity_key = l.buyer_entity_id
  ORDER BY l.canonical_transaction_id, l.confidence DESC NULLS LAST
), classed AS (
  SELECT g.*, bu.archetype AS buyer_archetype,
    COALESCE(bu.entity_type,
      CASE WHEN g.buyer_raw ~* '\m(llc|l\.l\.c|inc|corp|co|company|trust|holdings?|propert(y|ies)|invest(ment)?s?|capital|partners|lp|ltd|group|realty|homes?|rentals?|ventures?|enterprises?|management|fund|bank|associates|development|builders?|construction|housing|equity|assets?|solutions)\M' THEN 'company'
           WHEN g.buyer_raw IS NOT NULL THEN 'person' END) AS buyer_kind,
    COALESCE(bu.company_name,
      CASE WHEN g.buyer_raw ~* '\m(llc|l\.l\.c|inc|corp|company|trust|holdings?|propert(y|ies)|invest(ment)?s?|capital|partners|lp|ltd|group|realty|homes?|rentals?|ventures?|enterprises?|management|fund|bank|associates|development|builders?|construction|housing|equity|assets?|solutions)\M' THEN g.buyer_raw END) AS buyer_company
  FROM geo g
  LEFT JOIN buyer bu ON bu.canonical_transaction_id = g.txn_id
  WHERE g.lat IS NOT NULL AND g.lng IS NOT NULL
), portfolio AS (
  SELECT c.*,
    CASE WHEN c.buyer_raw IS NOT NULL AND c.price IS NOT NULL
         THEN count(*) OVER (PARTITION BY upper(btrim(c.buyer_raw)), c.sold_on, c.price)::int ELSE 1 END AS portfolio_size
  FROM classed c
)
SELECT
  q.comp_id,
  CASE WHEN q.any_mls THEN 'mls' ELSE 'public_record' END AS source,
  q.sold_on, q.price, q.lat, q.lng, q.pid AS property_id, q.address, q.city, q.state, q.zip, q.property_type,
  q.beds, q.baths, q.sqft, q.year_built, q.units, q.estimated_value,
  NULL::text AS streetview_image,
  q.buyer_company AS buyer,
  NULL::text AS owner_type, NULL::boolean AS out_of_state_owner,
  q.portfolio_size,
  CASE
    WHEN q.buyer_archetype = 'institutional_high_volume_buyer'
      OR q.buyer_raw ~* '(INVITATION HOMES|AMERICAN HOMES 4 RENT|\mAMH\M|\mAH4R\M|PROGRESS RESIDENTIAL|TRICON|\mSFR\M|FIRSTKEY|MAIN STREET RENEWAL|VINEBROOK|PRETIUM|HOME PARTNERS|AMHERST|CERBERUS|BLACKSTONE|RESICAP|OPENDOOR|OFFERPAD|\mMYND\M|ROOFSTOCK|FRONT YARD|HAVENBROOK|BROOKFIELD|STARWOOD|INVH|FUNDRISE)' THEN 'institutional'
    WHEN q.buyer_raw ~* '(LENNAR|D\.? ?R\.? HORTON|PULTE|\mKB HOME|MERITAGE|TAYLOR MORRISON|CENTEX|\mNVR\M|RYAN HOMES|TOLL BROTHERS|HIGHLAND HOMES|PERRY HOMES|DAVID WEEKLEY|CENTURY COMMUNITIES|LGI HOMES|STARLIGHT HOMES|ASHTON WOODS|CHESMAR|BEAZER|M/I HOMES|DREAM FINDERS|TRI POINTE|SHEA HOMES|WILLIAM LYON|K HOVNANIAN|MATTAMY)' THEN 'builder'
    WHEN q.portfolio_size >= 10 AND COALESCE(q.price, 0) >= 1000000 THEN 'institutional'
    WHEN q.portfolio_size >= 2 THEN 'portfolio'
    WHEN q.buyer_raw ~* '\m(BANK|MORTGAGE|FEDERAL NATIONAL|FEDERAL HOME LOAN|FANNIE MAE|FREDDIE MAC|CREDIT UNION|SAVINGS|LENDING|LOAN SERVICING)\M' THEN 'bank'
    WHEN q.buyer_raw ~* '\m(CITY OF|COUNTY OF|STATE OF|HOUSING AUTHORITY|UNITED STATES|SECRETARY OF|DEPARTMENT OF|HOUSING AND URBAN)\M' THEN 'government'
    WHEN q.buyer_kind = 'company' AND q.buyer_raw ~* '\mTRUST\M' AND q.buyer_raw !~* '\m(LLC|INC|CORP|FUND|CAPITAL|PROPERTIES)\M' THEN 'trust'
    WHEN q.buyer_kind = 'company' OR q.buyer_archetype IS NOT NULL THEN 'llc_investor'
    WHEN q.buyer_kind = 'person' THEN 'individual'
    ELSE 'unknown'
  END AS buyer_class,
  CASE WHEN q.portfolio_size >= 2 AND q.price IS NOT NULL THEN round(q.price / q.portfolio_size) END AS per_door,
  CASE WHEN q.sqft > 0 AND q.price > 0 AND q.portfolio_size < 2 THEN round(q.price / q.sqft) END AS ppsf,
  -- IC8 investor definition parity (features/sale-type.js isInvestorPurchase): company buyer kind,
  -- a buyer-index investor archetype, or institutional. Counted regardless of price.
  COALESCE(q.buyer_kind = 'company' OR q.buyer_archetype IN ('institutional_high_volume_buyer', 'active_flipper', 'long_term_rental_holder', 'general_acquirer',
     'geographically_concentrated_buyer', 'diversified_buyer', 'multifamily_operator', 'small_multifamily_operator', 'commercial_operator', 'inactive_stale_buyer'), false) AS is_investor,
  q.buyer_kind, q.buyer_archetype,
  q.txn_id, q.price_src, q.price_rec_id, q.price_source, q.members AS observations, q.srcs AS sources,
  q.doc_type, q.is_cash_purchase, q.is_arms_length,
  (q.price IS NOT NULL) AS is_priced,
  -- NOT part of the IC8 definition: the parcel's CURRENT owner is corporate and this is its latest
  -- sale, with no recorded buyer name. A labelled inference only (owner decision pending).
  (q.buyer_raw IS NULL AND q.is_latest_sale AND q.owner_corporate_now IS TRUE) AS investor_inferred_current_owner
FROM portfolio q
with data;

create unique index if not exists mv_map_market_sales_id on public.mv_map_market_sales (comp_id);
create index if not exists mv_map_market_sales_geo on public.mv_map_market_sales (lat, lng)
  include (sold_on, price, per_door, ppsf, source, buyer_class, is_investor, portfolio_size);
create index if not exists mv_map_market_sales_sold_on on public.mv_map_market_sales (sold_on);
create index if not exists mv_map_market_sales_buyer on public.mv_map_market_sales (buyer) where buyer is not null;
create index if not exists mv_map_market_sales_portfolio on public.mv_map_market_sales (buyer, sold_on, price) where portfolio_size >= 2;
create index if not exists mv_map_market_sales_property_id on public.mv_map_market_sales (property_id);

revoke all on public.mv_map_market_sales from public, anon, authenticated;
grant select on public.mv_map_market_sales to service_role;
comment on materialized view public.mv_map_market_sales is
  'Map sold comps + investor lenses: deduplicated canonical transactions (comp_canonical_transactions + engine pool), last 5 years, geocoded. Priced = price > 0. is_investor = IC8 isInvestorPurchase parity. Refreshed daily by pg_cron refresh_map_market_sales.';

create or replace function public.refresh_map_market_sales()
returns void
language sql
security definer
set search_path = ''
as $$ refresh materialized view concurrently public.mv_map_market_sales $$;
revoke all on function public.refresh_map_market_sales() from public, anon, authenticated;
grant execute on function public.refresh_map_market_sales() to service_role;

select cron.schedule('refresh_map_market_sales', '7 10 * * *', $$select public.refresh_map_market_sales()$$);
select cron.schedule('vacuum_map_market_sales', '37 10 * * *', $$vacuum (analyze) public.mv_map_market_sales$$);

CREATE OR REPLACE FUNCTION public.get_map_lens_points(p_lens text, p_min_lat double precision, p_min_lng double precision, p_max_lat double precision, p_max_lng double precision, p_zoom double precision)
 RETURNS TABLE(lat double precision, lng double precision, v double precision, n integer, id text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  g double precision;
  lvl text;
BEGIN
  g := CASE
    WHEN p_zoom >= 13 THEN 0
    WHEN p_zoom >= 11 THEN 0.004
    WHEN p_zoom >= 9 THEN 0.015
    WHEN p_zoom >= 7 THEN 0.06
    WHEN p_zoom >= 5 THEN 0.22
    ELSE 0.6
  END;
  lvl := CASE WHEN p_zoom >= 6.5 THEN 'zip5' WHEN p_zoom >= 4.5 THEN 'county' ELSE 'state' END;

  IF p_lens IN ('properties', 'equity', 'value', 'year_built', 'motivation', 'distress', 'loan', 'tax_delinquent', 'free_clear') THEN
    RETURN QUERY
    WITH src AS (
      SELECT
        pr.property_id::text AS pid,
        pr.latitude::double precision AS la,
        pr.longitude::double precision AS lo,
        CASE p_lens
          WHEN 'equity' THEN pr.equity_percent::double precision
          WHEN 'value' THEN NULLIF(pr.estimated_value, 0)::double precision
          WHEN 'year_built' THEN NULLIF(pr.year_built, 0)::double precision
          WHEN 'motivation' THEN pr.structured_motivation_score::double precision
          WHEN 'distress' THEN pr.tag_distress_score::double precision
          WHEN 'loan' THEN pr.total_loan_balance::double precision
          WHEN 'tax_delinquent' THEN CASE WHEN pr.tax_delinquent THEN 1 ELSE 0 END::double precision
          WHEN 'free_clear' THEN CASE WHEN COALESCE(pr.total_loan_balance, 0) = 0 THEN 1 ELSE 0 END::double precision
          ELSE 1::double precision
        END AS val
      FROM public.properties pr
      WHERE pr.latitude BETWEEN p_min_lat::numeric AND p_max_lat::numeric
        AND pr.longitude BETWEEN p_min_lng::numeric AND p_max_lng::numeric
    )
    SELECT * FROM (
      SELECT s.la, s.lo, s.val, 1, s.pid FROM src s
      WHERE g = 0 AND s.val IS NOT NULL
      LIMIT 20000
    ) pts
    UNION ALL
    SELECT avg(s.la), avg(s.lo), avg(s.val), count(*)::integer, NULL::text
    FROM src s
    WHERE g > 0 AND s.val IS NOT NULL
    GROUP BY floor(s.la / g), floor(s.lo / g);
    RETURN;
  END IF;

  IF p_lens IN ('census_income', 'census_rent', 'census_vacancy', 'census_renter', 'census_year_built', 'census_rent_burden', 'census_population',
                'census_owner', 'census_units_2_4', 'census_units_5plus') THEN
    RETURN QUERY
    SELECT c.centroid_lat::double precision, c.centroid_lng::double precision,
      (CASE p_lens
        WHEN 'census_income' THEN c.median_household_income
        WHEN 'census_rent' THEN c.median_gross_rent
        WHEN 'census_vacancy' THEN c.vacancy_rate
        WHEN 'census_renter' THEN c.renter_share
        WHEN 'census_year_built' THEN c.median_year_built
        WHEN 'census_rent_burden' THEN c.rent_burden
        WHEN 'census_owner' THEN c.owner_share
        WHEN 'census_units_2_4' THEN c.units_2_4_share
        WHEN 'census_units_5plus' THEN c.units_5plus_share
        ELSE c.population
      END)::double precision,
      1, c.geo_id::text
    FROM public.exchange_market_fundamentals_cells c
    WHERE c.geo_level = lvl
      AND c.centroid_lat BETWEEN p_min_lat - 1 AND p_max_lat + 1
      AND c.centroid_lng BETWEEN p_min_lng - 1 AND p_max_lng + 1;
    RETURN;
  END IF;

  IF p_lens = 'hud_rent' THEN
    RETURN QUERY
    SELECT r.centroid_lat::double precision, r.centroid_lng::double precision, r.amount_usd::double precision, 1, r.geo_id::text
    FROM public.exchange_rent_benchmark_cells r
    WHERE r.bedroom_count = 2
      AND r.geo_level = CASE WHEN lvl = 'zip5' THEN 'zip5' ELSE 'county' END
      AND r.centroid_lat BETWEEN p_min_lat - 1 AND p_max_lat + 1
      AND r.centroid_lng BETWEEN p_min_lng - 1 AND p_max_lng + 1;
    RETURN;
  END IF;

  IF p_lens = 'hpi' THEN
    RETURN QUERY
    SELECT h.centroid_lat::double precision, h.centroid_lng::double precision, h.appreciation::double precision, 1, h.geo_id::text
    FROM public.exchange_trend_hpi_cells h
    WHERE h.window_key = '5Y'
      AND h.geo_level = lvl
      AND h.centroid_lat BETWEEN p_min_lat - 1 AND p_max_lat + 1
      AND h.centroid_lng BETWEEN p_min_lng - 1 AND p_max_lng + 1;
    RETURN;
  END IF;

  IF p_lens = 'flood' THEN
    RETURN QUERY
    SELECT f.centroid_lat::double precision, f.centroid_lng::double precision, f.sfha_share::double precision, 1, f.geo_id::text
    FROM public.exchange_flood_exposure_cells f
    WHERE f.centroid_lat BETWEEN p_min_lat - 1 AND p_max_lat + 1
      AND f.centroid_lng BETWEEN p_min_lng - 1 AND p_max_lng + 1;
    RETURN;
  END IF;

  IF p_lens IN ('market_tax_delinquent', 'market_foreclosure', 'market_pre1980', 'market_median_value') THEN
    RETURN QUERY
    SELECT o.centroid_lat::double precision, o.centroid_lng::double precision,
      (CASE p_lens
        WHEN 'market_tax_delinquent' THEN o.tax_delinquent_share
        WHEN 'market_foreclosure' THEN o.foreclosure_share
        WHEN 'market_pre1980' THEN o.pre_1980_share
        ELSE o.median_value
      END)::double precision,
      COALESCE(o.property_count, 1)::integer, o.geo_id::text
    FROM public.exchange_market_ownership_cells o
    WHERE o.grain = 'family' AND o.window_days = 365
      AND o.geo_level = CASE WHEN lvl = 'state' THEN 'state' WHEN lvl = 'county' THEN 'county' ELSE 'zip5' END
      AND o.centroid_lat BETWEEN p_min_lat - 1 AND p_max_lat + 1
      AND o.centroid_lng BETWEEN p_min_lng - 1 AND p_max_lng + 1;
    RETURN;
  END IF;

  IF p_lens IN ('comps_price', 'comps_ppsf', 'mls_price', 'investor_price', 'investor_buys', 'institutional_buys') THEN
    RETURN QUERY
    WITH src AS (
      SELECT m.lat AS la, m.lng AS lo,
        (CASE p_lens
          WHEN 'comps_ppsf' THEN m.ppsf
          WHEN 'investor_buys' THEN 1
          WHEN 'institutional_buys' THEN 1
          ELSE COALESCE(m.per_door, m.price)
        END)::double precision AS val,
        m.comp_id AS pid
      FROM public.mv_map_market_sales m
      WHERE m.lat BETWEEN p_min_lat AND p_max_lat
        AND m.lng BETWEEN p_min_lng AND p_max_lng
        AND m.sold_on >= current_date - 730
        AND CASE p_lens
              WHEN 'mls_price' THEN m.source = 'mls'
              WHEN 'investor_price' THEN m.is_investor
              WHEN 'investor_buys' THEN m.is_investor
              WHEN 'institutional_buys' THEN m.buyer_class IN ('institutional', 'hedge_fund')
              ELSE true
            END
    )
    SELECT * FROM (SELECT s.la, s.lo, s.val, 1, s.pid FROM src s WHERE g = 0 AND s.val IS NOT NULL AND s.val > 0 LIMIT 9000) pts
    UNION ALL
    SELECT avg(s.la), avg(s.lo),
           CASE WHEN p_lens IN ('investor_buys', 'institutional_buys') THEN count(*)::double precision
                ELSE percentile_cont(0.5) WITHIN GROUP (ORDER BY s.val) END,
           count(*)::integer, NULL::text
    FROM src s WHERE g > 0 AND s.val IS NOT NULL AND s.val > 0
    GROUP BY floor(s.la / g), floor(s.lo / g);
    RETURN;
  END IF;

  IF p_lens = 'outreach' THEN
    RETURN QUERY
    SELECT pr.latitude::double precision, pr.longitude::double precision,
      (CASE
        WHEN sq.queue_status = 'delivered' THEN 1
        WHEN sq.queue_status = 'sent' THEN 0.6
        WHEN sq.queue_status IN ('scheduled', 'queued', 'ready', 'pending') THEN 0.3
        ELSE 0
      END)::double precision,
      1, pr.property_id::text
    FROM public.send_queue sq
    JOIN public.properties pr ON pr.property_id::text = sq.property_id::text
    WHERE sq.created_at > now() - interval '14 days'
      AND pr.latitude BETWEEN p_min_lat::numeric AND p_max_lat::numeric
      AND pr.longitude BETWEEN p_min_lng::numeric AND p_max_lng::numeric
    LIMIT 5000;
    RETURN;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_map_lens_areas(p_lens text, p_min_lat double precision, p_min_lng double precision, p_max_lat double precision, p_max_lng double precision, p_zoom double precision)
 RETURNS TABLE(key text, v double precision, n integer, outline jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  lvl text := CASE WHEN p_zoom >= 7 THEN 'zip' WHEN p_zoom >= 4.6 THEN 'county' ELSE 'state' END;
  is_prop boolean := p_lens IN ('equity', 'value', 'year_built', 'motivation', 'distress', 'tax_delinquent', 'free_clear', 'properties');
  is_comp boolean := p_lens IN ('comps_price', 'comps_ppsf', 'mls_price', 'investor_price', 'investor_buys', 'institutional_buys');
BEGIN
  IF is_comp AND lvl = 'county' THEN lvl := 'zip'; END IF;

  IF is_prop THEN
    RETURN QUERY
    SELECT s.key,
      (CASE p_lens
        WHEN 'equity' THEN s.equity WHEN 'value' THEN s.value WHEN 'year_built' THEN s.year_built
        WHEN 'motivation' THEN s.motivation WHEN 'distress' THEN s.distress
        WHEN 'tax_delinquent' THEN s.tax_delinquent WHEN 'free_clear' THEN s.free_clear
        ELSE s.n::double precision
      END)::double precision,
      s.n, a.outline
    FROM public.mv_map_search_areas a
    JOIN public.mv_map_property_area_stats s ON s.kind = a.kind AND s.key = a.key
    WHERE a.kind = lvl
      AND a.max_lat >= p_min_lat AND a.min_lat <= p_max_lat
      AND a.max_lng >= p_min_lng AND a.min_lng <= p_max_lng;
    RETURN;
  END IF;

  IF p_lens = 'outreach' THEN
    RETURN QUERY
    WITH o AS (
      SELECT
        CASE lvl
          WHEN 'zip' THEN left(btrim(COALESCE(pr.property_address_zip, pr.property_zip)), 5)
          WHEN 'county' THEN upper(btrim(pr.property_address_state)) || ':' || lower(btrim(COALESCE(pr.property_address_county_name, pr.property_county_name)))
          ELSE upper(btrim(pr.property_address_state))
        END AS k
      FROM public.send_queue sq
      JOIN public.properties pr ON pr.property_id::text = sq.property_id::text
      WHERE sq.created_at > now() - interval '14 days'
        AND pr.latitude BETWEEN p_min_lat::numeric AND p_max_lat::numeric
        AND pr.longitude BETWEEN p_min_lng::numeric AND p_max_lng::numeric
    ), agg AS (
      SELECT o.k, count(*)::double precision AS av, count(*)::int AS an FROM o WHERE o.k IS NOT NULL GROUP BY o.k
    )
    SELECT agg.k, agg.av, agg.an, a.outline
    FROM agg JOIN public.mv_map_search_areas a ON a.kind = lvl AND a.key = agg.k;
    RETURN;
  END IF;

  IF is_comp THEN
    RETURN QUERY
    WITH cc AS (
      SELECT CASE lvl WHEN 'zip' THEN left(m.zip, 5) ELSE upper(m.state) END AS k,
             (CASE p_lens WHEN 'comps_ppsf' THEN m.ppsf WHEN 'investor_buys' THEN 1 WHEN 'institutional_buys' THEN 1 ELSE COALESCE(m.per_door, m.price) END)::double precision AS val
      FROM public.mv_map_market_sales m
      WHERE m.lat BETWEEN p_min_lat AND p_max_lat AND m.lng BETWEEN p_min_lng AND p_max_lng
        AND m.sold_on >= current_date - 730
        AND CASE p_lens
              WHEN 'mls_price' THEN m.source = 'mls'
              WHEN 'investor_price' THEN m.is_investor
              WHEN 'investor_buys' THEN m.is_investor
              WHEN 'institutional_buys' THEN m.buyer_class IN ('institutional', 'hedge_fund')
              ELSE true
            END
    ), agg AS (
      SELECT cc.k, CASE WHEN p_lens IN ('investor_buys', 'institutional_buys') THEN count(*)::double precision ELSE percentile_cont(0.5) WITHIN GROUP (ORDER BY cc.val) END AS av, count(*)::int AS an
      FROM cc WHERE cc.k IS NOT NULL AND cc.val > 0 GROUP BY cc.k
    )
    SELECT agg.k, agg.av, agg.an, a.outline
    FROM agg JOIN public.mv_map_search_areas a ON a.kind = lvl AND a.key = agg.k;
    RETURN;
  END IF;

  RETURN QUERY
  WITH aa AS (
    SELECT a.key AS k, a.outline AS ol,
      CASE lvl WHEN 'zip' THEN 'zip5:' || a.key
               WHEN 'county' THEN 'county:' || split_part(a.key, ':', 1) || ':' || split_part(a.key, ':', 2)
               ELSE 'state:' || a.key END AS gid
    FROM public.mv_map_search_areas a
    WHERE a.kind = lvl AND a.max_lat >= p_min_lat AND a.min_lat <= p_max_lat AND a.max_lng >= p_min_lng AND a.min_lng <= p_max_lng
  )
  SELECT aa.k,
    (CASE
      WHEN p_lens LIKE 'census_%' THEN (SELECT CASE p_lens
          WHEN 'census_income' THEN c.median_household_income WHEN 'census_rent' THEN c.median_gross_rent
          WHEN 'census_vacancy' THEN c.vacancy_rate WHEN 'census_renter' THEN c.renter_share
          WHEN 'census_year_built' THEN c.median_year_built WHEN 'census_rent_burden' THEN c.rent_burden
          WHEN 'census_owner' THEN c.owner_share WHEN 'census_units_2_4' THEN c.units_2_4_share
          WHEN 'census_units_5plus' THEN c.units_5plus_share ELSE c.population END
        FROM public.exchange_market_fundamentals_cells c WHERE c.geo_id = aa.gid LIMIT 1)
      WHEN p_lens = 'hud_rent' THEN (SELECT r.amount_usd FROM public.exchange_rent_benchmark_cells r WHERE r.geo_id = aa.gid AND r.bedroom_count = 2 LIMIT 1)
      WHEN p_lens = 'hpi' THEN (SELECT h.appreciation FROM public.exchange_trend_hpi_cells h WHERE h.geo_id = aa.gid AND h.window_key = '5Y' LIMIT 1)
      WHEN p_lens = 'flood' THEN (SELECT f.sfha_share FROM public.exchange_flood_exposure_cells f WHERE f.geo_id = aa.gid LIMIT 1)
      WHEN p_lens LIKE 'market_%' THEN (SELECT CASE p_lens WHEN 'market_tax_delinquent' THEN o.tax_delinquent_share WHEN 'market_foreclosure' THEN o.foreclosure_share
          WHEN 'market_pre1980' THEN o.pre_1980_share ELSE o.median_value END
        FROM public.exchange_market_ownership_cells o WHERE o.geo_id = aa.gid AND o.grain = 'family' AND o.window_days = 365 LIMIT 1)
    END)::double precision,
    1, aa.ol
  FROM aa;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_map_sold_comps(p_min_lat double precision, p_min_lng double precision, p_max_lat double precision, p_max_lng double precision, p_zoom double precision, p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(comp_id text, lat double precision, lng double precision, price numeric, sold_on date, source text, buyer_class text, portfolio_size integer, n integer, institutional integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  g double precision := CASE WHEN p_zoom >= 11 THEN 0 WHEN p_zoom >= 10 THEN 0.003 WHEN p_zoom >= 9 THEN 0.012 WHEN p_zoom >= 7 THEN 0.04 WHEN p_zoom >= 5 THEN 0.15 ELSE 0.5 END;
  f_sources text[] := CASE WHEN jsonb_typeof(p_filters->'sources') = 'array' AND jsonb_array_length(p_filters->'sources') > 0 THEN ARRAY(SELECT jsonb_array_elements_text(p_filters->'sources')) END;
  f_classes text[] := CASE WHEN jsonb_typeof(p_filters->'classes') = 'array' AND jsonb_array_length(p_filters->'classes') > 0 THEN ARRAY(SELECT jsonb_array_elements_text(p_filters->'classes')) END;
  f_types text[] := CASE WHEN jsonb_typeof(p_filters->'types') = 'array' AND jsonb_array_length(p_filters->'types') > 0 THEN ARRAY(SELECT lower(jsonb_array_elements_text(p_filters->'types'))) END;
  f_min numeric := NULLIF(p_filters->>'min_price', '')::numeric;
  f_max numeric := NULLIF(p_filters->>'max_price', '')::numeric;
  f_since date := NULLIF(p_filters->>'since', '')::date;
  f_port boolean := COALESCE((p_filters->>'portfolio_only')::boolean, false);
  f_beds numeric := NULLIF(p_filters->>'min_beds', '')::numeric;
BEGIN
  RETURN QUERY
  WITH m AS (
    SELECT c.* FROM public.mv_map_market_sales c
    WHERE c.lat BETWEEN p_min_lat AND p_max_lat AND c.lng BETWEEN p_min_lng AND p_max_lng
      AND c.price IS NOT NULL  -- a sold comp is a priced sale (price > 0); unpriced transfers count only as activity
      AND (f_sources IS NULL OR c.source = ANY(f_sources) OR ('investor' = ANY(f_sources) AND c.is_investor))
      AND (f_classes IS NULL OR c.buyer_class = ANY(f_classes))
      AND (f_types IS NULL OR lower(COALESCE(c.property_type, '')) = ANY(f_types))
      AND (f_min IS NULL OR COALESCE(c.per_door, c.price) >= f_min)
      AND (f_max IS NULL OR COALESCE(c.per_door, c.price) <= f_max)
      AND (f_since IS NULL OR c.sold_on >= f_since)
      AND (NOT f_port OR c.portfolio_size >= 2)
      AND (f_beds IS NULL OR c.beds >= f_beds)
  )
  SELECT * FROM (
    SELECT m.comp_id, m.lat, m.lng, COALESCE(m.per_door, m.price), m.sold_on, m.source, m.buyer_class, m.portfolio_size, 1, (m.buyer_class IN ('institutional', 'hedge_fund'))::int
    FROM m WHERE g = 0
    ORDER BY m.sold_on DESC NULLS LAST
    LIMIT 9000
  ) a
  UNION ALL
  SELECT NULL, avg(m.lat), avg(m.lng), round(avg(COALESCE(m.per_door, m.price))), max(m.sold_on),
         mode() WITHIN GROUP (ORDER BY m.source), mode() WITHIN GROUP (ORDER BY m.buyer_class),
         max(m.portfolio_size), count(*)::int, count(*) FILTER (WHERE m.buyer_class IN ('institutional', 'hedge_fund'))::int
  FROM m WHERE g > 0
  GROUP BY floor(m.lat / g), floor(m.lng / g);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_map_sold_comps_list(p_min_lat double precision, p_min_lng double precision, p_max_lat double precision, p_max_lng double precision, p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(comp_id text, address text, price numeric, per_door numeric, sold_on date, source text, buyer_class text, portfolio_size integer, property_type text, buyer text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  f_sources text[] := CASE WHEN jsonb_typeof(p_filters->'sources') = 'array' AND jsonb_array_length(p_filters->'sources') > 0 THEN ARRAY(SELECT jsonb_array_elements_text(p_filters->'sources')) END;
  f_classes text[] := CASE WHEN jsonb_typeof(p_filters->'classes') = 'array' AND jsonb_array_length(p_filters->'classes') > 0 THEN ARRAY(SELECT jsonb_array_elements_text(p_filters->'classes')) END;
  f_types text[] := CASE WHEN jsonb_typeof(p_filters->'types') = 'array' AND jsonb_array_length(p_filters->'types') > 0 THEN ARRAY(SELECT lower(jsonb_array_elements_text(p_filters->'types'))) END;
  f_min numeric := NULLIF(p_filters->>'min_price', '')::numeric;
  f_max numeric := NULLIF(p_filters->>'max_price', '')::numeric;
  f_since date := NULLIF(p_filters->>'since', '')::date;
  f_port boolean := COALESCE((p_filters->>'portfolio_only')::boolean, false);
  f_beds numeric := NULLIF(p_filters->>'min_beds', '')::numeric;
BEGIN
  RETURN QUERY
  SELECT c.comp_id, c.address, c.price, c.per_door, c.sold_on, c.source, c.buyer_class, c.portfolio_size, c.property_type, c.buyer
  FROM public.mv_map_market_sales c
  WHERE c.lat BETWEEN p_min_lat AND p_max_lat AND c.lng BETWEEN p_min_lng AND p_max_lng
    AND c.price IS NOT NULL  -- a sold comp is a priced sale (price > 0); unpriced transfers count only as activity
      AND (f_sources IS NULL OR c.source = ANY(f_sources) OR ('investor' = ANY(f_sources) AND c.is_investor))
    AND (f_classes IS NULL OR c.buyer_class = ANY(f_classes))
    AND (f_types IS NULL OR lower(COALESCE(c.property_type, '')) = ANY(f_types))
    AND (f_min IS NULL OR COALESCE(c.per_door, c.price) >= f_min)
    AND (f_max IS NULL OR COALESCE(c.per_door, c.price) <= f_max)
    AND (f_since IS NULL OR c.sold_on >= f_since)
    AND (NOT f_port OR c.portfolio_size >= 2)
    AND (f_beds IS NULL OR c.beds >= f_beds)
  ORDER BY c.sold_on DESC NULLS LAST
  LIMIT 80;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_map_area_facts(p_kind text, p_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  a public.mv_map_search_areas%ROWTYPE;
  poly geometry;
  since date := current_date - 365;
  props jsonb;
  sales jsonb;
  buyers jsonb;
  census jsonb;
  geo text;
BEGIN
  SELECT * INTO a FROM public.mv_map_search_areas WHERE kind = p_kind AND key = p_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  poly := ST_SetSRID(ST_GeomFromGeoJSON(a.outline::text), 4326);

  WITH pp AS (
    SELECT p.* FROM public.properties p
    WHERE p.latitude BETWEEN a.min_lat::numeric AND a.max_lat::numeric AND p.longitude BETWEEN a.min_lng::numeric AND a.max_lng::numeric
      AND CASE a.kind
            WHEN 'zip' THEN left(btrim(COALESCE(p.property_address_zip, p.property_zip)), 5) = a.key
            WHEN 'state' THEN upper(btrim(p.property_address_state)) = a.key
            WHEN 'market' THEN btrim(p.market) = a.key
            WHEN 'city' THEN upper(btrim(p.property_address_state)) || ':' || lower(btrim(p.property_address_city)) = a.key
            ELSE upper(btrim(p.property_address_state)) || ':' || lower(btrim(COALESCE(p.property_address_county_name, p.property_county_name))) = a.key
          END
  )
  SELECT jsonb_build_object(
    'count', (SELECT count(*) FROM pp),
    'types', (SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM (SELECT COALESCE(NULLIF(property_type, ''), 'Unknown') AS type, count(*) AS n FROM pp GROUP BY 1 ORDER BY 2 DESC LIMIT 5) t),
    'avg_equity_pct', (SELECT round(avg(equity_percent)::numeric, 1) FROM pp),
    'median_value', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY estimated_value) FROM pp WHERE estimated_value > 0),
    'median_year_built', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY year_built) FROM pp WHERE year_built > 1800),
    'free_clear', (SELECT count(*) FROM pp WHERE COALESCE(total_loan_balance, 0) = 0),
    'tax_delinquent', (SELECT count(*) FROM pp WHERE tax_delinquent)
  ) INTO props;

  WITH c AS (
    SELECT m.*
    FROM public.mv_map_market_sales m
    WHERE m.lat BETWEEN a.min_lat AND a.max_lat AND m.lng BETWEEN a.min_lng AND a.max_lng
      AND m.sold_on >= since
      AND CASE a.kind
            WHEN 'zip' THEN left(m.zip, 5) = a.key
            WHEN 'city' THEN upper(m.state) || ':' || lower(btrim(m.city)) = a.key
            WHEN 'state' THEN upper(m.state) = a.key
            ELSE ST_Contains(poly, ST_SetSRID(ST_MakePoint(m.lng, m.lat), 4326))
          END
  )
  SELECT jsonb_build_object(
    'window_days', 365,
    'mls_sales', (SELECT count(*) FROM c WHERE source = 'mls'),
    'mls_median_price', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price) FROM c WHERE source = 'mls' AND price > 0),
    'mls_median_ppsf', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ppsf) FROM c WHERE source = 'mls' AND ppsf > 0),
    'public_record_sales', (SELECT count(*) FROM c WHERE source = 'public_record'),
    'investor_sales', (SELECT count(*) FROM c WHERE is_investor),
    'investor_median_price', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY COALESCE(per_door, price)) FROM c WHERE is_investor AND COALESCE(per_door, price) > 0),
    'institutional_sales', (SELECT count(*) FROM c WHERE buyer_class IN ('institutional', 'hedge_fund')),
    'builder_sales', (SELECT count(*) FROM c WHERE buyer_class = 'builder'),
    'portfolio_sales', (SELECT count(*) FROM c WHERE portfolio_size >= 2),
    'sold_type', (SELECT property_type FROM c WHERE property_type IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1)
  ) INTO sales;

  SELECT COALESCE(jsonb_agg(b), '[]'::jsonb) INTO buyers FROM (
    SELECT m.buyer, max(m.buyer_class) AS buyer_class, count(*) AS n
    FROM public.mv_map_market_sales m
    WHERE m.buyer IS NOT NULL AND m.sold_on >= since
      AND m.lat BETWEEN a.min_lat AND a.max_lat AND m.lng BETWEEN a.min_lng AND a.max_lng
      AND ST_Contains(poly, ST_SetSRID(ST_MakePoint(m.lng, m.lat), 4326))
    GROUP BY m.buyer ORDER BY count(*) DESC LIMIT 4
  ) b;

  geo := CASE a.kind
    WHEN 'zip' THEN 'zip5:' || a.key
    WHEN 'state' THEN 'state:' || a.key
    WHEN 'county' THEN 'county:' || split_part(a.key, ':', 1) || ':' || split_part(a.key, ':', 2)
    WHEN 'city' THEN 'city:' || split_part(a.key, ':', 1) || ':' || split_part(a.key, ':', 2)
    WHEN 'market' THEN 'city:' || upper(btrim(split_part(a.key, ',', 2))) || ':' || lower(btrim(split_part(a.key, ',', 1)))
  END;
  SELECT to_jsonb(f) INTO census FROM (
    SELECT median_household_income, median_gross_rent, vacancy_rate, renter_share, median_year_built, population, vintage
    FROM public.exchange_market_fundamentals_cells WHERE geo_id = geo LIMIT 1
  ) f;

  RETURN jsonb_build_object(
    'kind', a.kind, 'key', a.key, 'label', a.label, 'state', a.state, 'n', a.n,
    'bbox', jsonb_build_array(a.min_lng, a.min_lat, a.max_lng, a.max_lat),
    'outline', a.outline, 'properties', props, 'sales', sales, 'top_buyers', buyers, 'census', census);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_map_sold_comp(p_comp_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  c public.mv_map_market_sales%ROWTYPE;
  sib jsonb := NULL;
  buyer_stats jsonb := NULL;
  details jsonb := NULL;
BEGIN
  SELECT * INTO c FROM public.mv_map_market_sales WHERE comp_id = p_comp_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF c.portfolio_size >= 2 AND c.buyer IS NOT NULL THEN
    SELECT jsonb_agg(jsonb_build_object('comp_id', s.comp_id, 'address', s.address, 'lat', s.lat, 'lng', s.lng, 'type', s.property_type) ORDER BY s.address)
      INTO sib
      FROM (SELECT * FROM public.mv_map_market_sales s WHERE s.buyer = c.buyer AND s.sold_on IS NOT DISTINCT FROM c.sold_on AND s.price IS NOT DISTINCT FROM c.price AND s.portfolio_size >= 2 LIMIT 60) s;
  END IF;
  IF c.buyer IS NOT NULL THEN
    SELECT jsonb_build_object('purchases', count(*), 'first', min(sold_on), 'last', max(sold_on), 'markets', count(DISTINCT state),
                              'median_price', percentile_cont(0.5) WITHIN GROUP (ORDER BY COALESCE(per_door, price)))
      INTO buyer_stats FROM public.mv_map_market_sales WHERE buyer = c.buyer;
  END IF;

  -- Everything the source record knows, blanks dropped.
  IF left(p_comp_id, 2) = 't:' THEN
    -- canonical deed transaction (comp_private.comp_canonical_transactions)
    SELECT jsonb_strip_nulls(jsonb_build_object(
      'sale_date', t.event_date, 'date_kind', NULLIF(t.event_date_kind, ''), 'sale_price', NULLIF(t.price, 0),
      'price_basis', NULLIF(t.price_source, ''), 'price_code', NULLIF(t.price_code, ''), 'document_type', NULLIF(t.doc_type, ''),
      'arms_length', t.is_arms_length, 'cash_purchase', t.is_cash_purchase, 'financing', NULLIF(t.financing_kind, ''),
      'has_concurrent_loan', CASE WHEN t.concurrent_loan_amount > 0 THEN true END, 'apn', NULLIF(t.apn_parcel_id, ''),
      'observations', t.observation_count, 'corpus', array_to_string(t.corpus_membership, ' + '),
      'county', NULLIF(cp.county_name, ''), 'subdivision', NULLIF(cp.subdivision_name, ''), 'lot_square_feet', NULLIF(cp.lot_sqft, 0),
      'stories', NULLIF(cp.stories, 0), 'effective_year_built', NULLIF(cp.effective_year_built, 0), 'construction_type', NULLIF(cp.construction_type, ''),
      'property_class', NULLIF(cp.property_class, ''), 'pool', cp.has_pool, 'basement', cp.has_basement,
      'source', 'comp_private.comp_canonical_transactions'
    )) INTO details
    FROM comp_private.comp_canonical_transactions t
    LEFT JOIN comp_private.comp_properties cp ON cp.property_id = t.primary_property_id
    WHERE t.id::text = substr(p_comp_id, 3);
  ELSIF left(p_comp_id, 2) IN ('c:', 'p:') THEN
    SELECT jsonb_strip_nulls(jsonb_build_object(
      'sale_date', v.sale_date, 'sale_price', NULLIF(v.sale_price, 0), 'mls_sold_date', v.mls_sold_date, 'mls_sold_price', NULLIF(v.mls_sold_price, 0),
      'sale_source', v.sale_source, 'purchase_info', NULLIF(v.purchase_info, ''),
      'arv_estimate', NULLIF(v.arv_estimate, 0), 'arv_ppsf', NULLIF(v.arv_ppsf, 0), 'percent_off', v.percent_off, 'price_off_value', v.price_off_value,
      'potential_spread', v.potential_spread, 'estimated_repair_cost', NULLIF(v.estimated_repair_cost, 0), 'deal_grade', NULLIF(v.deal_grade, ''),
      'target_margin_percent', v.target_margin_percent, 'comp_confidence_score', v.comp_confidence_score,
      'equity_amount', v.equity_amount, 'equity_percent', v.equity_percent,
      'lot_square_feet', NULLIF(v.lot_square_feet, 0), 'lot_acreage', NULLIF(v.lot_acreage, 0), 'stories', NULLIF(v.stories, 0),
      'effective_year_built', NULLIF(v.effective_year_built, 0), 'building_condition', NULLIF(v.building_condition, ''), 'building_quality', NULLIF(v.building_quality, ''),
      'renovation_level', NULLIF(v.renovation_level_classification, ''), 'construction_type', NULLIF(v.construction_type, ''), 'exterior_walls', NULLIF(v.exterior_walls, ''),
      'roof', NULLIF(concat_ws(' · ', NULLIF(v.roof_type, ''), NULLIF(v.roof_cover, '')), ''), 'garage', NULLIF(v.garage, ''), 'pool', NULLIF(v.pool, ''),
      'basement', NULLIF(v.basement, ''), 'air_conditioning', NULLIF(v.air_conditioning, ''), 'heating', NULLIF(v.heating_type, ''), 'style', NULLIF(v.style, ''),
      'subdivision', NULLIF(v.subdivision_name, ''), 'school_district', NULLIF(v.school_district_name, ''), 'zoning', NULLIF(v.zoning, ''), 'flood_zone', NULLIF(v.flood_zone, ''),
      'county', NULLIF(v.property_address_county_name, ''), 'property_class', NULLIF(v.property_class, ''), 'asset_class', NULLIF(v.normalized_asset_class, ''),
      'sqft_range', NULLIF(v.sqft_range, ''), 'year_built_bucket', NULLIF(v.year_built_bucket, ''), 'flags', NULLIF(v.property_flags_text, '')
    )) INTO details
    FROM public.v_recent_sold_comps v WHERE v.id::text = substr(p_comp_id, 3);
  ELSIF left(p_comp_id, 2) = 'r:' THEN
    SELECT jsonb_strip_nulls(jsonb_build_object(
      'sale_date', r.sale_date, 'recording_date', r.recording_date, 'sale_price', NULLIF(r.sale_price, 0),
      'mls_sold_date', r.mls_sold_date, 'mls_sold_price', NULLIF(r.mls_sold_price, 0), 'mls_status', NULLIF(r.mls_market_status, ''),
      'mls_list_price', NULLIF(r.mls_current_listing_price, 0), 'purchase_info', NULLIF(r.purchase_info, ''),
      'arv_estimate', NULLIF(r.arv_estimate, 0), 'arv_ppsf', NULLIF(r.arv_ppsf, 0), 'percent_off', r.percent_off, 'price_off_value', r.price_off_value,
      'potential_spread', r.potential_spread, 'estimated_repair_cost', NULLIF(r.estimated_repair_cost, 0), 'deal_grade', NULLIF(r.deal_grade, ''),
      'target_margin_percent', r.target_margin_percent, 'comp_confidence_score', r.comp_confidence_score,
      'equity_amount', r.equity_amount, 'equity_percent', r.equity_percent,
      'assessed_total_value', NULLIF(r.assessed_total_value, 0), 'assessed_land_value', NULLIF(r.assessed_land_value, 0),
      'effective_year_built', NULLIF(r.effective_year_built, 0), 'renovation_level', NULLIF(r.renovation_level_classification, ''),
      'construction_type', NULLIF(r.construction_type, ''), 'exterior_walls', NULLIF(r.exterior_walls, ''),
      'county', NULLIF(r.property_address_county_name, ''), 'property_class', NULLIF(r.property_class, ''), 'land_use', NULLIF(r.county_land_use_code, ''),
      'apn', NULLIF(r.apn_parcel_id, ''), 'sqft_range', NULLIF(r.sqft_range, ''), 'year_built_bucket', NULLIF(r.year_built_bucket, ''),
      'owner_mailing', NULLIF(r.owner_address_full, ''), 'owner_mailing_state', NULLIF(r.owner_address_state, ''),
      'buyer_entity_strength', NULLIF(r.buyer_entity_strength, ''), 'buyer_buy_box', NULLIF(r.buyer_buy_box_signal, ''), 'buyer_activity', NULLIF(r.buyer_activity_signal, ''),
      'investor_fit_score', r.investor_fit_score, 'resale_margin_score', r.resale_margin_score
    )) INTO details
    FROM public.recently_sold_properties r WHERE r.id::text = substr(p_comp_id, 3);
  END IF;

  RETURN to_jsonb(c) || jsonb_build_object('portfolio', sib, 'buyer_stats', buyer_stats, 'details', details);
END;
$function$;

-- NOTE deal_market_demand(text,numeric,integer) (Deal Intelligence) still joins the legacy
-- mv_map_sold_comps and reports data_through = 2026-05-08. Re-pointing it is a Deal
-- Intelligence decision, not a Map one; it is deliberately left alone here.
