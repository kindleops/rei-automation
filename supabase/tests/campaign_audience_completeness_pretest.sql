-- lc-fixture: pretest
-- =============================================================================
-- PRETEST (pre-state capture) for supabase/migrations/20261003220000_campaign_audience_completeness.sql.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production — not even
-- inside BEGIN … ROLLBACK. Run through the migration test runner on a disposable database.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id campaign_audience_completeness --prod-shape …
-- rc-8.5.15.1: this was the first part of campaign_audience_completeness_test.sql, which
-- \ir-included the migration and its rollback file inside its own transaction. The runner now
-- applies both; this file records the live function / column state into the runner's scratch
-- schema lc_mt (absent in production: this file fails fast anywhere else).
-- =============================================================================
\set ON_ERROR_STOP on
do $$ begin if to_regnamespace('lc_mt') is null then raise exception 'lc_mt scratch schema missing: run this only through scripts/db/run-migration-test.mjs on a disposable database'; end if; end $$;
set statement_timeout = '180s';

-- ---------------------------------------------------------- pre-state ----
drop table if exists lc_mt.t_pre;
create table lc_mt.t_pre as
select 'fn:' || p.oid::regprocedure::text as k, md5(pg_get_functiondef(p.oid)) as v
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('refresh_campaign_target_graph_seller_batch', 'campaign_target_graph_apply_filter_columns')
union all
select 'cols:' || table_name, md5(string_agg(column_name || ':' || data_type, ',' order by ordinal_position))
from information_schema.columns
where table_schema = 'public' and table_name in ('campaign_target_graph', 'campaign_target_graph_stage')
group by table_name;

do $$ begin
  if (select count(*) from lc_mt.t_pre) <> 4 then raise exception 'FAIL pre: expected 2 functions + 2 tables, got %', (select count(*) from lc_mt.t_pre); end if;
end $$;
