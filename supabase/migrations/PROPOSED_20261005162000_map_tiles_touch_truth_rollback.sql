-- ROLLBACK for PROPOSED_20261005162000_map_tiles_touch_truth.sql
-- Restores both tile functions exactly as captured from prod with pg_get_functiondef on 2026-10-05.
-- APPLY METHOD: MCP apply_migration (one transaction). Readers are not blocked.
-- Effect: tiles go back to the legacy contact_status: the vector tile draws 'No Contact' as
-- contacted, and the dot tile's contacted count is always 0.
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
$function$
;

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
$function$
;
