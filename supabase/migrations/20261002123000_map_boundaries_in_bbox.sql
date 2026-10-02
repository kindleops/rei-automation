-- =============================================================================
-- Map 8.2 — administrative boundary overlay (state, ZIP) from geometry we own
-- STATUS: PROPOSED (not applied). Apply with the owner present. Independent of the
-- other 8.2 migrations.
-- =============================================================================
--
-- WHY
--   The Map has no boundary layer: mv_map_search_areas outlines are property-footprint
--   hulls (st_buffer of the area's properties), not administrative boundaries.
--   risk_private.geography_authoritative holds US Census polygons (SRID 4326, GiST
--   index geography_authoritative_gix):
--     state  33 multipolygons
--     zip5   1,325 ZCTA multipolygons (already read by analytics_zip_boundaries)
--   No county, city or market polygons exist in the database.
--
-- WHAT
--   public.map_boundaries_in_bbox(level, min_lng, min_lat, max_lng, max_lat, tolerance)
--     → (geo_id text, level text, label text, geojson jsonb)
--   - level 'state' | 'zip'; anything else returns no rows.
--   - Viewport-bounded with the GiST index (&& envelope). Refuses oversized ZIP boxes
--     (> 4° × 4° returns no rows); states (33 rows) accept any box.
--   - Simplified (ST_SimplifyPreserveTopology) with the caller's tolerance clamped to
--     [0.0001°, 0.05°], 5-decimal GeoJSON. At most 400 rows.
--   Measured read-only on prod (2026-10-02):
--     state, whole US, tol 0.01      33 rows, 120 KB, 1.26 s (cached by the API)
--     state, Minnesota box, tol 0.002 3 rows,  58 KB, 0.21 s
--     zip, Minneapolis box, tol 0.0005 84 rows, 100 KB, 0.16 s
--     zip, Dallas box, tol 0.001     86 rows,  72 KB, 0.18 s
--
-- SECURITY
--   SECURITY DEFINER, empty search_path, every object schema-qualified.
--   EXECUTE: service_role only (the API server: GET /api/cockpit/map/boundaries).
--   Revoked from PUBLIC, anon, authenticated. risk_private stays unexposed.
--
-- LOCKS / VOLUME: CREATE FUNCTION only. No data change.
-- ROLLBACK
--   drop function if exists public.map_boundaries_in_bbox(text, double precision, double precision, double precision, double precision, double precision);
-- Until this is applied the API serves ZIP outlines through analytics_zip_boundaries
-- (RC 7.1, applied) and reports state as not installed.
-- =============================================================================

create or replace function public.map_boundaries_in_bbox(
  p_level text,
  p_min_lng double precision,
  p_min_lat double precision,
  p_max_lng double precision,
  p_max_lat double precision,
  p_tolerance double precision default 0.0005
)
returns table (geo_id text, level text, label text, geojson jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select g.geo_id,
         case g.geo_level when 'zip5' then 'zip' else g.geo_level end,
         substr(g.geo_id, strpos(g.geo_id, ':') + 1),
         public.st_asgeojson(
           public.st_simplifypreservetopology(g.geom, greatest(0.0001, least(coalesce(p_tolerance, 0.0005), 0.05))),
           5
         )::jsonb
  from risk_private.geography_authoritative g
  where g.geo_level = case p_level when 'zip' then 'zip5' when 'state' then 'state' end
    and p_max_lng > p_min_lng and p_max_lat > p_min_lat
    and p_max_lng - p_min_lng <= case p_level when 'zip' then 4 else 360 end
    and p_max_lat - p_min_lat <= case p_level when 'zip' then 4 else 180 end
    and g.geom operator(public.&&) public.st_makeenvelope(p_min_lng, p_min_lat, p_max_lng, p_max_lat, 4326)
  order by g.geo_id
  limit 400;
$$;

revoke all on function public.map_boundaries_in_bbox(text, double precision, double precision, double precision, double precision, double precision) from public, anon, authenticated;
grant execute on function public.map_boundaries_in_bbox(text, double precision, double precision, double precision, double precision, double precision) to service_role;

comment on function public.map_boundaries_in_bbox(text, double precision, double precision, double precision, double precision, double precision) is
  'Map boundary overlay: simplified US Census state / ZCTA outlines intersecting a viewport (≤ 400). Read-only; service_role only.';
