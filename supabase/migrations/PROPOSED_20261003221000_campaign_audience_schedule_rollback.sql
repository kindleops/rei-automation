-- ROLLBACK for PROPOSED_20261003221000_campaign_audience_schedule.sql.
-- Not transactional (DROP INDEX CONCURRENTLY): run with  psql -X -v ON_ERROR_STOP=1 -f …
-- Pause instead of removing:
--   UPDATE cron.job SET active = false WHERE jobname IN ('campaign_audience_reconcile','campaign_audience_incremental');

SELECT cron.unschedule(jobid) FROM cron.job
 WHERE jobname IN ('campaign_audience_reconcile', 'campaign_audience_incremental');

SET lock_timeout = '5s';
DROP INDEX CONCURRENTLY IF EXISTS public.idx_ctg_pending_prior_touch_last_outbound;
