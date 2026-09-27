-- Every property as a dot below property-pin zoom ("Every property" map option).
-- Points snapped to the tile grid (extent 512 below z8, 1024 above) and merged
-- per pixel; `n` keeps the true count. APPLIED to prod 2026-09-26 via MCP.
CREATE OR REPLACE FUNCTION public.get_property_map_dot_tile(z integer, x integer, y integer)
RETURNS bytea
LANGUAGE plpgsql
STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  env geometry := ST_TileEnvelope(z, x, y);
  env4326 geometry := ST_Transform(ST_TileEnvelope(z, x, y, margin => 8.0 / 512), 4326);
  lat0 numeric := ST_YMin(env4326)::numeric;
  lat1 numeric := ST_YMax(env4326)::numeric;
  lng0 numeric := ST_XMin(env4326)::numeric;
  lng1 numeric := ST_XMax(env4326)::numeric;
  ext integer := CASE WHEN z >= 8 THEN 1024 ELSE 512 END;
  result bytea;
BEGIN
  IF z < 2 OR z > 14 THEN RETURN NULL; END IF;
  SELECT ST_AsMVT(t, 'dots', ext, 'geom') INTO result
  FROM (
    SELECT g AS geom,
           count(*)::integer AS n,
           count(*) FILTER (WHERE COALESCE(contact_status, 'uncontacted') NOT IN ('uncontacted', 'not_contacted', '', 'No Contact'))::integer AS contacted,
           count(*) FILTER (WHERE COALESCE(activity_status, '') ILIKE '%hot%')::integer AS hot,
           max(COALESCE(final_acquisition_score, 0))::integer AS score,
           CASE WHEN count(*) = 1 THEN min(property_id::text) END AS property_id
    FROM (
      SELECT p.property_id, p.contact_status, p.activity_status, p.final_acquisition_score,
             ST_AsMVTGeom(ST_Transform(ST_SetSRID(ST_MakePoint(p.longitude::double precision, p.latitude::double precision), 4326), 3857), env, ext, 8, true) AS g
      FROM public.properties p
      WHERE p.latitude BETWEEN lat0 AND lat1
        AND p.longitude BETWEEN lng0 AND lng1
    ) s
    WHERE g IS NOT NULL
    GROUP BY g
  ) t;
  RETURN result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_property_map_dot_tile(integer, integer, integer) TO authenticated, service_role;
