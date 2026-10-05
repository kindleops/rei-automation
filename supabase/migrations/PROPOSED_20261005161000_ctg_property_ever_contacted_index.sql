-- STEP 2 of PROPOSED_20261005161000_ctg_property_ever_contacted.sql
-- Run AFTER the main file and BEFORE _backfill.sql. One statement, MCP execute_sql
-- (CONCURRENTLY cannot run in a transaction).   SET statement_timeout = '0'; SET lock_timeout = '5s';
-- A partial index, tiny: about 10.5K entries once filled (< 1 MB). It serves
--   (a) the refresh function's "currently flagged" candidates, and
--   (b) the Map Contacted predicate's property-level arm (EXISTS ... property_ever_contacted).
-- POSTCHECK: SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--            WHERE c.relname = 'idx_ctg_property_ever_contacted';   -- t
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_property_ever_contacted
  ON public.campaign_target_graph (property_id)
  WHERE property_ever_contacted;
