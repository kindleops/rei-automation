-- Map RPC anon lockdown (PROPOSED — apply with the owner present, after
-- 20261002122000 so its CREATE OR REPLACE keeps these grants).
--
-- Ten SECURITY DEFINER Map RPCs were executable by anon/PUBLIC, so anyone with
-- the public anon key (shipped in the dashboard bundle) could read map, comp,
-- area and search data. The RC 7.1 lockdowns did not cover them.
--
-- The dashboard calls them with the operator session (authenticated) and the
-- API with service_role, so both keep EXECUTE. Only PUBLIC and anon lose it.
-- get_map_area_summary already denies anon; map_area_* helpers are not
-- SECURITY DEFINER and already deny both roles.
--
-- Rollback: grant execute on the same functions to anon.

begin;

do $$
declare
  fn regprocedure;
begin
  foreach fn in array array[
    'public.get_map_area_facts(text, text)',
    'public.get_map_area_intel(double precision, double precision)',
    'public.get_map_bounds_property_count(double precision, double precision, double precision, double precision, text[], text[])',
    'public.get_map_lens_areas(text, double precision, double precision, double precision, double precision, double precision)',
    'public.get_map_lens_points(text, double precision, double precision, double precision, double precision, double precision)',
    'public.get_map_market_aggregates(text[], text[])',
    'public.get_map_sold_comp(text)',
    'public.get_map_sold_comps(double precision, double precision, double precision, double precision, double precision, jsonb)',
    'public.get_map_sold_comps_list(double precision, double precision, double precision, double precision, jsonb)',
    'public.get_map_spatial_clusters(double precision, double precision, double precision, double precision, double precision)',
    'public.map_search(text)'
  ]::regprocedure[]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated, service_role', fn);
  end loop;
end
$$;

-- Assert: no Map RPC remains executable by anon.
do $$
declare
  leaked text;
begin
  select string_agg(p.oid::regprocedure::text, ', ')
    into leaked
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and (p.proname like 'get\_map%' or p.proname like 'map\_%')
     and has_function_privilege('anon', p.oid, 'execute');
  if leaked is not null then
    raise exception 'map_rpc_anon_lockdown: still anon-executable: %', leaked;
  end if;
end
$$;

commit;
