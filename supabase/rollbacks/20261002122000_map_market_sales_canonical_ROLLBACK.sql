-- ROLLBACK for 20261002122000_map_market_sales_canonical.sql
-- Re-points the six Map RPCs at the legacy public.mv_map_sold_comps. get_map_lens_points and
-- get_map_lens_areas go back to their 20261002120000 versions (bbox fix kept); the other four go
-- back to their live definitions captured read-only on 2026-10-02. Then unschedules the jobs
-- and drops the new objects. Roll back 20261002120000 separately if needed.
select cron.unschedule('refresh_map_market_sales') where exists (select 1 from cron.job where jobname = 'refresh_map_market_sales');
select cron.unschedule('vacuum_map_market_sales') where exists (select 1 from cron.job where jobname = 'vacuum_map_market_sales');

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
    SELECT c.* FROM public.mv_map_sold_comps c
    WHERE c.lat BETWEEN p_min_lat AND p_max_lat AND c.lng BETWEEN p_min_lng AND p_max_lng
      AND (f_sources IS NULL OR c.source = ANY(f_sources))
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
  FROM public.mv_map_sold_comps c
  WHERE c.lat BETWEEN p_min_lat AND p_max_lat AND c.lng BETWEEN p_min_lng AND p_max_lng
    AND (f_sources IS NULL OR c.source = ANY(f_sources))
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
    WHERE p.latitude BETWEEN a.min_lat AND a.max_lat AND p.longitude BETWEEN a.min_lng AND a.max_lng
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
    SELECT m.*, (m.source = 'investor' OR m.buyer_class IN ('institutional', 'hedge_fund', 'portfolio', 'llc_investor')) AS is_investor
    FROM public.mv_map_sold_comps m
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
    FROM public.mv_map_sold_comps m
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
  c public.mv_map_sold_comps%ROWTYPE;
  sib jsonb := NULL;
  buyer_stats jsonb := NULL;
  details jsonb := NULL;
BEGIN
  SELECT * INTO c FROM public.mv_map_sold_comps WHERE comp_id = p_comp_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF c.portfolio_size >= 2 AND c.buyer IS NOT NULL THEN
    SELECT jsonb_agg(jsonb_build_object('comp_id', s.comp_id, 'address', s.address, 'lat', s.lat, 'lng', s.lng, 'type', s.property_type) ORDER BY s.address)
      INTO sib
      FROM (SELECT * FROM public.mv_map_sold_comps s WHERE s.buyer = c.buyer AND s.sold_on IS NOT DISTINCT FROM c.sold_on AND s.price IS NOT DISTINCT FROM c.price AND s.portfolio_size >= 2 LIMIT 60) s;
  END IF;
  IF c.buyer IS NOT NULL THEN
    SELECT jsonb_build_object('purchases', count(*), 'first', min(sold_on), 'last', max(sold_on), 'markets', count(DISTINCT state),
                              'median_price', percentile_cont(0.5) WITHIN GROUP (ORDER BY COALESCE(per_door, price)))
      INTO buyer_stats FROM public.mv_map_sold_comps WHERE buyer = c.buyer;
  END IF;

  -- Everything the source record knows, blanks dropped.
  IF left(p_comp_id, 2) = 'c:' THEN
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

drop function if exists public.refresh_map_market_sales();
drop materialized view if exists public.mv_map_market_sales;
