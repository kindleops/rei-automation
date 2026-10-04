-- Rollback for PROPOSED_20261004010000_campaign_target_graph_funnel_counts.sql.
-- The API falls back to per-bucket counts on its own once the rpc is gone (PGRST202),
-- so this is safe to run at any time. Same numbers, more round trips.

-- Run outside a transaction:
-- DROP INDEX CONCURRENTLY IF EXISTS public.idx_ctg_queue_eligible_market_graph_id;

DROP FUNCTION IF EXISTS public.campaign_target_graph_funnel_counts(jsonb, jsonb);
DROP FUNCTION IF EXISTS public.campaign_target_graph_predicate_sql(jsonb);

NOTIFY pgrst, 'reload schema';
