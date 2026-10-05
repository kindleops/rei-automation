-- ROLLBACK for PROPOSED_20261005161000_ctg_property_ever_contacted.sql (all steps).
-- FIRST: if MAP_TOUCH_PROPERTY_LEVEL=1 is set on the API, unset it and redeploy (the Map
-- predicate references property_ever_contacted). If the tile migration 20261005162000 was
-- applied, roll it back first (its function bodies reference the column).
-- Then run in this order, each with MCP execute_sql:
SELECT cron.unschedule('campaign_graph_property_touch')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'campaign_graph_property_touch');

DROP INDEX CONCURRENTLY IF EXISTS public.idx_ctg_property_ever_contacted;

-- The rest is one transaction (apply_migration or execute_sql):
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP FUNCTION IF EXISTS public.refresh_campaign_target_graph_property_touch(integer);
ALTER TABLE public.campaign_target_graph
  DROP COLUMN IF EXISTS property_ever_contacted,
  DROP COLUMN IF EXISTS property_last_outbound_at,
  DROP COLUMN IF EXISTS property_outbound_count;
COMMIT;
-- DROP COLUMN is metadata-only. Space comes back as rows are rewritten by the daily enrich.
