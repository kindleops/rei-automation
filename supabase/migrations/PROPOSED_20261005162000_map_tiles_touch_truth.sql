-- =============================================================================
-- Map tiles carry the canonical touch truth, not the legacy properties.contact_status.
-- STATUS: PROPOSED · OWNER-APPROVED 2026-10-05 for apply at/after 12:00 UTC (7 AM CT) · NOT APPLIED.
-- Pretest:  PROPOSED_20261005162000_map_tiles_touch_truth_pretest.sql (rollback-only)
-- Rollback: PROPOSED_20261005162000_map_tiles_touch_truth_rollback.sql (2026-10-05 bodies, byte for byte)
--
-- APPLY ORDER: AFTER 20261005160000 (covering index) and 20261005161000
-- (property_ever_contacted, backfilled). These bodies reference
-- tg.property_ever_contacted, so applying them before the column exists fails
-- at the first tile request.
-- APPLY METHOD: MCP apply_migration (one transaction; CREATE OR REPLACE FUNCTION
-- does not block tile readers).
--
-- WHY: properties.contact_status is only 'No Contact' (121,182) or NULL (48,620).
--   * get_property_map_vector_tile emitted COALESCE(contact_status,'uncontacted').
--     The tile style (map-property-tile-integration.ts) rings anything not in
--     ('uncontacted','not_contacted','') as CONTACTED, so 71% of pins drew as contacted.
--   * get_property_map_dot_tile excluded 'No Contact' too, so contacted was always 0.
-- NOW: contacted = a graph row with (never_contacted IS FALSE) OR property_ever_contacted,
--   i.e. phone history OR property history (owner option B: a property already
--   touched stays touched when its best phone changes). It is the same predicate
--   as the Map filter buckets with MAP_TOUCH_PROPERTY_LEVEL=1. The attribute name
--   and the 'contacted'/'uncontacted' values are unchanged, so no client change.
-- COST: one property_id probe per feature, served by idx_ctg_property_touch_phone and
--   idx_ctg_property_ever_contacted. The pretest reports the before/after tile time.
--   Budget: ≤ the old time + 20 %.
-- Signatures, volatility, SECURITY DEFINER, search_path and grants are unchanged.
-- =============================================================================

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
      CASE WHEN touch.contacted IS TRUE THEN 'contacted' ELSE 'uncontacted' END AS contact_status,
      COALESCE(p.activity_status, '') AS activity_status,
      COALESCE(p.final_acquisition_score, 0)::integer AS acquisition_score,
      ST_AsMVTGeom(
        ST_Transform(ST_SetSRID(ST_MakePoint(p.longitude::double precision, p.latitude::double precision), 4326), 3857),
        env, 4096, 64, true
      ) AS geom
    FROM public.properties p
    LEFT JOIN LATERAL (
      SELECT bool_or(tg.never_contacted IS FALSE OR tg.property_ever_contacted) AS contacted
      FROM public.campaign_target_graph tg
      WHERE tg.property_id = p.property_id
    ) touch ON TRUE
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
           count(*) FILTER (WHERE touched)::integer AS contacted,
           count(*) FILTER (WHERE COALESCE(activity_status, '') ILIKE '%hot%')::integer AS hot,
           max(COALESCE(final_acquisition_score, 0))::integer AS score,
           CASE WHEN count(*) = 1 THEN min(property_id::text) END AS property_id
    FROM (
      SELECT p.property_id, p.activity_status, p.final_acquisition_score,
             EXISTS (SELECT 1 FROM public.campaign_target_graph tg
                     WHERE tg.property_id = p.property_id
                       AND (tg.never_contacted IS FALSE OR tg.property_ever_contacted)) AS touched,
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
