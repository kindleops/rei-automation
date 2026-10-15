-- lc-fixture: pretest
-- =============================================================================
-- PRETEST (BEFORE capture) for supabase/migrations/20261003120000_operator_read_policies.sql.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production — not even
-- inside BEGIN … ROLLBACK. Run through the migration test runner on a disposable database.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id operator_read_policies
-- rc-8.5.15.1: this was the first half of operator_read_policies_test.sql, which \ir-included
-- the migration inside its own transaction. The runner now applies the migration; this file
-- only records the BEFORE state into the runner's scratch schema lc_mt (never present in
-- production, so this file fails fast anywhere else), and operator_read_policies_test.sql
-- (the posttest) asserts against it after the apply.
-- =============================================================================
\set ON_ERROR_STOP on
do $$ begin if to_regnamespace('lc_mt') is null then raise exception 'lc_mt scratch schema missing: run this only through scripts/db/run-migration-test.mjs on a disposable database'; end if; end $$;
set statement_timeout = '120s';
\set op_uid    'a2ee0ffe-6f27-475b-a795-ee617c9472c6'
\set nonop_uid '00000000-0000-4000-8000-00000000beef'

-- --------------------------------------------------------------- probes ----
-- Runs a capped count as a given role and JWT subject (p_role null = the
-- connecting owner, i.e. the service view). Returns -1 on permission denied.
-- The role is reset before returning.
create function pg_temp.probe(p_rel text, p_role text, p_sub text)
returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_sub, 'role', p_role, 'aud', p_role)::text, true);
  if p_role is not null then perform set_config('role', p_role, true); end if;
  begin
    execute format('select count(*) from (select 1 from public.%I limit 1000) s', p_rel) into n;
  exception when insufficient_privilege then
    n := -1;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  return n;
end $$;

-- Runs a query (count or EXPLAIN text) as a role and subject.
create function pg_temp.run_as(p_sql text, p_role text, p_sub text)
returns text language plpgsql as $$
declare line text; acc text := '';
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_sub, 'role', p_role, 'aud', p_role)::text, true);
  if p_role is not null then perform set_config('role', p_role, true); end if;
  for line in execute p_sql loop
    acc := acc || line || E'\n';
  end loop;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  return acc;
end $$;

drop table if exists lc_mt.t_rel;
create table lc_mt.t_rel (rel text primary key);
insert into lc_mt.t_rel values
  ('properties'),('prospects'),('master_owners'),('phones'),('emails'),('campaigns'),
  ('campaign_targets'),('campaign_target_graph'),('recently_sold_properties'),
  ('sms_suppression_list'),('sub_owners'),('thread_ai_state'),
  ('property_acquisition_scores'),('universal_lead_command_cache'),
  ('property_cash_offer_snapshots'),('sms_campaign_targets');


-- ------------------------------------------------------- BEFORE state ----
drop table if exists lc_mt.t_pre;
create table lc_mt.t_pre as
select rel,
       pg_temp.probe(rel, null,            null)          as svc,
       pg_temp.probe(rel, 'anon',          null)          as anon_pre,
       pg_temp.probe(rel, 'authenticated', :'op_uid')     as op_pre,
       has_table_privilege('anon', ('public.' || rel)::regclass, 'SELECT') as anon_grant_pre
from lc_mt.t_rel;

-- Sample keys for the key dashboard queries (read as postgres).
drop table if exists lc_mt.t_keys;
create table lc_mt.t_keys as
select g.property_id, g.master_owner_id,
       (select array_agg(property_id) from (select property_id from public.properties limit 100) s) as prop_ids,
       (select master_owner_id from public.prospects where master_owner_id is not null limit 1) as prospect_owner,
       (select master_owner_id from public.phones    where master_owner_id is not null limit 1) as phone_owner,
       (select property_address_zip from public.recently_sold_properties
          where property_address_zip is not null group by 1 order by count(*) desc limit 1) as zip,
       (select array_agg(id) from (select id from public.campaigns order by created_at desc limit 200) s) as campaign_ids
from public.campaign_target_graph g
where g.property_id is not null and g.master_owner_id is not null
limit 1;
