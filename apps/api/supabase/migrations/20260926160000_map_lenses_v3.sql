-- Lenses v3 (APPLIED to prod 2026-09-26 via MCP): more census (population,
-- owner share, 2-4 / 5+ unit share), dispositions (investor / institutional
-- buying, MLS and investor price per door from mv_map_sold_comps), and
-- get_map_lens_areas: each ZIP / county / state FILLED with its value (outline
-- = the area's property hull from mv_map_search_areas) instead of a blurred dot.
CREATE OR REPLACE FUNCTION public.get_map_lens_points(
  p_lens text,
  p_min_lat double precision,
  p_min_lng double precision,
  p_max_lat double precision,
  p_max_lng double precision,
  p_zoom double precision
)
RETURNS TABLE (lat double precision, lng double precision, v double precision, n integer, id text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- ── Property lenses ────────────────────────────────────────────────────
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
      WHERE pr.latitude BETWEEN p_min_lat AND p_max_lat
        AND pr.longitude BETWEEN p_min_lng AND p_max_lng
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

  -- ── Census (ACS) ──────────────────────────────────────────────────────
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

  -- ── Sold comps / dispositions (mv_map_sold_comps; portfolio sales per door)
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
      FROM public.mv_map_sold_comps m
      WHERE m.lat BETWEEN p_min_lat AND p_max_lat
        AND m.lng BETWEEN p_min_lng AND p_max_lng
        AND m.sold_on >= current_date - 730
        AND CASE p_lens
              WHEN 'mls_price' THEN m.source = 'mls'
              WHEN 'investor_price' THEN (m.source = 'investor' OR m.buyer_class IN ('institutional', 'hedge_fund', 'portfolio', 'llc_investor'))
              WHEN 'investor_buys' THEN (m.source = 'investor' OR m.buyer_class IN ('institutional', 'hedge_fund', 'portfolio', 'llc_investor'))
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

  -- ── Outreach (last 14 days): 1 delivered · 0.6 sent · 0.3 scheduled · 0 failed
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
      AND pr.latitude BETWEEN p_min_lat AND p_max_lat
      AND pr.longitude BETWEEN p_min_lng AND p_max_lng
    LIMIT 5000;
    RETURN;
  END IF;
END;
$$;


CREATE OR REPLACE FUNCTION public.get_map_lens_areas(
  p_lens text,
  p_min_lat double precision, p_min_lng double precision, p_max_lat double precision, p_max_lng double precision,
  p_zoom double precision)
RETURNS TABLE (key text, v double precision, n integer, outline jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  lvl text := CASE WHEN p_zoom >= 7 THEN 'zip' WHEN p_zoom >= 4.6 THEN 'county' ELSE 'state' END;
  is_prop boolean := p_lens IN ('equity', 'value', 'year_built', 'motivation', 'distress', 'tax_delinquent', 'free_clear', 'properties');
  is_comp boolean := p_lens IN ('comps_price', 'comps_ppsf', 'mls_price', 'investor_price', 'investor_buys', 'institutional_buys');
BEGIN
  IF is_comp AND lvl = 'county' THEN lvl := 'zip'; END IF;

  IF is_prop THEN
    RETURN QUERY
    WITH pp AS (
      SELECT
        CASE lvl
          WHEN 'zip' THEN left(btrim(COALESCE(pr.property_address_zip, pr.property_zip)), 5)
          WHEN 'county' THEN upper(btrim(pr.property_address_state)) || ':' || lower(btrim(COALESCE(pr.property_address_county_name, pr.property_county_name)))
          ELSE upper(btrim(pr.property_address_state))
        END AS k,
        CASE p_lens
          WHEN 'equity' THEN pr.equity_percent::double precision
          WHEN 'value' THEN NULLIF(pr.estimated_value, 0)::double precision
          WHEN 'year_built' THEN NULLIF(pr.year_built, 0)::double precision
          WHEN 'motivation' THEN pr.structured_motivation_score::double precision
          WHEN 'distress' THEN pr.tag_distress_score::double precision
          WHEN 'tax_delinquent' THEN CASE WHEN pr.tax_delinquent THEN 1 ELSE 0 END::double precision
          WHEN 'free_clear' THEN CASE WHEN COALESCE(pr.total_loan_balance, 0) = 0 THEN 1 ELSE 0 END::double precision
          ELSE 1::double precision
        END AS val
      FROM public.properties pr
      WHERE pr.latitude BETWEEN p_min_lat AND p_max_lat AND pr.longitude BETWEEN p_min_lng AND p_max_lng
    ), agg AS (
      SELECT k, CASE WHEN p_lens = 'properties' THEN count(*)::double precision ELSE avg(val) END AS v, count(*)::int AS n
      FROM pp WHERE k IS NOT NULL AND val IS NOT NULL GROUP BY k
    )
    SELECT agg.k, agg.v, agg.n, a.outline
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
      SELECT k, CASE WHEN p_lens IN ('investor_buys', 'institutional_buys') THEN count(*)::double precision ELSE percentile_cont(0.5) WITHIN GROUP (ORDER BY val) END AS v, count(*)::int AS n
      FROM cc WHERE k IS NOT NULL AND val > 0 GROUP BY k
    )
    SELECT agg.k, agg.v, agg.n, a.outline
    FROM agg JOIN public.mv_map_search_areas a ON a.kind = lvl AND a.key = agg.k;
    RETURN;
  END IF;

  -- Census / market cells, joined to the area outlines by geo_id.
  RETURN QUERY
  WITH aa AS (
    SELECT a.key AS k, a.outline,
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
    END)::double precision AS v,
    1, aa.outline
  FROM aa;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_map_lens_points(text, double precision, double precision, double precision, double precision, double precision) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_map_lens_areas(text, double precision, double precision, double precision, double precision, double precision) TO authenticated, service_role;
