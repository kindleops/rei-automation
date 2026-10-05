-- APPLIED to prod 2026-10-05 ~07:05 UTC (owner "go", out of auto mode).
-- campaign_events.target_id had no index, so deleting a campaign's targets (Build/Launch
-- re-materialize) ran one seq scan of campaign_events per row for the ON DELETE SET NULL FK:
-- 2,689 targets hit the 8s statement timeout, the ignored delete error then produced
-- "duplicate key value violates unique constraint campaign_targets_campaign_key_key".
-- After: the same delete measured 369 ms (EXPLAIN ANALYZE in a rolled-back txn).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_campaign_events_target_id ON public.campaign_events (target_id);
