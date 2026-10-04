-- ROLLBACK for PROPOSED_20261004150000_market_intel_geo_rollup.sql (PROPOSED, not applied).
-- No data is changed by the forward migration; dropping its objects restores the prior state.
select cron.unschedule('refresh_mi_geo_rollup') where exists (select 1 from cron.job where jobname = 'refresh_mi_geo_rollup');
drop function if exists public.refresh_mi_geo_rollup();
drop materialized view if exists public.mi_geo_period_rollup;
