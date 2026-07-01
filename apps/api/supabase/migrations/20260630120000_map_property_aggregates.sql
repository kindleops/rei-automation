-- Canonical map aggregate sources for national/metro property universe representation.
-- SOURCE A: market-level totals (true counts, not paginated viewport samples).

CREATE OR REPLACE FUNCTION public.get_map_market_aggregates(
  p_markets text[] DEFAULT NULL,
  p_states text[] DEFAULT NULL
)
RETURNS TABLE (
  market text,
  state_code text,
  property_count bigint,
  centroid_lat double precision,
  centroid_lng double precision,
  uncontacted_count bigint,
  contacted_count bigint,
  hot_count bigint,
  new_reply_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(NULLIF(TRIM(p.market), ''), 'Unknown') AS market,
    MAX(NULLIF(TRIM(p.property_address_state), '')) AS state_code,
    COUNT(*)::bigint AS property_count,
    AVG(p.latitude::double precision) AS centroid_lat,
    AVG(p.longitude::double precision) AS centroid_lng,
    COUNT(*) FILTER (WHERE COALESCE(p.contact_status, 'uncontacted') IN ('uncontacted', 'not_contacted', ''))::bigint AS uncontacted_count,
    COUNT(*) FILTER (WHERE COALESCE(p.contact_status, '') NOT IN ('uncontacted', 'not_contacted', ''))::bigint AS contacted_count,
    COUNT(*) FILTER (WHERE COALESCE(p.activity_status, '') ILIKE '%hot%')::bigint AS hot_count,
    COUNT(*) FILTER (WHERE COALESCE(p.activity_status, '') ILIKE '%reply%')::bigint AS new_reply_count
  FROM public.properties p
  WHERE p.latitude IS NOT NULL
    AND p.longitude IS NOT NULL
    AND (p_markets IS NULL OR p.market = ANY(p_markets))
    AND (p_states IS NULL OR p.property_address_state = ANY(p_states))
  GROUP BY COALESCE(NULLIF(TRIM(p.market), ''), 'Unknown')
  HAVING COUNT(*) > 0
  ORDER BY property_count DESC;
$$;

-- SOURCE A (regional): spatial grid clusters with true counts for metro zoom.
CREATE OR REPLACE FUNCTION public.get_map_spatial_clusters(
  p_lat_min double precision,
  p_lat_max double precision,
  p_lng_min double precision,
  p_lng_max double precision,
  p_grid_degrees double precision DEFAULT 0.25
)
RETURNS TABLE (
  cluster_key text,
  property_count bigint,
  centroid_lat double precision,
  centroid_lng double precision,
  market text,
  uncontacted_count bigint,
  hot_count bigint,
  new_reply_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH grid AS (
    SELECT
      p.*,
      FLOOR(p.latitude::numeric / p_grid_degrees) AS grid_lat,
      FLOOR(p.longitude::numeric / p_grid_degrees) AS grid_lng
    FROM public.properties p
    WHERE p.latitude IS NOT NULL
      AND p.longitude IS NOT NULL
      AND p.latitude >= p_lat_min
      AND p.latitude <= p_lat_max
      AND p.longitude >= p_lng_min
      AND p.longitude <= p_lng_max
  )
  SELECT
    grid_lat::text || ':' || grid_lng::text AS cluster_key,
    COUNT(*)::bigint AS property_count,
    AVG(latitude::double precision) AS centroid_lat,
    AVG(longitude::double precision) AS centroid_lng,
    MODE() WITHIN GROUP (ORDER BY market) AS market,
    COUNT(*) FILTER (WHERE COALESCE(contact_status, 'uncontacted') IN ('uncontacted', 'not_contacted', ''))::bigint AS uncontacted_count,
    COUNT(*) FILTER (WHERE COALESCE(activity_status, '') ILIKE '%hot%')::bigint AS hot_count,
    COUNT(*) FILTER (WHERE COALESCE(activity_status, '') ILIKE '%reply%')::bigint AS new_reply_count
  FROM grid
  GROUP BY grid_lat, grid_lng
  HAVING COUNT(*) > 0;
$$;

-- Exact in-bounds count (for cluster accounting assertions).
CREATE OR REPLACE FUNCTION public.get_map_bounds_property_count(
  p_lat_min double precision,
  p_lat_max double precision,
  p_lng_min double precision,
  p_lng_max double precision,
  p_markets text[] DEFAULT NULL,
  p_states text[] DEFAULT NULL
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::bigint
  FROM public.properties p
  WHERE p.latitude IS NOT NULL
    AND p.longitude IS NOT NULL
    AND p.latitude >= p_lat_min
    AND p.latitude <= p_lat_max
    AND p.longitude >= p_lng_min
    AND p.longitude <= p_lng_max
    AND (p_markets IS NULL OR p.market = ANY(p_markets))
    AND (p_states IS NULL OR p.property_address_state = ANY(p_states));
$$;

GRANT EXECUTE ON FUNCTION public.get_map_market_aggregates(text[], text[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_map_spatial_clusters(double precision, double precision, double precision, double precision, double precision) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_map_bounds_property_count(double precision, double precision, double precision, double precision, text[], text[]) TO authenticated, service_role;