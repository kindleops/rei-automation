-- ROLLBACK for PROPOSED_20261004150000_market_intel_geo_rollup.sql (+ the _schedule file).
-- The forward migration changes no existing data; dropping its objects restores the prior state.
-- The Market Intelligence API then reports "Market summary not built yet" (it never falls back to
-- streaming raw sales in production).
--
-- Softer options first (no DDL):
--   pause the nightly build:   update cron.job set active = false where jobname like 'mi_rollup_%';
--   serve the previous build:  update public.mi_rollup_builds set status = 'superseded' where build_id = <bad>;
--                              update public.mi_rollup_builds set status = 'ready' where build_id = <previous>;
select cron.unschedule(jobname) from cron.job where jobname in ('mi_rollup_tick_a', 'mi_rollup_tick_b');
drop function if exists public.mi_rollup_status();
drop function if exists public.mi_rollup_tick(boolean);
drop function if exists public.mi_rollup_run_unit(bigint, text, date);
drop function if exists public.mi_rollup_level_key(text);
drop function if exists public.mi_rollup_units();
drop function if exists public.mi_rollup_fingerprint();
drop function if exists public.mi_rollup_load_ok();
drop view if exists public.mi_rollup_sales_v;
drop table if exists public.mi_buyer_activity;
drop table if exists public.mi_geo_month_rollup;
drop table if exists public.mi_geo_period_rollup;
drop table if exists public.mi_zip_geo;
drop table if exists public.mi_rollup_sync_state;
drop table if exists public.mi_rollup_builds;
drop table if exists public.mi_asset_type_map;
