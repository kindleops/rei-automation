-- lc-fixture: posttest
-- =============================================================================
-- ROLLBACK POSTTEST (E) for supabase/rollbacks/20261003220000_campaign_audience_completeness.rollback.sql:
-- runs AFTER the runner applied the rollback file; it restores both live functions verbatim and
-- the exact column lists recorded by campaign_audience_completeness_pretest.sql; new objects gone.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production — not even
-- inside BEGIN … ROLLBACK. Run through the migration test runner on a disposable database.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id campaign_audience_completeness --prod-shape …
-- =============================================================================
\set ON_ERROR_STOP on
begin;
set local statement_timeout = '180s';

do $$
declare n int; fn text;
begin
  create temp table t_post on commit drop as
  select 'fn:' || p.oid::regprocedure::text as k, md5(pg_get_functiondef(p.oid)) as v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('refresh_campaign_target_graph_seller_batch', 'campaign_target_graph_apply_filter_columns')
  union all
  select 'cols:' || table_name, md5(string_agg(column_name || ':' || data_type, ',' order by ordinal_position))
  from information_schema.columns
  where table_schema = 'public' and table_name in ('campaign_target_graph', 'campaign_target_graph_stage')
  group by table_name;
  select count(*) into n from (
    (select * from lc_mt.t_pre except select * from t_post) union all (select * from t_post except select * from lc_mt.t_pre)) d;
  if n > 0 then
    raise exception 'FAIL E: rollback differs from the live state: %', (select string_agg(k, ', ') from (
      (select * from lc_mt.t_pre except select * from t_post) union all (select * from t_post except select * from lc_mt.t_pre)) d);
  end if;
  foreach fn in array array['public.campaign_target_graph_enrich_rows(text[])', 'public.campaign_target_graph_enrich_market(text,text,integer)',
                            'public.campaign_target_graph_reconcile_tick(integer,integer)', 'public.campaign_target_graph_incremental_tick(integer)'] loop
    if to_regprocedure(fn) is not null then raise exception 'FAIL E: % survived the rollback', fn; end if;
  end loop;
  if to_regclass('public.campaign_target_graph_sync_state') is not null or to_regclass('public.campaign_target_graph_coverage') is not null then
    raise exception 'FAIL E: new tables survived the rollback';
  end if;
  raise notice 'PASS E: rollback restores both live functions verbatim and the exact column lists; new objects gone';
end $$;

do $$ begin raise notice 'ALL PASS (rolling back; nothing persists)'; end $$;
rollback;
