-- PROPOSED — NOT APPLIED. Entity Graph facet indexes (owner defect 2026-10-07: "counties don't load").
--
-- Why: the County facet groups properties.property_address_county_name, which has
-- NO index. Before the grouped-facet fix it ran ~16 sequential scans through
-- v_entity_graph_properties (5-8 s each, past the 8 s PostgREST timeout) and never
-- answered. After the fix it is ONE grouped query over the direct pool, measured
-- 2026-10-07 (read-only): county 4.8 s, state 6.1 s, market 0.39 s (market has
-- idx_properties_market). These btrees let the planner answer county/state with an
-- index-only scan like market. Cached 5 min server-side either way.
--
-- Size: ~3-4 MB each (idx_properties_address_state is 3.3 MB on 176,610 rows).
-- Build: CONCURRENTLY, seconds; no table lock beyond SHARE UPDATE EXCLUSIVE.
-- Run outside a transaction (CONCURRENTLY). Rollback: the two DROP lines below.

create index concurrently if not exists idx_properties_county_name
  on public.properties (property_address_county_name);

create index concurrently if not exists idx_properties_state_property
  on public.properties (property_address_state, property_id);

-- Verify:
--   explain (analyze, buffers) select property_address_county_name, count(*) from public.properties group by 1;
--   -> Index Only Scan using idx_properties_county_name
-- Rollback:
--   drop index concurrently if exists public.idx_properties_county_name;
--   drop index concurrently if exists public.idx_properties_state_property;
