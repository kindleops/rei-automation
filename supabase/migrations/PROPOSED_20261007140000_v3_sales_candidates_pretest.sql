-- PRETEST (read-only) for PROPOSED_20261007140000_v3_sales_candidates.sql. Every check must pass before PART A.
begin read only;
set local statement_timeout = '30s';
-- 1) nothing to collide with
select 'mv_exists' chk, to_regclass('comp_private.mv_v3_sales_candidates') is null as ok;
select 'rpc_exists' chk, not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('get_v3_sales_candidates', 'get_v3_subject_geography')) as ok;
-- 2) dependencies present (postgis geography, source MV + columns)
select 'postgis' chk, exists (select 1 from pg_extension where extname = 'postgis') as ok;
select 'source_columns' chk, count(*) = 30 as ok from information_schema.columns
  where table_schema = 'public' and table_name = 'mv_map_market_sales'
    and column_name in ('comp_id','txn_id','source','sold_on','price','lat','lng','property_id','address','city','state','zip','property_type','beds','baths','sqft',
      'year_built','units','estimated_value','portfolio_size','buyer','buyer_class','is_investor','buyer_kind','doc_type','is_cash_purchase','is_arms_length','price_source',
      'per_door','ppsf');
-- 3) the source is current (expect 2026-09-10 or later) and the frozen pool is not
select 'source_fresh' chk, max(sold_on) as newest from public.mv_map_market_sales;
select 'legacy_pool_newest' chk, max(sale_date) as newest from public.v_recent_sold_comps;
-- 4) size budget
select 'source_size' chk, pg_size_pretty(pg_total_relation_size('public.mv_map_market_sales')) as size;
rollback;
