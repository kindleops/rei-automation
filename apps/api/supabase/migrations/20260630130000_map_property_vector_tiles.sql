-- PostGIS MVT tiles for complete property-level map rendering (zoom 9+).
-- Stable tile payload: geography + marker_key + property_id.
-- Dynamic stage/status joined client-side via feature-state on property_id.

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE OR REPLACE FUNCTION public.resolve_property_marker_key_sql(
  p_property_type text,
  p_asset_type text,
  p_units_count numeric,
  p_multifamily_units numeric
)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN COALESCE(p_asset_type, '') IN ('sfr', 'condo', 'townhome', 'single_family') THEN 'single_family'
    WHEN COALESCE(p_asset_type, '') IN ('multifamily_small', 'multifamily_2_4', 'duplex', 'triplex') THEN 'multifamily_2_4'
    WHEN COALESCE(p_asset_type, '') IN ('multifamily_large', 'multifamily_5_plus', 'mhp', 'apartment') THEN 'multifamily_5_plus'
    WHEN COALESCE(p_asset_type, '') IN ('shopping_plaza', 'retail', 'retail_strip') THEN 'retail_strip'
    WHEN COALESCE(p_asset_type, '') = 'storage' THEN 'storage'
    WHEN COALESCE(p_asset_type, '') = 'office' THEN 'office'
    WHEN COALESCE(p_asset_type, '') IN ('industrial', 'warehouse') THEN 'industrial'
    WHEN COALESCE(p_asset_type, '') = 'land' THEN 'land'
    WHEN COALESCE(p_asset_type, '') IN ('commercial', 'mixed_use', 'hotel', 'commercial_other') THEN 'commercial_other'
    WHEN GREATEST(COALESCE(p_units_count, 0)::integer, COALESCE(p_multifamily_units, 0)::integer) BETWEEN 2 AND 4 THEN 'multifamily_2_4'
    WHEN GREATEST(COALESCE(p_units_count, 0)::integer, COALESCE(p_multifamily_units, 0)::integer) >= 5 THEN 'multifamily_5_plus'
    WHEN LOWER(COALESCE(p_property_type, '')) ~ '(duplex|triplex|quadplex|2.?4)' THEN 'multifamily_2_4'
    WHEN LOWER(COALESCE(p_property_type, '')) ~ '(apartment|multifamily|5\+|50\+)' THEN 'multifamily_5_plus'
    WHEN LOWER(COALESCE(p_property_type, '')) ~ '(strip|retail|shopping|storefront|plaza)' THEN 'retail_strip'
    WHEN LOWER(COALESCE(p_property_type, '')) ~ '(storage|self.?storage)' THEN 'storage'
    WHEN LOWER(COALESCE(p_property_type, '')) ~ '(office|medical office)' THEN 'office'
    WHEN LOWER(COALESCE(p_property_type, '')) ~ '(industrial|warehouse|distribution|manufacturing|flex)' THEN 'industrial'
    WHEN LOWER(COALESCE(p_property_type, '')) ~ '(land|vacant|lot|parcel|agricultural)' THEN 'land'
    WHEN LOWER(COALESCE(p_property_type, '')) ~ '(commercial|hotel|mixed)' THEN 'commercial_other'
    WHEN LOWER(COALESCE(p_property_type, '')) ~ '(sfr|single|residential|house|detached|townhome|condo)' THEN 'single_family'
    ELSE 'unknown'
  END;
$$;

CREATE OR REPLACE FUNCTION public.get_property_map_vector_tile(
  z integer,
  x integer,
  y integer
)
RETURNS bytea
LANGUAGE sql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = public
AS $$
WITH tile_bounds AS (
  SELECT ST_TileEnvelope(z, x, y) AS geom_3857
),
mvt_source AS (
  SELECT
    p.property_id::text AS property_id,
    public.resolve_property_marker_key_sql(
      p.property_type,
      p.asset_type,
      p.units_count,
      p.multifamily_units
    ) AS marker_key,
    COALESCE(NULLIF(TRIM(p.market), ''), 'Unknown') AS market,
    COALESCE(p.contact_status, 'uncontacted') AS contact_status,
    COALESCE(p.activity_status, '') AS activity_status,
    COALESCE(p.final_acquisition_score, 0)::integer AS acquisition_score,
    ST_AsMVTGeom(
      ST_Transform(
        ST_SetSRID(ST_MakePoint(p.longitude::double precision, p.latitude::double precision), 4326),
        3857
      ),
      tb.geom_3857,
      4096,
      64,
      true
    ) AS geom
  FROM public.properties p
  CROSS JOIN tile_bounds tb
  WHERE p.latitude IS NOT NULL
    AND p.longitude IS NOT NULL
    AND ST_Intersects(
      ST_Transform(
        ST_SetSRID(ST_MakePoint(p.longitude::double precision, p.latitude::double precision), 4326),
        3857
      ),
      tb.geom_3857
    )
)
SELECT ST_AsMVT(mvt_source, 'properties', 4096, 'geom')
FROM mvt_source
WHERE geom IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.get_property_map_tile_feature_count(
  z integer,
  x integer,
  y integer
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH tile_bounds AS (
  SELECT ST_TileEnvelope(z, x, y) AS geom_3857
)
SELECT COUNT(*)::bigint
FROM public.properties p
CROSS JOIN tile_bounds tb
WHERE p.latitude IS NOT NULL
  AND p.longitude IS NOT NULL
  AND ST_Intersects(
    ST_Transform(
      ST_SetSRID(ST_MakePoint(p.longitude::double precision, p.latitude::double precision), 4326),
      3857
    ),
    tb.geom_3857
  );
$$;

GRANT EXECUTE ON FUNCTION public.resolve_property_marker_key_sql(text, text, numeric, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_property_map_vector_tile(integer, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_property_map_tile_feature_count(integer, integer, integer) TO authenticated, service_role;