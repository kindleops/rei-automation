-- =============================================================================
-- Analytics Lab — real ZIP outlines for the geographic heat map  (RC 7.1)
-- STATUS: OWNER-APPROVED 2026-10-01, ships with the RC 7.1 migrations.
-- Apply AFTER 20261001121000_public_write_lockdown.sql.
-- Post-apply verification: supabase/tests/analytics_zip_boundaries_test.sql
-- =============================================================================
--
-- WHY
--   The Lab heat map drills Nation → State → County → City → ZIP.
--   - State and county use US Census polygons shipped with the dashboard.
--   - ZIPs are drawn at the centre of their properties, because nothing can read
--     the TIGER ZCTA polygons already in production:
--       risk_private.geography_authoritative
--         geo_level = 'zip5', geo_id = 'zip5:NNNNN' (PK), 1,325 rows
--         covers 322 of the 376 ZIPs messaged in the last 120 days
--   This function exposes simplified outlines for a bounded list of ZIPs.
--
-- WHAT
--   public.analytics_zip_boundaries(p_zips text[]) → (zip text, geojson jsonb)
--   - Read-only.
--   - Only well-formed 5-digit ZIPs; at most 400 per call.
--   - Geometry simplified at 0.0005° and rounded to 5 decimals.
--
-- SECURITY
--   - SECURITY DEFINER with an empty search_path; every object is
--     schema-qualified. PostGIS lives in public (3.3.7).
--   - EXECUTE: service_role only (the API server).
--   - Revoked from PUBLIC, anon and authenticated. Supabase's default privileges
--     grant new public functions to anon/authenticated, so the revoke is required.
--   - risk_private itself stays unexposed.
--
-- LOCKS / VOLUME
--   CREATE FUNCTION only: no table locks, no data change. ≤400 rows per call.
--
-- ROLLBACK
--   drop function if exists public.analytics_zip_boundaries(text[]);
-- =============================================================================

create or replace function public.analytics_zip_boundaries(p_zips text[])
returns table (zip text, geojson jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select substr(g.geo_id, 6) as zip,
         public.st_asgeojson(public.st_simplifypreservetopology(g.geom, 0.0005), 5)::jsonb as geojson
  from risk_private.geography_authoritative g
  where g.geo_level = 'zip5'
    and g.geo_id = any (
      select 'zip5:' || z
      from unnest(coalesce(p_zips, array[]::text[])) as z
      where z ~ '^[0-9]{5}$'
      limit 400
    );
$$;

revoke all on function public.analytics_zip_boundaries(text[]) from public, anon, authenticated;
grant execute on function public.analytics_zip_boundaries(text[]) to service_role;

comment on function public.analytics_zip_boundaries(text[]) is
  'Analytics Lab heat map: simplified ZCTA outlines for up to 400 five-digit ZIPs. Read-only; service_role only.';
