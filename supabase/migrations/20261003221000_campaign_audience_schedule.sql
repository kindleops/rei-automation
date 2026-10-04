-- PROPOSED — NOT APPLIED. Schedules for the campaign audience projection.
-- Apply ONLY after 20261003220000_campaign_audience_completeness.sql and the
-- canary in the run plan (one market enriched by hand, counts checked).
--
-- Windows (UTC). US send windows are 08:00-21:00 recipient-local, i.e. 12:00 UTC
-- (Eastern open) to 04:00 UTC (Pacific close). Existing pg_cron jobs run 09:17,
-- 09:47, 10:07, 10:37 UTC.
--   reconcile    every minute 05:00-08:59 UTC (00:00-03:59 Central): ≤ 4 × 400 rows per
--                tick (~6-9 s measured read side), resumes from a cursor, one cycle a
--                night (~170K rows ≈ 106 ticks ≈ 1h50m).
--   incremental  every 10 min 12:00-04:59 UTC: ≤ 300 rows whose phone activity or
--                suppression changed (measured: 104 ms to detect), one short transaction.
-- Both skip when the other holds the projection lock or > 12 client backends are active.
-- statement_timeout / lock_timeout bound every tick; nothing sleeps inside a transaction.

-- Partial index for the "30-day hold expired" pass (built CONCURRENTLY: no write lock).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_pending_prior_touch_last_outbound
  ON public.campaign_target_graph (last_outbound_at) WHERE pending_prior_touch;

SELECT cron.schedule(
  'campaign_audience_reconcile',
  '* 5-8 * * *',
  $$SET statement_timeout = '45s'; SET lock_timeout = '2s'; SELECT public.campaign_target_graph_reconcile_tick(4, 400);$$
);

SELECT cron.schedule(
  'campaign_audience_incremental',
  '*/10 0-4,12-23 * * *',
  $$SET statement_timeout = '20s'; SET lock_timeout = '2s'; SELECT public.campaign_target_graph_incremental_tick(300);$$
);

-- Pause without dropping anything:
--   UPDATE cron.job SET active = false WHERE jobname IN ('campaign_audience_reconcile','campaign_audience_incremental');
