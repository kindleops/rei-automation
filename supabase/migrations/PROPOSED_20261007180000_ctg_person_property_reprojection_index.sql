-- PROPOSED — NOT APPLIED. Partial index for the incremental tick's `unprojected` leg
-- (PROPOSED_20261007180000_ctg_person_property_reprojection.sql §6).
--
-- Apply FIRST, OUTSIDE a transaction (CREATE INDEX CONCURRENTLY cannot run in one):
--   psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f <this file>
-- Off-peak. CONCURRENTLY takes SHARE UPDATE EXCLUSIVE only: graph reads and the
-- projection's UPDATEs keep running; a full rebuild's TRUNCATE would wait for it.
-- Do not run while a stage_commit is in flight (check campaign_target_graph_refresh_runs
-- for status='started').
--
-- Size: the index holds only rows never enriched since the last rebuild — 176,605
-- right after a rebuild (~6 MB), shrinking to ~0 as the projection catches up.
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS public.ctg_unenriched_graph_id_idx;
SET lock_timeout = '5s';
CREATE INDEX CONCURRENTLY IF NOT EXISTS ctg_unenriched_graph_id_idx
  ON public.campaign_target_graph (graph_id)
  WHERE enriched_at IS NULL;
