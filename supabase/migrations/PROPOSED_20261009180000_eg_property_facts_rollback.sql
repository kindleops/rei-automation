-- ROLLBACK for PROPOSED_20261009180000_eg_property_facts.sql. Drops the read model only; no source table is touched.
-- Entity Graph falls back to the live computation automatically (entity-graph-facts-query.js factsState).
drop table if exists public.eg_property_facts;
drop table if exists public.eg_refresh_log;
