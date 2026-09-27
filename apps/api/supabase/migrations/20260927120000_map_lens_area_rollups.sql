-- Map lens AREAS that fit the 8s role timeout at every zoom.
--
-- get_map_lens_areas aggregated public.properties inside the viewport on every
-- camera stop: at metro zoom that is tens of thousands of rows, nationally all
-- ~170k, and the call timed out — "Areas doesn't work for Territory,
-- Opportunity, Equity, Distress". Property lenses now read a per-area rollup
-- (ZIP / county / state, same keys as mv_map_search_areas) and only touch the
-- areas whose outline intersects the viewport. Execution Live gets an areas
-- branch too (live, send_queue last 14 days — a few hundred rows).
--
-- Refresh after a property import:  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_map_property_area_stats;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_map_property_area_stats AS
WITH p AS (
  SELECT
    left(btrim(COALESCE(pr.property_address_zip, pr.property_zip)), 5) AS zip_key,
    upper(btrim(pr.property_address_state)) || ':' || lower(btrim(COALESCE(pr.property_address_county_name, pr.property_county_name))) AS county_key,
    upper(btrim(pr.property_address_state)) AS state_key,
    pr.equity_percent::double precision AS equity,
    NULLIF(pr.estimated_value, 0)::double precision AS value,
    NULLIF(pr.year_built, 0)::double precision AS year_built,
    pr.structured_motivation_score::double precision AS motivation,
    pr.tag_distress_score::double precision AS distress,
    CASE WHEN pr.tax_delinquent THEN 1 ELSE 0 END::double precision AS tax_delinquent,
    CASE WHEN COALESCE(pr.total_loan_balance, 0) = 0 THEN 1 ELSE 0 END::double precision AS free_clear
  FROM public.properties pr
  WHERE pr.latitude IS NOT NULL AND pr.longitude IS NOT NULL
), u AS (
  SELECT 'zip'::text AS kind, zip_key AS key, * FROM p WHERE zip_key IS NOT NULL AND zip_key <> ''
  UNION ALL
  SELECT 'county', county_key, * FROM p WHERE county_key IS NOT NULL
  UNION ALL
  SELECT 'state', state_key, * FROM p WHERE state_key IS NOT NULL AND state_key <> ''
)
SELECT kind, key,
  count(*)::int AS n,
  avg(equity) AS equity, avg(value) AS value, avg(year_built) AS year_built,
  avg(motivation) AS motivation, avg(distress) AS distress,
  avg(tax_delinquent) AS tax_delinquent, avg(free_clear) AS free_clear
FROM u
GROUP BY kind, key
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS mv_map_property_area_stats_pk ON public.mv_map_property_area_stats (kind, key);
REFRESH MATERIALIZED VIEW public.mv_map_property_area_stats;
GRANT SELECT ON public.mv_map_property_area_stats TO authenticated, service_role;

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
        AND pr.latitude BETWEEN p_min_lat AND p_max_lat
        AND pr.longitude BETWEEN p_min_lng AND p_max_lng
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
      FROM public.mv_map_sold_comps m
      WHERE m.lat BETWEEN p_min_lat AND p_max_lat AND m.lng BETWEEN p_min_lng AND p_max_lng
        AND m.sold_on >= current_date - 730
        AND CASE p_lens
              WHEN 'mls_price' THEN m.source = 'mls'
              WHEN 'investor_price' THEN (m.source = 'investor' OR m.buyer_class IN ('institutional', 'hedge_fund', 'portfolio', 'llc_investor'))
              WHEN 'investor_buys' THEN (m.source = 'investor' OR m.buyer_class IN ('institutional', 'hedge_fund', 'portfolio', 'llc_investor'))
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
