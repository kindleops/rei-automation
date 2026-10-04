-- PROPOSED (not applied). RC 8.4 visual QA, 2026-10-04.
--
-- get_map_bounds_property_count takes double precision bounds but properties.latitude /
-- longitude are NUMERIC, so `p.latitude >= p_lat_min` resolves to `latitude::float8 >= $1`
-- and the bbox is never an Index Cond: the whole idx_properties_map_lens_cover is scanned
-- as a filter (280-310 ms warm, 8.3 s cold; authenticator statement_timeout = 8s).
-- Casting the PARAMETERS (not the columns) to numeric restores the range probe:
-- Index Only Scan, 0 heap fetches, ~1-5 ms. Same signature, same predicate, same result.
-- The API no longer calls this RPC (apps/api/src/lib/domain/map/map-bounds-counts.js);
-- this keeps any other caller from hitting the same trap. Same class as 20261002120000.
--
-- Pretest (read-only): the two must return the same number for any bbox:
--   select public.get_map_bounds_property_count(44.95,45.0,-93.30,-93.20,null,null);
--   select count(*) from public.properties where latitude is not null and longitude is not null
--     and latitude between 44.95 and 45.0 and longitude between -93.30 and -93.20;

CREATE OR REPLACE FUNCTION public.get_map_bounds_property_count(
  p_lat_min double precision,
  p_lat_max double precision,
  p_lng_min double precision,
  p_lng_max double precision,
  p_markets text[] DEFAULT NULL::text[],
  p_states text[] DEFAULT NULL::text[]
)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COUNT(*)::bigint
  FROM public.properties p
  WHERE p.latitude IS NOT NULL
    AND p.longitude IS NOT NULL
    AND p.latitude >= p_lat_min::numeric
    AND p.latitude <= p_lat_max::numeric
    AND p.longitude >= p_lng_min::numeric
    AND p.longitude <= p_lng_max::numeric
    AND (p_markets IS NULL OR p.market = ANY(p_markets))
    AND (p_states IS NULL OR p.property_address_state = ANY(p_states));
$function$;
