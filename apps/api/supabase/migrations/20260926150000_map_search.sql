-- Map global search + area facts (APPLIED to prod 2026-09-26 via MCP).
-- mv_map_search_areas: every state / market / county / city / ZIP holding
-- properties, with bounds, centre and an outline (concave hull of its
-- properties for ZIP and city, convex above). Refresh after property imports:
--   REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_map_search_areas;
CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_map_search_areas AS
WITH p AS (
  SELECT
    NULLIF(upper(btrim(property_address_state)), '') AS state,
    NULLIF(btrim(market), '') AS market,
    NULLIF(initcap(lower(btrim(COALESCE(property_address_county_name, property_county_name)))), '') AS county,
    NULLIF(initcap(lower(btrim(property_address_city))), '') AS city,
    NULLIF(left(btrim(COALESCE(property_address_zip, property_zip)), 5), '') AS zip,
    latitude::double precision AS lat, longitude::double precision AS lng,
    ST_SetSRID(ST_MakePoint(longitude::double precision, latitude::double precision), 4326) AS pt
  FROM public.properties
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND latitude BETWEEN 15 AND 72 AND longitude BETWEEN -170 AND -60
),
areas AS (
  SELECT 'state'::text AS kind, state AS key, state AS label, state, count(*)::int AS n,
         min(lat) AS min_lat, max(lat) AS max_lat, min(lng) AS min_lng, max(lng) AS max_lng,
         ST_ConvexHull(ST_Collect(pt)) AS hull
  FROM p WHERE state IS NOT NULL GROUP BY state
  UNION ALL
  SELECT 'market', market, market, max(state), count(*)::int, min(lat), max(lat), min(lng), max(lng), ST_ConvexHull(ST_Collect(pt))
  FROM p WHERE market IS NOT NULL AND market <> 'Unknown' GROUP BY market
  UNION ALL
  SELECT 'county', state || ':' || lower(county), county || ' County, ' || state, state, count(*)::int, min(lat), max(lat), min(lng), max(lng), ST_ConvexHull(ST_Collect(pt))
  FROM p WHERE county IS NOT NULL AND state IS NOT NULL GROUP BY state, county
  UNION ALL
  SELECT 'city', state || ':' || lower(city), city || ', ' || state, state, count(*)::int, min(lat), max(lat), min(lng), max(lng),
         CASE WHEN count(*) >= 4 THEN ST_ConcaveHull(ST_Collect(pt), 0.7) ELSE ST_ConvexHull(ST_Collect(pt)) END
  FROM p WHERE city IS NOT NULL AND state IS NOT NULL GROUP BY state, city
  UNION ALL
  SELECT 'zip', zip, zip, max(state), count(*)::int, min(lat), max(lat), min(lng), max(lng),
         CASE WHEN count(*) >= 4 THEN ST_ConcaveHull(ST_Collect(pt), 0.7) ELSE ST_ConvexHull(ST_Collect(pt)) END
  FROM p WHERE zip ~ '^[0-9]{5}$' GROUP BY zip
)
SELECT kind, key, label, state, n, min_lat, max_lat, min_lng, max_lng,
       (min_lat + max_lat) / 2 AS center_lat, (min_lng + max_lng) / 2 AS center_lng,
       ST_AsGeoJSON(ST_SimplifyPreserveTopology(ST_Buffer(hull::geography, 250)::geometry, 0.0015), 5)::jsonb AS outline,
       lower(label) AS search
FROM areas
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS mv_map_search_areas_pk ON public.mv_map_search_areas (kind, key);
CREATE INDEX IF NOT EXISTS mv_map_search_areas_search ON public.mv_map_search_areas USING gin (search gin_trgm_ops);
REVOKE ALL ON public.mv_map_search_areas FROM anon;
GRANT SELECT ON public.mv_map_search_areas TO authenticated, service_role;
REFRESH MATERIALIZED VIEW public.mv_map_search_areas;

-- Search: states (code or full name), markets, counties, cities, ZIPs, and
-- property addresses (trigram) when the query mixes digits and letters.
CREATE OR REPLACE FUNCTION public.map_search(p_q text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  q text := lower(btrim(coalesce(p_q, '')));
  st text;
  areas jsonb;
  props jsonb := '[]'::jsonb;
BEGIN
  IF length(q) < 2 THEN RETURN '[]'::jsonb; END IF;
  SELECT s.code INTO st FROM (VALUES
    ('alabama','AL'),('alaska','AK'),('arizona','AZ'),('arkansas','AR'),('california','CA'),('colorado','CO'),('connecticut','CT'),('delaware','DE'),
    ('florida','FL'),('georgia','GA'),('hawaii','HI'),('idaho','ID'),('illinois','IL'),('indiana','IN'),('iowa','IA'),('kansas','KS'),('kentucky','KY'),
    ('louisiana','LA'),('maine','ME'),('maryland','MD'),('massachusetts','MA'),('michigan','MI'),('minnesota','MN'),('mississippi','MS'),('missouri','MO'),
    ('montana','MT'),('nebraska','NE'),('nevada','NV'),('new hampshire','NH'),('new jersey','NJ'),('new mexico','NM'),('new york','NY'),
    ('north carolina','NC'),('north dakota','ND'),('ohio','OH'),('oklahoma','OK'),('oregon','OR'),('pennsylvania','PA'),('rhode island','RI'),
    ('south carolina','SC'),('south dakota','SD'),('tennessee','TN'),('texas','TX'),('utah','UT'),('vermont','VT'),('virginia','VA'),
    ('washington','WA'),('west virginia','WV'),('wisconsin','WI'),('wyoming','WY'),('district of columbia','DC')
  ) s(name, code) WHERE s.name = q OR lower(s.code) = q LIMIT 1;

  SELECT COALESCE(jsonb_agg(r ORDER BY r.rank, r.n DESC), '[]'::jsonb) INTO areas FROM (
    SELECT a.kind, a.key, a.label, a.state, a.n,
           jsonb_build_array(a.min_lng, a.min_lat, a.max_lng, a.max_lat) AS bbox,
           jsonb_build_array(a.center_lng, a.center_lat) AS center,
           CASE
             WHEN a.kind = 'state' AND a.key = st THEN 0
             WHEN a.search = q THEN 1
             WHEN a.kind = 'zip' AND a.key LIKE q || '%' THEN 2
             WHEN a.search LIKE q || '%' THEN 3
             WHEN a.search LIKE '% ' || q || '%' THEN 4
             ELSE 5
           END + CASE a.kind WHEN 'market' THEN 0 WHEN 'state' THEN 0 WHEN 'city' THEN 0.1 WHEN 'county' THEN 0.2 ELSE 0.3 END AS rank
    FROM public.mv_map_search_areas a
    WHERE (a.kind = 'state' AND a.key = st)
       OR a.search LIKE q || '%'
       OR a.search LIKE '% ' || q || '%'
       OR (length(q) >= 4 AND a.search % q)
    ORDER BY rank, a.n DESC
    LIMIT 8
  ) r;

  IF q ~ '[0-9]' AND q ~ '[a-z]' AND length(q) >= 4 THEN
    SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) INTO props FROM (
      SELECT 'property' AS kind, p.property_id::text AS key, p.property_address_full AS label, p.property_address_state AS state, 1 AS n,
             jsonb_build_array(p.longitude::double precision, p.latitude::double precision) AS center,
             p.property_type AS sub
      FROM public.properties p
      WHERE p.property_address_full ILIKE '%' || q || '%' AND p.latitude IS NOT NULL
      ORDER BY similarity(lower(p.property_address_full), q) DESC
      LIMIT 6
    ) x;
  END IF;

  RETURN props || areas;
END;
$$;

-- Area facts: the property mix, the last 12 months of sales (MLS vs investor,
-- medians — a single $50M portfolio would drown an average), who is buying,
-- and ACS census for the area (a market reads its core city).
CREATE OR REPLACE FUNCTION public.get_map_area_facts(p_kind text, p_key text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$
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
$$;

GRANT EXECUTE ON FUNCTION public.map_search(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_map_area_facts(text, text) TO authenticated, service_role;
