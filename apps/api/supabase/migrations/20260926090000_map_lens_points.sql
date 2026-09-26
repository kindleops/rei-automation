-- ════════════════════════════════════════════════════════════════════════════
-- Map intelligence lenses — one read-only source for every heat / point layer.
--
-- The mobile Map's modes drew nothing because the layers they toggled read
-- sources that were empty (census_geo_metrics = 0 rows, buyer_activity_geo_
-- rollups = 0 rows) or thread-scoped. The data exists elsewhere:
--   properties                              ~170k, equity / value / loan /
--                                           year built / motivation / distress
--   exchange_market_fundamentals_cells      ACS: income, rent, vacancy, renter
--                                           share, median year built, burden
--   exchange_rent_benchmark_cells           HUD small-area FMR (2BR)
--   exchange_trend_hpi_cells                FHFA HPI appreciation (5Y)
--   exchange_flood_exposure_cells           FEMA SFHA share
--   exchange_market_ownership_cells         tax-delinquent / foreclosure share
--   v_recent_sold_comps                     ~48k sold comps
--   send_queue                              outreach, last 14 days
--
-- Returns (lat, lng, v, n, id): a value per point. Property lenses aggregate
-- onto a zoom-sized grid (avg v, count n) and return individual properties
-- (id = property_id) from zoom 13. Market lenses pick the geography level
-- that fits the zoom. Nothing is scored or invented here — v is the stored
-- field, and the client maps it to colour with a fixed, labelled domain.
-- ════════════════════════════════════════════════════════════════════════════

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
  IF p_lens IN ('census_income', 'census_rent', 'census_vacancy', 'census_renter', 'census_year_built', 'census_rent_burden', 'census_population') THEN
    RETURN QUERY
    SELECT c.centroid_lat::double precision, c.centroid_lng::double precision,
      (CASE p_lens
        WHEN 'census_income' THEN c.median_household_income
        WHEN 'census_rent' THEN c.median_gross_rent
        WHEN 'census_vacancy' THEN c.vacancy_rate
        WHEN 'census_renter' THEN c.renter_share
        WHEN 'census_year_built' THEN c.median_year_built
        WHEN 'census_rent_burden' THEN c.rent_burden
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

  -- ── Sold comps ────────────────────────────────────────────────────────
  IF p_lens IN ('comps_price', 'comps_ppsf') THEN
    RETURN QUERY
    WITH src AS (
      SELECT sc.latitude::double precision AS la, sc.longitude::double precision AS lo,
        (CASE WHEN p_lens = 'comps_ppsf' THEN sc.computed_ppsf ELSE sc.sale_price END)::double precision AS val,
        sc.property_id::text AS pid
      FROM public.v_recent_sold_comps sc
      WHERE sc.latitude BETWEEN p_min_lat AND p_max_lat
        AND sc.longitude BETWEEN p_min_lng AND p_max_lng
    )
    SELECT * FROM (SELECT s.la, s.lo, s.val, 1, s.pid FROM src s WHERE g = 0 AND s.val IS NOT NULL LIMIT 8000) pts
    UNION ALL
    SELECT avg(s.la), avg(s.lo), avg(s.val), count(*)::integer, NULL::text
    FROM src s WHERE g > 0 AND s.val IS NOT NULL
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

GRANT EXECUTE ON FUNCTION public.get_map_lens_points(text, double precision, double precision, double precision, double precision, double precision) TO anon, authenticated, service_role;

-- ── Market panel: everything we know about the area at a point ───────────
CREATE OR REPLACE FUNCTION public.get_map_area_intel(p_lat double precision, p_lng double precision)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  z record;
BEGIN
  SELECT c.* INTO z
  FROM public.exchange_market_fundamentals_cells c
  WHERE c.geo_level = 'zip5'
    AND c.centroid_lat BETWEEN p_lat - 0.5 AND p_lat + 0.5
    AND c.centroid_lng BETWEEN p_lng - 0.5 AND p_lng + 0.5
  ORDER BY (c.centroid_lat - p_lat) ^ 2 + (c.centroid_lng - p_lng) ^ 2
  LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'geo_id', z.geo_id,
    'zip', right(z.geo_id, 5),
    'name', z.geo_name,
    'city', z.city_name,
    'state', z.state_code,
    'population', z.population,
    'median_household_income', z.median_household_income,
    'median_gross_rent', z.median_gross_rent,
    'vacancy_rate', z.vacancy_rate,
    'renter_share', z.renter_share,
    'median_year_built', z.median_year_built,
    'rent_burden', z.rent_burden,
    'vintage', z.vintage,
    'fmr_2br', (SELECT r.amount_usd FROM public.exchange_rent_benchmark_cells r WHERE r.geo_id = z.geo_id AND r.bedroom_count = 2 LIMIT 1),
    'hpi_5y', (SELECT h.appreciation FROM public.exchange_trend_hpi_cells h WHERE h.geo_id = z.geo_id AND h.window_key = '5Y' LIMIT 1),
    'hpi_1y', (SELECT h.appreciation FROM public.exchange_trend_hpi_cells h WHERE h.geo_id = z.geo_id AND h.window_key = '1Y' LIMIT 1),
    'flood_sfha_share', (SELECT f.sfha_share FROM public.exchange_flood_exposure_cells f WHERE f.geo_id = z.geo_id LIMIT 1)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_map_area_intel(double precision, double precision) TO anon, authenticated, service_role;

-- ── Draw-to-select: what is inside a drawn shape ──────────────────────────
-- p_ring: GeoJSON-style [[lng, lat], ...] ring (closed or not). Read-only.
CREATE OR REPLACE FUNCTION public.get_map_area_summary(p_ring jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  poly geometry;
  pts jsonb;
  bb record;
  result jsonb;
BEGIN
  IF p_ring IS NULL OR jsonb_array_length(p_ring) < 3 THEN RETURN NULL; END IF;
  pts := p_ring;
  IF (pts -> 0) <> (pts -> (jsonb_array_length(pts) - 1)) THEN
    pts := pts || jsonb_build_array(pts -> 0);
  END IF;
  poly := ST_SetSRID(ST_GeomFromGeoJSON(jsonb_build_object('type', 'Polygon', 'coordinates', jsonb_build_array(pts))::text), 4326);
  IF NOT ST_IsValid(poly) THEN poly := ST_MakeValid(poly); END IF;
  SELECT ST_XMin(poly) x0, ST_YMin(poly) y0, ST_XMax(poly) x1, ST_YMax(poly) y1 INTO bb;

  WITH inside AS (
    SELECT p.*
    FROM public.properties p
    WHERE p.latitude BETWEEN bb.y0 AND bb.y1
      AND p.longitude BETWEEN bb.x0 AND bb.x1
      AND ST_Contains(poly, ST_SetSRID(ST_MakePoint(p.longitude::double precision, p.latitude::double precision), 4326))
  ),
  contacted AS (
    SELECT DISTINCT sq.property_id::text AS pid FROM public.send_queue sq
    WHERE sq.property_id::text IN (SELECT property_id::text FROM inside)
  )
  SELECT jsonb_build_object(
    'count', (SELECT count(*) FROM inside),
    'avg_equity_pct', (SELECT round(avg(equity_percent)::numeric, 1) FROM inside),
    'median_value', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY estimated_value) FROM inside WHERE estimated_value > 0),
    'total_value', (SELECT sum(estimated_value) FROM inside WHERE estimated_value > 0),
    'median_year_built', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY year_built) FROM inside WHERE year_built > 0),
    'avg_motivation', (SELECT round(avg(structured_motivation_score)::numeric, 0) FROM inside),
    'tax_delinquent', (SELECT count(*) FROM inside WHERE tax_delinquent),
    'free_clear', (SELECT count(*) FROM inside WHERE COALESCE(total_loan_balance, 0) = 0),
    'contacted', (SELECT count(*) FROM contacted),
    'types', (SELECT COALESCE(jsonb_agg(t ORDER BY t.n DESC), '[]'::jsonb) FROM (
                SELECT COALESCE(NULLIF(property_type, ''), 'Unknown') AS type, count(*) AS n FROM inside GROUP BY 1 ORDER BY 2 DESC LIMIT 6) t),
    'markets', (SELECT COALESCE(jsonb_agg(m ORDER BY m.n DESC), '[]'::jsonb) FROM (
                SELECT COALESCE(NULLIF(market, ''), 'Unknown') AS market, count(*) AS n FROM inside GROUP BY 1 ORDER BY 2 DESC LIMIT 4) m),
    'property_ids', (SELECT COALESCE(jsonb_agg(property_id::text), '[]'::jsonb) FROM (SELECT property_id FROM inside LIMIT 5000) i)
  ) INTO result;
  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_map_area_summary(jsonb) TO anon, authenticated, service_role;
