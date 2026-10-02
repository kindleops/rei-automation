-- Rollback for 20261002124000_map_rpc_anon_lockdown: restores anon EXECUTE.
begin;
grant execute on function public.get_map_area_facts(text, text) to anon;
grant execute on function public.get_map_area_intel(double precision, double precision) to anon;
grant execute on function public.get_map_bounds_property_count(double precision, double precision, double precision, double precision, text[], text[]) to anon;
grant execute on function public.get_map_lens_areas(text, double precision, double precision, double precision, double precision, double precision) to anon;
grant execute on function public.get_map_lens_points(text, double precision, double precision, double precision, double precision, double precision) to anon;
grant execute on function public.get_map_market_aggregates(text[], text[]) to anon;
grant execute on function public.get_map_sold_comp(text) to anon;
grant execute on function public.get_map_sold_comps(double precision, double precision, double precision, double precision, double precision, jsonb) to anon;
grant execute on function public.get_map_sold_comps_list(double precision, double precision, double precision, double precision, jsonb) to anon;
grant execute on function public.get_map_spatial_clusters(double precision, double precision, double precision, double precision, double precision) to anon;
grant execute on function public.map_search(text) to anon;
commit;
