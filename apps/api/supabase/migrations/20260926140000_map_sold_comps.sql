-- Sold comps for the Map (APPLIED to prod 2026-09-26 via MCP).
--
-- mv_map_sold_comps: one record per sale — MLS + public-record comps
-- (v_recent_sold_comps) and investor purchases (recently_sold_properties) —
-- with the buyer attached and portfolio / institutional buys detected: a buyer
-- recording 2+ properties on one date at ONE price is a portfolio sale (that
-- price is the whole portfolio's; per_door = price / size). 93,854 rows at build.
-- Refresh after comp imports:  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_map_sold_comps;
DROP MATERIALIZED VIEW IF EXISTS public.mv_map_sold_comps;
CREATE MATERIALIZED VIEW public.mv_map_sold_comps AS
WITH rsp AS (
  SELECT r.id::text AS rid, NULLIF(btrim(r.property_id), '') AS property_id,
         COALESCE(NULLIF(btrim(r.buyer_name_clean), ''), NULLIF(btrim(r.buyer_name), ''), NULLIF(btrim(r.owner_name_clean), ''), NULLIF(btrim(r.owner_name), '')) AS buyer,
         r.owner_type, r.out_of_state_owner, r.sale_date, r.sale_price, r.mls_sold_price, r.mls_sold_date,
         r.latitude, r.longitude, r.property_address_full, r.property_address_city, r.property_address_state, r.property_address_zip,
         r.property_type, r.total_bedrooms, r.total_baths, r.building_square_feet, r.year_built, r.units_count, r.estimated_value
  FROM public.recently_sold_properties r
  WHERE r.latitude IS NOT NULL AND r.longitude IS NOT NULL
),
portfolio AS (
  SELECT buyer, sale_date, sale_price, count(*)::int AS n
  FROM rsp WHERE sale_price > 0 AND sale_date IS NOT NULL AND buyer IS NOT NULL
  GROUP BY 1, 2, 3 HAVING count(*) >= 2
),
rsp2 AS (
  SELECT rsp.*, COALESCE(p.n, 1) AS portfolio_size
  FROM rsp LEFT JOIN portfolio p USING (buyer, sale_date, sale_price)
),
best AS (
  SELECT DISTINCT ON (property_id) * FROM rsp2 WHERE property_id IS NOT NULL
  ORDER BY property_id, sale_date DESC NULLS LAST
),
v AS (
  SELECT * FROM public.v_recent_sold_comps WHERE latitude IS NOT NULL AND longitude IS NOT NULL
),
vpids AS (SELECT DISTINCT property_id::text AS property_id FROM v WHERE property_id IS NOT NULL),
unified AS (
  SELECT 'c:' || v.id::text AS comp_id,
         CASE WHEN v.sale_source ILIKE 'MLS%' THEN 'mls' ELSE 'public_record' END AS source,
         COALESCE(v.mls_sold_date, v.sale_date) AS sold_on,
         COALESCE(NULLIF(v.mls_sold_price, 0), NULLIF(v.sale_price, 0)) AS price,
         v.latitude::double precision AS lat, v.longitude::double precision AS lng,
         v.property_id::text AS property_id,
         COALESCE(v.property_address_full, v.property_address) AS address,
         v.property_address_city AS city, v.property_address_state AS state, v.property_address_zip AS zip,
         v.property_type, v.total_bedrooms AS beds, v.total_baths AS baths, v.building_square_feet AS sqft,
         v.year_built::int AS year_built, v.units_count AS units, v.estimated_value, v.streetview_image,
         b.buyer, b.owner_type, b.out_of_state_owner, COALESCE(b.portfolio_size, 1) AS portfolio_size
  FROM v LEFT JOIN best b ON b.property_id = v.property_id::text
  UNION ALL
  SELECT 'r:' || r.rid, 'investor',
         COALESCE(r.mls_sold_date, r.sale_date),
         COALESCE(NULLIF(r.mls_sold_price, 0), NULLIF(r.sale_price, 0)),
         r.latitude::double precision, r.longitude::double precision,
         r.property_id, r.property_address_full, r.property_address_city, r.property_address_state, r.property_address_zip,
         r.property_type, r.total_bedrooms, r.total_baths, r.building_square_feet, r.year_built, r.units_count, r.estimated_value, NULL,
         r.buyer, r.owner_type, r.out_of_state_owner, r.portfolio_size
  FROM rsp2 r LEFT JOIN vpids ON vpids.property_id = r.property_id
  WHERE vpids.property_id IS NULL
)
SELECT u.*,
  CASE
    WHEN u.owner_type = 'Hedgefund' THEN 'hedge_fund'
    WHEN u.buyer ~* '(INVITATION HOMES|AMERICAN HOMES 4 RENT|\mAMH\M|\mAH4R\M|PROGRESS RESIDENTIAL|TRICON|\mSFR\M|FIRSTKEY|MAIN STREET RENEWAL|VINEBROOK|PRETIUM|HOME PARTNERS|AMHERST|CERBERUS|BLACKSTONE|RESICAP|OPENDOOR|OFFERPAD|\mMYND\M|ROOFSTOCK|FRONT YARD|HAVENBROOK|BROOKFIELD|STARWOOD|INVH|FUNDRISE)' THEN 'institutional'
    WHEN u.buyer ~* '(LENNAR|D\.? ?R\.? HORTON|PULTE|\mKB HOME|MERITAGE|TAYLOR MORRISON|CENTEX|\mNVR\M|RYAN HOMES|TOLL BROTHERS|HIGHLAND HOMES|PERRY HOMES|DAVID WEEKLEY|CENTURY COMMUNITIES|LGI HOMES|STARLIGHT HOMES|ASHTON WOODS|CHESMAR|BEAZER|M/I HOMES|DREAM FINDERS|TRI POINTE|SHEA HOMES|WILLIAM LYON|K HOVNANIAN|MATTAMY)' THEN 'builder'
    WHEN u.portfolio_size >= 10 AND COALESCE(u.price, 0) >= 1000000 THEN 'institutional'
    WHEN u.portfolio_size >= 2 THEN 'portfolio'
    WHEN u.owner_type = 'Trust / Estate' THEN 'trust'
    WHEN u.owner_type = 'Bank / Lender' THEN 'bank'
    WHEN u.owner_type = 'Government' THEN 'government'
    WHEN u.owner_type = 'Individual' THEN 'individual'
    WHEN u.owner_type = 'Corporate' OR u.buyer ~* '\m(LLC|L\.L\.C|INC|LP|LLP|LTD|CORP|CORPORATION|HOLDINGS?|PROPERTIES|INVESTMENTS?|CAPITAL|VENTURES|GROUP|PARTNERS|TRUST|REALTY|HOMES)\M' THEN 'llc_investor'
    WHEN u.buyer IS NOT NULL THEN 'individual'
    ELSE 'unknown'
  END AS buyer_class,
  CASE WHEN u.portfolio_size >= 2 AND u.price IS NOT NULL THEN round(u.price / u.portfolio_size) END AS per_door,
  CASE WHEN u.sqft > 0 AND u.price > 0 AND u.portfolio_size < 2 THEN round(u.price / u.sqft) END AS ppsf
FROM unified u
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS mv_map_sold_comps_id ON public.mv_map_sold_comps (comp_id);
CREATE INDEX IF NOT EXISTS mv_map_sold_comps_geo ON public.mv_map_sold_comps (lat, lng);
CREATE INDEX IF NOT EXISTS mv_map_sold_comps_portfolio ON public.mv_map_sold_comps (buyer, sold_on, price) WHERE portfolio_size >= 2;
CREATE INDEX IF NOT EXISTS mv_map_sold_comps_buyer ON public.mv_map_sold_comps (buyer);
REVOKE ALL ON public.mv_map_sold_comps FROM anon;
GRANT SELECT ON public.mv_map_sold_comps TO authenticated, service_role;
REFRESH MATERIALIZED VIEW public.mv_map_sold_comps;

-- Viewport comps: one row per sale from zoom 12.5, grid clusters below.
-- p_filters: {sources:[mls|public_record|investor], classes:[...], min_price, max_price,
--             since:'YYYY-MM-DD', portfolio_only:bool, types:[...], min_beds}
-- Price filters and the returned price are PER-DOOR for portfolio sales.
CREATE OR REPLACE FUNCTION public.get_map_sold_comps(
  p_min_lat double precision, p_min_lng double precision, p_max_lat double precision, p_max_lng double precision,
  p_zoom double precision, p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (comp_id text, lat double precision, lng double precision, price numeric, sold_on date,
               source text, buyer_class text, portfolio_size integer, n integer, institutional integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  g double precision := CASE WHEN p_zoom >= 12.5 THEN 0 WHEN p_zoom >= 11 THEN 0.003 WHEN p_zoom >= 9 THEN 0.012 WHEN p_zoom >= 7 THEN 0.04 WHEN p_zoom >= 5 THEN 0.15 ELSE 0.5 END;
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
$$;

-- One comp in full; for a portfolio sale, the rest of the portfolio; the buyer's record.
CREATE OR REPLACE FUNCTION public.get_map_sold_comp(p_comp_id text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  c public.mv_map_sold_comps%ROWTYPE;
  sib jsonb := NULL;
  buyer_stats jsonb := NULL;
BEGIN
  SELECT * INTO c FROM public.mv_map_sold_comps WHERE comp_id = p_comp_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF c.portfolio_size >= 2 AND c.buyer IS NOT NULL THEN
    SELECT jsonb_agg(jsonb_build_object('comp_id', s.comp_id, 'address', s.address, 'lat', s.lat, 'lng', s.lng, 'type', s.property_type) ORDER BY s.address)
      INTO sib
      FROM (SELECT * FROM public.mv_map_sold_comps s WHERE s.buyer = c.buyer AND s.sold_on IS NOT DISTINCT FROM c.sold_on AND s.price IS NOT DISTINCT FROM c.price AND s.portfolio_size >= 2 LIMIT 60) s;
  END IF;
  IF c.buyer IS NOT NULL THEN
    SELECT jsonb_build_object('purchases', count(*), 'first', min(sold_on), 'last', max(sold_on), 'markets', count(DISTINCT state))
      INTO buyer_stats FROM public.mv_map_sold_comps WHERE buyer = c.buyer;
  END IF;
  RETURN to_jsonb(c) || jsonb_build_object('portfolio', sib, 'buyer_stats', buyer_stats);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_map_sold_comps(double precision, double precision, double precision, double precision, double precision, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_map_sold_comp(text) TO authenticated, service_role;

-- 2026-09-26 (later): buyer_class gains 'builder' (above), buyer median price,
-- and the source record's full detail on get_map_sold_comp. Applied via MCP
-- migration map_sold_comp_details; see that migration for the function body.
