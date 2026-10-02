-- =============================================================================
-- analytics_zip_boundaries test — run AFTER applying
-- supabase/migrations/20261001122000_analytics_zip_boundaries.sql
--
-- Read-only: one transaction ending in ROLLBACK. Run as postgres.
-- Every check RAISEs on failure. The script prints NOTICE 'PASS ...' lines and
-- finishes with 'ALL PASS'. Before the migration is applied, the first check fails:
-- that is the expected red state.
-- =============================================================================

begin;
set local statement_timeout = '15s';

do $$
declare
  fn constant text := 'public.analytics_zip_boundaries(text[])';
  n int;
  bad int;
begin
  if to_regprocedure(fn) is null then
    raise exception 'FAIL: % does not exist', fn;
  end if;
  raise notice 'PASS function exists';

  if has_function_privilege('anon', fn, 'EXECUTE') then
    raise exception 'FAIL: anon can execute %', fn;
  end if;
  if has_function_privilege('authenticated', fn, 'EXECUTE') then
    raise exception 'FAIL: authenticated can execute %', fn;
  end if;
  if not has_function_privilege('service_role', fn, 'EXECUTE') then
    raise exception 'FAIL: service_role cannot execute %', fn;
  end if;
  raise notice 'PASS execute is service_role only';

  if not exists (select 1 from pg_proc p
                 where p.oid = to_regprocedure(fn) and p.prosecdef
                   and p.proconfig @> array['search_path=""']) then
    raise exception 'FAIL: % must be SECURITY DEFINER with an empty search_path', fn;
  end if;
  raise notice 'PASS security definer + empty search_path';

  -- Real ZIPs come back as GeoJSON polygons, keyed by the bare ZIP.
  select count(*), count(*) filter (where geojson->>'type' not in ('Polygon','MultiPolygon') or zip !~ '^[0-9]{5}$')
    into n, bad
  from public.analytics_zip_boundaries(array(
    select substr(geo_id, 6) from risk_private.geography_authoritative
    where geo_level = 'zip5' order by geo_id limit 5));
  if n <> 5 or bad <> 0 then
    raise exception 'FAIL: expected 5 well-formed outlines, got % (% malformed)', n, bad;
  end if;
  raise notice 'PASS outlines returned';

  -- Malformed input is ignored, NULL is safe, and the 400 cap holds.
  select count(*) into n from public.analytics_zip_boundaries(array['abc', '1234', '123456', null, '''; drop table x; --']);
  if n <> 0 then raise exception 'FAIL: malformed ZIPs returned % rows', n; end if;
  select count(*) into n from public.analytics_zip_boundaries(null);
  if n <> 0 then raise exception 'FAIL: NULL input returned % rows', n; end if;
  select count(*) into n from public.analytics_zip_boundaries(array(
    select substr(geo_id, 6) from risk_private.geography_authoritative where geo_level = 'zip5'));
  if n > 400 then raise exception 'FAIL: cap exceeded (% rows)', n; end if;
  raise notice 'PASS input validation + 400 cap (% rows for the full list)', n;

  raise notice 'ALL PASS';
end $$;

rollback;
