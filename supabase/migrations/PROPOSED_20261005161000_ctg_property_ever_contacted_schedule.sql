-- STEP 4 of PROPOSED_20261005161000_ctg_property_ever_contacted.sql. Run AFTER the backfill reports more = false.
-- MCP execute_sql. Every 10 minutes at :05, offset from campaign_audience_incremental (:00).
-- Each tick: ledger aggregate (0.3 s) plus about 10.5K index lookups; it writes only
-- rows that changed (new sends since the last tick), so it is typically < 2 s.
-- It skips when the projection lock is held. statement_timeout 20 s matches the incremental tick.
-- Hours: all day. A tick during 05–08 UTC just skips while the reconcile holds the lock.
SELECT cron.schedule(
  'campaign_graph_property_touch',
  '5-59/10 * * * *',
  $$SET statement_timeout = '20s'; SET lock_timeout = '2s'; SELECT public.refresh_campaign_target_graph_property_touch(2000);$$
);
-- POSTCHECK (after 10–20 min):
--   SELECT status, return_message, start_time FROM cron.job_run_details
--   WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'campaign_graph_property_touch')
--   ORDER BY start_time DESC LIMIT 3;     -- status = succeeded
