-- PRETEST for PROPOSED_20261005162000_map_tiles_touch_truth.sql. ROLLBACK-ONLY.
-- The RAISE at the end undoes the function replacement. Expected result:
--   ERROR:  pretest ok: ...     and the old functions still in place afterwards.
-- Requires 20261005161000 applied (the column exists). Run at/after 12:00 UTC:
--   SET statement_timeout = '120s';
-- Tiles: z14 Dallas (3786/6611), plus the z14 tile around the touched property with the most
-- touched neighbours, and a z10 dot tile around it.
-- Reports: old/new byte sizes, old/new ms, and expected contacted counts straight from SQL.
-- Pass criteria: new ms ≤ old ms × 1.2 + 50, and the new size is non-null where the old was.
DO $pretest$
DECLARE
  tz int := 14; tx int; ty int; dx int; dy int;
  lat double precision; lng double precision;
  b_old bytea; b_new bytea; d_old bytea; d_new bytea; dal_old bytea; dal_new bytea;
  t0 timestamptz; ms_old numeric; ms_new numeric; dms_old numeric; dms_new numeric;
  exp_touched int; exp_total int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                 AND table_name = 'campaign_target_graph' AND column_name = 'property_ever_contacted') THEN
    RAISE EXCEPTION 'pretest FAILED: apply 20261005161000 first (property_ever_contacted missing)';
  END IF;

  SELECT p.latitude::float8, p.longitude::float8 INTO lat, lng
  FROM public.campaign_target_graph g JOIN public.properties p ON p.property_id = g.property_id
  WHERE (g.never_contacted IS FALSE OR g.property_ever_contacted) AND p.latitude IS NOT NULL
  ORDER BY g.property_id LIMIT 1;
  tx := floor((lng + 180) / 360 * 2 ^ tz);
  ty := floor((1 - ln(tan(radians(lat)) + 1 / cos(radians(lat))) / pi()) / 2 * 2 ^ tz);
  dx := floor((lng + 180) / 360 * 2 ^ 10);
  dy := floor((1 - ln(tan(radians(lat)) + 1 / cos(radians(lat))) / pi()) / 2 * 2 ^ 10);

  t0 := clock_timestamp(); b_old := public.get_property_map_vector_tile(tz, tx, ty);
  dal_old := public.get_property_map_vector_tile(14, 3786, 6611);
  ms_old := EXTRACT(epoch FROM clock_timestamp() - t0) * 1000;
  t0 := clock_timestamp(); d_old := public.get_property_map_dot_tile(10, dx, dy);
  dms_old := EXTRACT(epoch FROM clock_timestamp() - t0) * 1000;

  EXECUTE $mig$
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
$mig$;
  EXECUTE $mig$
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
$mig$;

  t0 := clock_timestamp(); b_new := public.get_property_map_vector_tile(tz, tx, ty);
  dal_new := public.get_property_map_vector_tile(14, 3786, 6611);
  ms_new := EXTRACT(epoch FROM clock_timestamp() - t0) * 1000;
  t0 := clock_timestamp(); d_new := public.get_property_map_dot_tile(10, dx, dy);
  dms_new := EXTRACT(epoch FROM clock_timestamp() - t0) * 1000;

  SELECT count(*), count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.campaign_target_graph g
           WHERE g.property_id = p.property_id AND (g.never_contacted IS FALSE OR g.property_ever_contacted)))
    INTO exp_total, exp_touched
  FROM public.properties p, LATERAL (SELECT ST_Transform(ST_TileEnvelope(tz, tx, ty), 4326) AS e) env
  WHERE p.latitude BETWEEN ST_YMin(env.e) AND ST_YMax(env.e) AND p.longitude BETWEEN ST_XMin(env.e) AND ST_XMax(env.e);

  IF (b_old IS NULL) <> (b_new IS NULL) OR (d_old IS NULL) <> (d_new IS NULL) OR (dal_old IS NULL) <> (dal_new IS NULL) THEN
    RAISE EXCEPTION 'pretest FAILED: a tile went null/non-null (vec % -> %, dot % -> %)',
      length(b_old), length(b_new), length(d_old), length(d_new);
  END IF;
  IF ms_new > ms_old * 1.2 + 50 OR dms_new > dms_old * 1.2 + 50 THEN
    RAISE EXCEPTION 'pretest FAILED: slower (vector % -> % ms, dot % -> % ms)', round(ms_old), round(ms_new), round(dms_old), round(dms_new);
  END IF;
  RAISE EXCEPTION 'pretest ok: vector z14 %/% bytes % -> % (Dallas % -> %), % -> % ms; dot z10 %/% bytes % -> %, % -> % ms; tile expects % of % properties contacted',
    tx, ty, length(b_old), length(b_new), length(dal_old), length(dal_new), round(ms_old), round(ms_new),
    dx, dy, length(d_old), length(d_new), round(dms_old), round(dms_new), exp_touched, exp_total;
END
$pretest$;
