-- PROPOSED — NOT APPLIED. The nightly Market Intelligence summary build.
-- Apply ONLY after PROPOSED_20261004150000_market_intel_geo_rollup.sql AND a completed,
-- verified first build (docs/market-intelligence/SUMMARY_APPLY_PLAN.txt).
--
-- Window (UTC): 10:45–11:59, i.e. 05:45–06:59 Central. It runs after refresh_map_market_sales (10:07)
-- and its VACUUM (10:37), and before the daytime campaign_audience_incremental (12:00). It overlaps
-- no other job: campaign_audience_reconcile runs 05:00–08:59, the entity graph at 09:17,
-- comp evidence at 09:47.
-- One unit per tick, one tick a minute: 75 ticks a night. A full rebuild is ~47 units (≤ ~11 s each,
-- measured), so it completes in ~47 minutes with ~28 ticks of retry headroom. On an unchanged source
-- the first tick checks the fingerprint (~1 s) and every later tick is a no-op (checked_recently).
-- An unfinished build resumes the next night from its cursor. finalize fails it if the MV changed
-- meanwhile, and a fresh build starts.
SELECT cron.schedule('mi_rollup_tick_a', '45-59 10 * * *',
  $$SET statement_timeout = '30s'; SET lock_timeout = '2s'; SELECT public.mi_rollup_tick();$$);
SELECT cron.schedule('mi_rollup_tick_b', '* 11 * * *',
  $$SET statement_timeout = '30s'; SET lock_timeout = '2s'; SELECT public.mi_rollup_tick();$$);

-- Pause without dropping anything:
--   UPDATE cron.job SET active = false WHERE jobname IN ('mi_rollup_tick_a', 'mi_rollup_tick_b');
