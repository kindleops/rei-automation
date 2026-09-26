-- Same features, same attributes; a lat/lng bbox prefilter (tile envelope +
-- the 64/4096 MVT buffer) lets the (latitude, longitude) btree index replace a
-- full-table ST_Transform scan: 4.4s -> 70ms per z11 tile. Timeouts under load
-- returned 500s that MapLibre never retried (holes of missing properties).
-- Verified: identical row count (496) for tile 11/479/846 before and after.
-- APPLIED to prod 2026-09-26 via MCP apply_migration.
CREATE OR REPLACE FUNCTION public.get_property_map_vector_tile(z integer, x integer, y integer)
 RETURNS bytea
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  env geometry := ST_TileEnvelope(z, x, y);
  env4326 geometry := ST_Transform(ST_TileEnvelope(z, x, y, margin => 64.0 / 4096), 4326);
  lat0 numeric := ST_YMin(env4326)::numeric;
  lat1 numeric := ST_YMax(env4326)::numeric;
  lng0 numeric := ST_XMin(env4326)::numeric;
  lng1 numeric := ST_XMax(env4326)::numeric;
  result bytea;
BEGIN
  SELECT ST_AsMVT(mvt_source, 'properties', 4096, 'geom') INTO result
  FROM (
    SELECT
      p.property_id::text AS property_id,
      public.resolve_property_marker_key_sql(p.property_type, p.asset_type, p.units_count, p.multifamily_units) AS marker_key,
      COALESCE(NULLIF(TRIM(p.market), ''), 'Unknown') AS market,
      COALESCE(p.contact_status, 'uncontacted') AS contact_status,
      COALESCE(p.activity_status, '') AS activity_status,
      COALESCE(p.final_acquisition_score, 0)::integer AS acquisition_score,
      ST_AsMVTGeom(
        ST_Transform(ST_SetSRID(ST_MakePoint(p.longitude::double precision, p.latitude::double precision), 4326), 3857),
        env, 4096, 64, true
      ) AS geom
    FROM public.properties p
    WHERE p.latitude BETWEEN lat0 AND lat1
      AND p.longitude BETWEEN lng0 AND lng1
      AND ST_Intersects(
        ST_Transform(ST_SetSRID(ST_MakePoint(p.longitude::double precision, p.latitude::double precision), 4326), 3857),
        env
      )
  ) mvt_source
  WHERE geom IS NOT NULL;
  RETURN result;
END;
$function$;
