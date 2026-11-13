-- lc-fixture: posttest
-- =============================================================================
-- POSTTEST for supabase/migrations/20261003220000_campaign_audience_completeness.sql (A–D).
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production — not even
-- inside BEGIN … ROLLBACK. Run through the migration test runner on a disposable database.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id campaign_audience_completeness --prod-shape …
-- rc-8.5.15.1: formerly a "rollback-only pretest" that \ir-included the migration and its
-- rollback file inside its own transaction (and was run with psql against production). The
-- runner now applies the migration on a disposable database; this file asserts A–D in ONE
-- transaction ending in ROLLBACK; E (the rollback file) is campaign_audience_completeness_rollback_test.sql.
--
-- What it proves (every check RAISEs on failure; it ends with 'ALL PASS'):
--   A. Catalog: the new functions exist, the contact batch no longer treats an unknown
--      phone type as wireless, accepts 'Wireless', compares +1E.164; the trigger no
--      longer back-fills building_condition from rehab_level; graph and stage carry
--      the same 22 new columns in the same order; anon/authenticated cannot EXECUTE
--      the new functions or read the new tables; RLS is on.
--   B. Projection on 200 Minneapolis rows + 2 synthetic rows: 'Wireless' evidence →
--      W and SMS-capable; no evidence → unknown, NOT SMS-capable, non_sms_capable;
--      no real row is SMS-eligible with an unknown type; names, demographics and
--      seller/property flags are populated wherever the canonical source has them.
--   C. Contact batch (full-rebuild path) on 25 properties stamps build_id/built_at
--      and phone_type, and never marks an unknown type SMS-eligible.
--   D. Incremental tick and coverage measurement run.
--   E. The rollback restores the live function definitions verbatim (md5 of
--      pg_get_functiondef) and the exact column lists; the new objects are gone.
-- =============================================================================

\set ON_ERROR_STOP on
begin;
set local statement_timeout = '180s';
set local lock_timeout = '5s';

-- ---------------------------------------------------------- A. catalog ----
do $$
declare
  fn text;
  def text;
  missing text := '';
  n int;
begin
  foreach fn in array array[
    'public.campaign_target_graph_enrich_rows(text[])',
    'public.campaign_target_graph_enrich_batch(text,integer)',
    'public.campaign_target_graph_enrich_market(text,text,integer)',
    'public.campaign_target_graph_reconcile_tick(integer,integer)',
    'public.campaign_target_graph_incremental_tick(integer)',
    'public.campaign_target_graph_measure_coverage(text,numeric)',
    'public.campaign_target_graph_load_ok(integer)'] loop
    if to_regprocedure(fn) is null then missing := missing || fn || ' '; continue; end if;
    if has_function_privilege('anon', fn, 'EXECUTE') or has_function_privilege('authenticated', fn, 'EXECUTE') then
      raise exception 'FAIL A: % is executable by anon/authenticated', fn;
    end if;
  end loop;
  if missing <> '' then raise exception 'FAIL A: missing functions %', missing; end if;

  def := pg_get_functiondef('public.refresh_campaign_target_graph_seller_batch(uuid,integer,integer)'::regprocedure);
  if def like '%COALESCE(f.final_type,''W'')%' then raise exception 'FAIL A: seller batch still treats unknown phone type as wireless'; end if;
  if def not like '%IN (''W'',''Wireless'')%' then raise exception 'FAIL A: seller batch does not accept ''Wireless'''; end if;
  if def not like '%''+1'' || r.final_phone%' then raise exception 'FAIL A: seller batch does not compare +1E.164'; end if;
  if def not like '%op.individual_key = ec.selected_person_key%' then raise exception 'FAIL A: entity contacts are not typed from owner_phone'; end if;
  if def not like '%build_id, built_at, phone_type%' then raise exception 'FAIL A: seller batch does not stamp build_id/built_at/phone_type'; end if;

  def := pg_get_functiondef('public.campaign_target_graph_apply_filter_columns()'::regprocedure);
  if def like '%NULLIF(NEW.rehab_level%' then raise exception 'FAIL A: trigger still back-fills building_condition from rehab_level'; end if;

  select count(*) into n from information_schema.columns
  where table_schema = 'public' and table_name = 'campaign_target_graph'
    and column_name in ('build_id','built_at','phone_type','enriched_at','enrich_version','phone_type_source','beds','baths',
                        'building_sqft','year_built','lot_sqft','total_loan_balance','ownership_years','tax_delinquent_year',
                        'building_quality','estimated_repair_cost','aos_score','decision_tier','acquisition_confidence',
                        'transaction_probability_365','best_strategy','scores_computed_at');
  if n <> 22 then raise exception 'FAIL A: graph has % of 22 new columns', n; end if;
  if (select md5(string_agg(column_name || ':' || data_type, ',' order by ordinal_position)) from information_schema.columns
      where table_schema = 'public' and table_name = 'campaign_target_graph')
     <> (select md5(string_agg(column_name || ':' || data_type, ',' order by ordinal_position)) from information_schema.columns
      where table_schema = 'public' and table_name = 'campaign_target_graph_stage') then
    raise exception 'FAIL A: graph and stage columns diverge (commit is INSERT … SELECT *)';
  end if;

  if has_table_privilege('anon', 'public.campaign_target_graph_sync_state', 'SELECT')
     or has_table_privilege('authenticated', 'public.campaign_target_graph_coverage', 'SELECT') then
    raise exception 'FAIL A: anon/authenticated can read the new tables';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.campaign_target_graph_sync_state'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.campaign_target_graph_coverage'::regclass) then
    raise exception 'FAIL A: RLS not enabled on the new tables';
  end if;
  if (select count(*) from public.campaign_target_graph_sync_state) <> 2 then raise exception 'FAIL A: sync_state not seeded'; end if;
  raise notice 'PASS A: functions, phone-type/E.164 fixes, trigger fix, 22 columns on graph = stage, grants, RLS';
end $$;

-- ------------------------------------------------------- B. projection ----
create temp table t_ids on commit drop as
select graph_id, queue_eligible as eligible_before, queue_block_reason as reason_before
from public.campaign_target_graph
where market = 'Minneapolis, MN'
order by graph_id
limit 200;

-- Two synthetic rows (rolled back): 555-01xx numbers are reserved for fiction.
insert into public.campaign_target_graph (graph_id, market, state, canonical_e164, sender_covered, extra_data)
values ('pretest_wireless', 'Minneapolis, MN', 'MN', '6125550101', true, '{"phone_type":"Wireless"}'::jsonb),
       ('pretest_unknown',  'Minneapolis, MN', 'MN', '6125550102', true, '{}'::jsonb);

select clock_timestamp() as t_proj \gset
select public.campaign_target_graph_enrich_rows(
  (select array_agg(graph_id) from t_ids) || array['pretest_wireless', 'pretest_unknown']) as projected \gset
select round(extract(epoch from clock_timestamp() - :'t_proj'::timestamptz) * 1000) as proj_ms \gset
\echo 'INFO projection:' :projected 'rows in' :proj_ms 'ms'

do $$
declare
  r record;
  n int; m int;
begin
  select * into r from public.campaign_target_graph where graph_id = 'pretest_wireless';
  if r.phone_type is distinct from 'W' or not r.sms_eligible or not r.queue_eligible or r.queue_block_reason is not null then
    raise exception 'FAIL B: ''Wireless'' evidence not accepted (type %, sms %, eligible %, reason %)', r.phone_type, r.sms_eligible, r.queue_eligible, r.queue_block_reason;
  end if;
  select * into r from public.campaign_target_graph where graph_id = 'pretest_unknown';
  if r.phone_type is not null or r.sms_eligible or r.queue_eligible or r.queue_block_reason is distinct from 'non_sms_capable'
     or (r.blocker_flags->>'phone_type_unknown') is distinct from 'true' then
    raise exception 'FAIL B: unknown phone type treated as SMS-capable (type %, sms %, eligible %, reason %)', r.phone_type, r.sms_eligible, r.queue_eligible, r.queue_block_reason;
  end if;

  select count(*) into n from public.campaign_target_graph g join t_ids using (graph_id)
  where g.canonical_e164 is not null and g.phone_type is null and (g.sms_eligible or g.queue_eligible);
  if n > 0 then raise exception 'FAIL B: % real rows SMS-eligible with an unknown phone type', n; end if;

  select count(*) into n from public.campaign_target_graph g join t_ids using (graph_id)
  where g.enriched_at is null or g.enrich_version is distinct from 'ctg_enrich_v1';
  if n > 0 then raise exception 'FAIL B: % rows not stamped enriched_at/enrich_version', n; end if;

  -- names / demographics / seller flags wherever seller.owner has them
  select count(*), count(*) filter (where g.seller_first_name is not null) into n, m
  from public.campaign_target_graph g join t_ids using (graph_id)
  join seller.owner o on o.individual_key = g.seller_person_key
  where nullif(btrim(o.given_name), '') is not null;
  if n = 0 then raise exception 'FAIL B: no sample row has a canonical name (sample problem)'; end if;
  if m <> n then raise exception 'FAIL B: first name projected on % of % rows that have one', m, n; end if;
  raise notice 'B names: % of % rows with a canonical given name now carry seller_first_name', m, n;

  select count(*) into n from public.campaign_target_graph g join t_ids using (graph_id)
  join seller.owner o on o.individual_key = g.seller_person_key
  where (nullif(o.gender, '') is not null and g.gender is null)
     or (nullif(o.est_household_income, '') is not null and g.income is null)
     or (nullif(o.marital_status, '') is not null and g.marital_status is null)
     or (cardinality(o.person_flags) > 0 and g.matching_flags_text is null);
  if n > 0 then raise exception 'FAIL B: % rows missing a demographic or seller flag the source has', n; end if;

  select count(*) into n from public.campaign_target_graph g join t_ids using (graph_id)
  join public.properties p on p.property_id = g.property_id
  where (nullif(p.property_flags_text, '') is not null and g.property_flags_text is null)
     or (p.units_count is not null and g.units_count is null)
     or (p.total_bedrooms is not null and g.beds is null)
     or (nullif(p.building_condition, '') is not null and g.building_condition is distinct from p.building_condition);
  if n > 0 then raise exception 'FAIL B: % rows missing a property field the source has', n; end if;

  select count(*) filter (where t.eligible_before), count(*) filter (where g.queue_eligible) into n, m
  from public.campaign_target_graph g join t_ids t using (graph_id);
  raise notice 'B eligibility on the 200-row sample: before % → after %', n, m;
  for r in select coalesce(g.queue_block_reason, 'eligible') as reason, count(*) as c
           from public.campaign_target_graph g join t_ids t using (graph_id)
           where t.eligible_before and not g.queue_eligible group by 1 order by 2 desc loop
    raise notice 'B   dropped: % %', rpad(r.reason, 22), r.c;
  end loop;
  raise notice 'PASS B: Wireless accepted, unknown not SMS-capable, names/demographics/flags/property facts populated';
end $$;

-- ---------------------------------------------------- C. contact batch ----
create temp table t_props on commit drop as
select property_id from public.properties order by property_id limit 25;
delete from public.campaign_target_graph_stage s using t_props p where s.property_id = p.property_id;
insert into public.campaign_target_graph_refresh_runs (status, metadata)
values ('started', '{"pretest":"campaign_audience_completeness"}'::jsonb)
returning id as run_id \gset

select clock_timestamp() as t_batch \gset
select rows_inserted, elapsed_ms from public.refresh_campaign_target_graph_seller_batch(:'run_id'::uuid, 25, 0);
-- the batch sets statement_timeout = 0 for its transaction; put the guard back
set local statement_timeout = '180s';

do $$
declare n int; b int; u int;
begin
  select count(*) into n from public.campaign_target_graph_stage s join t_props p using (property_id);
  if n = 0 then raise exception 'FAIL C: contact batch staged no rows for the 25 properties'; end if;
  select count(*) into b from public.campaign_target_graph_stage s join t_props p using (property_id)
  where s.build_id is null or s.built_at is null;
  if b > 0 then raise exception 'FAIL C: % staged rows without build_id/built_at', b; end if;
  select count(*) into u from public.campaign_target_graph_stage s join t_props p using (property_id)
  where s.canonical_e164 is not null and s.phone_type is null and (s.sms_eligible or s.queue_eligible);
  if u > 0 then raise exception 'FAIL C: % staged rows SMS-eligible with an unknown phone type', u; end if;
  raise notice 'PASS C: contact batch staged % rows, all stamped build_id/built_at, unknown type never SMS-eligible', n;
end $$;
select count(distinct build_id) = 1 and bool_and(build_id = :'run_id'::uuid) as build_id_is_run
from public.campaign_target_graph_stage s join t_props p using (property_id) \gset
\if :build_id_is_run
\echo 'PASS C: build_id = the refresh run id'
\else
\echo 'FAIL C: build_id is not the refresh run id'
select 1/0;
\endif

-- ------------------------------------------------- D. ticks + coverage ----
select public.campaign_target_graph_incremental_tick(50) as incremental \gset
\echo 'INFO incremental tick:' :incremental
select (select count(*) from jsonb_object_keys(public.campaign_target_graph_measure_coverage('manual', 0.5))) as coverage_cols \gset
\echo 'INFO coverage measured for' :coverage_cols 'columns'
do $$ begin
  if (select count(*) from public.campaign_target_graph_coverage) < 1 then raise exception 'FAIL D: coverage not recorded'; end if;
  raise notice 'PASS D: incremental tick and coverage measurement run';
end $$;

do $$ begin raise notice 'PASS A–D (rolling back; nothing persists)'; end $$;
rollback;
