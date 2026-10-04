-- Rollback for PROPOSED_20261004160000_map_bounds_count_numeric.sql: restores the float8 comparison.
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
    AND p.latitude >= p_lat_min
    AND p.latitude <= p_lat_max
    AND p.longitude >= p_lng_min
    AND p.longitude <= p_lng_max
    AND (p_markets IS NULL OR p.market = ANY(p_markets))
    AND (p_states IS NULL OR p.property_address_state = ANY(p_states));
$function$;
