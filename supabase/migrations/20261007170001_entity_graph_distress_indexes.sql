-- PROPOSED — NOT APPLIED. Entity Graph distress & condition filters (owner 2026-10-07:
-- "vacant AND poor/unsound condition, by market").
--
-- Why: the flag filter is a whole-token ILIKE on properties.property_flags_text
-- ('Vacant Home' | 'Vacant Home;%' | '%; Vacant Home' | '%; Vacant Home;%') and the
-- condition / rehab facets group building_condition / rehab_level. None is indexed on
-- properties. Measured read-only 2026-10-07: vacant AND poor/unsound = 1,076, count
-- 0.36-0.6 s warm but 8.4-20.8 s cold (a sequential scan of the 961 MB table), which
-- can pass the 8 s PostgREST timeout (the browse then reports the count as unavailable,
-- never 0). A trigram GIN answers the ILIKE patterns; the btrees answer the facets.
--
-- Build CONCURRENTLY, outside a transaction. Rollback: the DROP lines below.

create extension if not exists pg_trgm;

create index concurrently if not exists idx_properties_flags_text_trgm
  on public.properties using gin (property_flags_text gin_trgm_ops);

create index concurrently if not exists idx_properties_building_condition
  on public.properties (building_condition);

create index concurrently if not exists idx_properties_rehab_level
  on public.properties (rehab_level);

-- Verify:
--   explain (analyze) select count(*) from public.properties
--    where (property_flags_text ilike 'Vacant Home' or property_flags_text ilike 'Vacant Home;%'
--        or property_flags_text ilike '%; Vacant Home' or property_flags_text ilike '%; Vacant Home;%')
--      and building_condition in ('Poor','Unsound');   -- expect 1,076 (canaries have no flags)
-- Rollback:
--   drop index concurrently if exists public.idx_properties_flags_text_trgm;
--   drop index concurrently if exists public.idx_properties_building_condition;
--   drop index concurrently if exists public.idx_properties_rehab_level;
