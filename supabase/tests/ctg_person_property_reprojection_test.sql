-- =============================================================================
-- Rollback-only pretest for
--   supabase/migrations/PROPOSED_20261007180000_ctg_person_property_reprojection.sql
-- and its rollback (…_rollback.sql).
--
-- Run with psql as postgres, from the repo root, OFF-PEAK:
--   psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/ctg_person_property_reprojection_test.sql
--
-- ONE transaction, ending in ROLLBACK. Nothing persists. The UPDATEs below hold row
-- locks on ~250 graph rows until the ROLLBACK (seconds); no table-level DDL.
--
-- Proves (each check RAISEs on failure; ends with 'ALL PASS'):
--   A. the new functions exist and are not executable by anon/authenticated;
--   B. age parsing: YYYYMM, YYYY-MM, MM/YYYY and junk;
--   C. reproject_rows(person,property,scores) on 200 rows fills prospect_id /
--      demographics / property facts wherever the source has them, never touches
--      eligibility, and a second run writes 0 rows (idempotent);
--   D. reproject_batch walks the keyset and returns a stable cursor;
--   E. enrich_rows (v2) on 50 rows still stamps enriched_at and phone_type and agrees
--      with the person source;
--   F. the rollback restores enrich_rows / incremental_tick / stage_commit verbatim.
-- =============================================================================

\set ON_ERROR_STOP on
begin;
set local statement_timeout = '120s';
set local lock_timeout = '5s';

create temp table _before on commit drop as
select p.proname, md5(pg_get_functiondef(p.oid)) as def_md5
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('campaign_target_graph_enrich_rows','campaign_target_graph_incremental_tick','refresh_campaign_target_graph_stage_commit');

\ir ../migrations/PROPOSED_20261007180000_ctg_person_property_reprojection.sql

-- A ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.campaign_target_graph_person_source(text[])',
    'public.campaign_target_graph_property_source(text[])',
    'public.campaign_target_graph_reproject_rows(text[],text[])',
    'public.campaign_target_graph_reproject_batch(text,integer,text[],text)'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception 'A: % is executable by anon/authenticated', f;
    end if;
  end loop;
  raise notice 'A pass';
end $$;

-- B ---------------------------------------------------------------------------
do $$
begin
  if public.campaign_birth_month_age('196111', date '2026-10-07') <> 64 then raise exception 'B: YYYYMM'; end if;
  if public.campaign_birth_month_age('1961-11', date '2026-10-07') <> 64 then raise exception 'B: YYYY-MM'; end if;
  if public.campaign_birth_month_age('05/1965', date '2026-10-07') <> 61 then raise exception 'B: MM/YYYY'; end if;
  if public.campaign_birth_month_age('199913', date '2026-10-07') is not null then raise exception 'B: month 13'; end if;
  if public.campaign_birth_month_age('abc') is not null or public.campaign_birth_month_age(null) is not null then raise exception 'B: junk'; end if;
  if public.campaign_age_bucket(64) <> '55-64' or public.campaign_age_bucket(17) is not null or public.campaign_age_bucket(80) <> '75+' then
    raise exception 'B: buckets';
  end if;
  raise notice 'B pass';
end $$;

-- C ---------------------------------------------------------------------------
create temp table _ids on commit drop as
select graph_id from public.campaign_target_graph where seller_person_key is not null order by graph_id limit 200;
create temp table _elig_before on commit drop as
select graph_id, sms_eligible, queue_eligible, queue_block_reason, enriched_at, sender_covered
from public.campaign_target_graph where graph_id in (select graph_id from _ids);

do $$
declare
  v_ids text[] := array(select graph_id from _ids);
  v_first integer; v_second integer; v_bad integer; v_src_gender integer; v_gender integer; v_pid integer; v_cond integer;
begin
  v_first := public.campaign_target_graph_reproject_rows(v_ids, array['person','property','scores']);
  v_second := public.campaign_target_graph_reproject_rows(v_ids, array['person','property','scores']);
  if v_second <> 0 then raise exception 'C: second run wrote % rows (not idempotent)', v_second; end if;

  select count(*) into v_bad from public.campaign_target_graph g join _elig_before b using (graph_id)
  where (g.sms_eligible, g.queue_eligible, g.queue_block_reason, g.enriched_at, g.sender_covered)
        is distinct from (b.sms_eligible, b.queue_eligible, b.queue_block_reason, b.enriched_at, b.sender_covered);
  if v_bad > 0 then raise exception 'C: % rows had eligibility/enriched_at touched', v_bad; end if;

  select count(*) filter (where gender is not null) into v_src_gender from public.campaign_target_graph_person_source(v_ids);
  select count(*) filter (where gender is not null), count(*) filter (where prospect_id is not null),
         count(*) filter (where building_condition is not null)
    into v_gender, v_pid, v_cond
  from public.campaign_target_graph where graph_id = any(v_ids);
  if v_gender <> v_src_gender then raise exception 'C: gender % in graph vs % in source', v_gender, v_src_gender; end if;
  if v_gender < 150 then raise exception 'C: gender filled on only % of 200 person-keyed rows', v_gender; end if;
  if v_pid = 0 then raise exception 'C: no prospect_id projected'; end if;
  if v_cond = 0 then raise exception 'C: no building_condition projected'; end if;

  begin
    perform public.campaign_target_graph_reproject_rows(v_ids, array['bogus']);
    raise exception 'C: bogus set accepted';
  exception when others then
    if sqlerrm like 'C:%' then raise; end if;
  end;
  raise notice 'C pass: first run wrote %, gender %/200, prospect_id %, building_condition %', v_first, v_gender, v_pid, v_cond;
end $$;

-- D ---------------------------------------------------------------------------
do $$
declare r record; r2 record;
begin
  select * into r from public.campaign_target_graph_reproject_batch(null, 25, array['person']);
  if r.skipped is null and (r.rows_scanned <> 25 or r.next_after_graph_id is null or not r.has_more) then
    raise exception 'D: first batch %', row_to_json(r);
  end if;
  select * into r2 from public.campaign_target_graph_reproject_batch(r.next_after_graph_id, 25, array['person']);
  if r2.skipped is null and r2.next_after_graph_id <= r.next_after_graph_id then
    raise exception 'D: cursor did not advance';
  end if;
  raise notice 'D pass: % / %', row_to_json(r), row_to_json(r2);
end $$;

-- E ---------------------------------------------------------------------------
do $$
declare v_ids text[] := array(select graph_id from _ids order by graph_id desc limit 50); v integer; v_mismatch integer;
begin
  v := public.campaign_target_graph_enrich_rows(v_ids);
  if v <> 50 then raise exception 'E: enrich_rows updated % of 50', v; end if;
  select count(*) into v_mismatch from public.campaign_target_graph g
  join public.campaign_target_graph_person_source(v_ids) s using (graph_id)
  where g.enriched_at is null or g.enrich_version <> 'ctg_enrich_v2'
     or (g.gender, g.age_bucket, g.prospect_id) is distinct from (s.gender, s.age_bucket, s.prospect_id);
  if v_mismatch > 0 then raise exception 'E: % rows disagree with the person source', v_mismatch; end if;
  raise notice 'E pass';
end $$;

-- F ---------------------------------------------------------------------------
\ir ../migrations/PROPOSED_20261007180000_ctg_person_property_reprojection_rollback.sql
do $$
declare v_diff integer; v_left integer;
begin
  select count(*) into v_diff from _before b
  join pg_proc p on p.proname = b.proname join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
  where md5(pg_get_functiondef(p.oid)) <> b.def_md5;
  if v_diff > 0 then raise exception 'F: % functions not restored verbatim', v_diff; end if;
  select count(*) into v_left from pg_proc where proname in
    ('campaign_target_graph_person_source','campaign_target_graph_property_source','campaign_target_graph_reproject_rows',
     'campaign_target_graph_reproject_batch','campaign_age_bucket','campaign_birth_month_age');
  if v_left > 0 then raise exception 'F: % new functions remain', v_left; end if;
  raise notice 'F pass';
end $$;

select 'ALL PASS' as result;
rollback;
