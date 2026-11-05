-- lc-fixture: pretest
-- =============================================================================
-- PRETEST (BEFORE capture) for supabase/migrations/20261003130000_operator_lockdown.sql.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production — not even
-- inside BEGIN … ROLLBACK. Run through the migration test runner on a disposable database.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id operator_lockdown --prod-shape …
-- rc-8.5.15.1: this was the first part of operator_lockdown_test.sql, which \ir-included
-- operator_read_policies (conditionally), the lockdown and its rollback file inside its own
-- transaction. The runner now applies the read policies (setup), the lockdown (apply) and the
-- rollback file; this file only records the BEFORE state into the runner's scratch schema
-- lc_mt (absent in production: this file fails fast anywhere else).
-- =============================================================================
\set ON_ERROR_STOP on
do $$ begin if to_regnamespace('lc_mt') is null then raise exception 'lc_mt scratch schema missing: run this only through scripts/db/run-migration-test.mjs on a disposable database'; end if; end $$;
do $$ begin if to_regprocedure('public.is_ops_operator()') is null then raise exception 'operator_read_policies must be applied first (the runner setup applies it)'; end if; end $$;
set statement_timeout = '180s';
\set op_uid    'a2ee0ffe-6f27-475b-a795-ee617c9472c6'
\set nonop_uid '00000000-0000-4000-8000-00000000beef'

-- -------------------------------------------------------------- helpers ----
create function pg_temp.probe(p_sql text, p_role text, p_sub text)
returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claims',
    case when p_role is null then '' else json_build_object('sub', p_sub, 'role', p_role, 'aud', p_role)::text end, true);
  if p_role is not null then perform set_config('role', p_role, true); end if;
  begin
    execute p_sql into n;
  exception when insufficient_privilege then
    -- -2 = refused by assert_ops_read_allowed() (the operator gate)
    -- -1 = permission denied (no grant / no EXECUTE)
    n := case when sqlerrm like 'operator access required%' then -2 else -1 end;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  return n;
end $$;

create function pg_temp.lines(p_sql text, p_role text, p_sub text)
returns text language plpgsql as $$
declare line text; acc text := '';
begin
  perform set_config('request.jwt.claims',
    case when p_role is null then '' else json_build_object('sub', p_sub, 'role', p_role, 'aud', p_role)::text end, true);
  if p_role is not null then perform set_config('role', p_role, true); end if;
  for line in execute p_sql loop acc := acc || line || E'\n'; end loop;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  return acc;
end $$;

create function pg_temp.catalog_state()
returns table (k text, o text, v text) language sql as $$
  select 'rel', c.oid::regclass::text,
         (select string_agg(x::text, ',' order by x::text) from unnest(coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))) x) || '|rls=' || c.relrowsecurity
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','S')
  union all
  select 'pol', tablename || '.' || policyname,
         permissive || '|' || cmd || '|' || array_to_string(roles, ',') || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '')
  from pg_policies where schemaname = 'public'
  union all
  select 'fn', p.oid::regprocedure::text,
         -- NULL proacl means the default ACL; GRANT/REVOKE materialize it, so compare it
         -- in materialized form (acldefault) to keep the comparison semantic.
         (select string_agg(x::text, ',' order by x::text) from unnest(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) x) || '|' ||
         case when p.prokind = 'f' and p.prolang = (select oid from pg_language where lanname = 'plpgsql')
              then md5(p.prosrc) else '' end || '|par=' || p.proparallel::text
  from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace, 'comp_private'::regnamespace)
  union all
  select 'view', c.relname, md5(pg_get_viewdef(c.oid))
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
  union all
  select 'viewcols', c.relname,
         (select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' order by a.attnum)
            from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
  union all
  select 'defacl', pg_get_userbyid(defaclrole) || '.' || defaclobjtype::text,
         (select string_agg(x::text, ',' order by x::text) from unnest(defaclacl) x)
  from pg_default_acl where defaclnamespace = 'public'::regnamespace
$$;

-- Every relation the dashboard reads directly (audit 2026-10-03), that exists in prod.
drop table if exists lc_mt.t_rel;
create table lc_mt.t_rel as
select r as rel from unnest(array[
  'ai_decisions', 'buyer_activity_geo_rollups', 'buyer_entities_v2', 'buyer_match_candidates', 'buyer_match_runs',
  'buyer_profiles', 'buyer_profiles_computed', 'buyer_purchase_events_v2', 'campaign_target_graph', 'campaign_targets',
  'campaigns', 'census_geo_metrics', 'contact_outreach_state', 'conversation_threads', 'conversation_turns',
  'emails', 'inbox_activity_events', 'inbox_thread_state', 'map_filter_property_prospect_links', 'master_owners',
  'message_events', 'negotiation_events', 'number_performance_kpis_v', 'operator_thread_state', 'performance_message_events_v',
  'phones', 'properties', 'property_acquisition_scores', 'property_cash_offer_snapshots', 'property_participant_graph',
  'prospects', 'recently_sold_properties', 'recently_sold_properties_computed', 'routing_decisions', 'seller_automation_execution_steps',
  'seller_automation_executions', 'seller_state_snapshots', 'send_queue', 'sms_campaign_targets', 'sms_suppression_list',
  'sms_templates', 'sub_owners', 'template_performance_kpis_v', 'textgrid_numbers', 'thread_ai_state',
  'top_buyer_profiles', 'universal_lead_command_cache', 'v_buyer_entity_leaderboard', 'v_buyer_entity_purchases', 'v_command_map_seller_pin_feed',
  'v_map_property_pins', 'v_operator_inbox_threads', 'v_recent_sold_comps', 'v_seller_work_items', 'v_universal_inbox_threads'
]) r where to_regclass('public.' || r) is not null;

-- ------------------------------------------------ BEFORE the lockdown ----
drop table if exists lc_mt.t_state_pre;
create table lc_mt.t_state_pre as select * from pg_temp.catalog_state();

drop table if exists lc_mt.t_pre;
create table lc_mt.t_pre as
select rel,
       pg_temp.probe(format('select count(*) from (select 1 from public.%I limit 1000) s', rel), null, null)                 as svc,
       pg_temp.probe(format('select count(*) from (select 1 from public.%I limit 1000) s', rel), 'authenticated', :'op_uid') as op_pre
from lc_mt.t_rel;

-- Deparse normal form of the 13 gated views. The rollback can only restore a view
-- from its deparsed text, and deparse is not always a fixpoint. Prod 2026-10-03:
-- number_performance_kpis_v / template_performance_kpis_v have a CTE whose later
-- UNION ALL arms carry no alias. Re-parsing the deparsed text names them after the
-- cast (`'24h'::text AS text`). That alias is ignored: a UNION takes its column names
-- from the first arm. So the restored view is the same query with different text.
-- F accepts a view definition that equals either the original text or its
-- one-round-trip normal form. Column names and types are compared exactly.
drop table if exists lc_mt.t_viewnorm;
create table lc_mt.t_viewnorm (relname text primary key, norm_md5 text);
do $$
declare r record; d text;
begin
  for r in select c.oid, c.relname from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
             and c.relname = any (array['v_command_map_seller_pin_feed','v_map_property_pins','v_operator_inbox_threads',
               'v_recent_sold_comps','v_seller_work_items','v_universal_inbox_threads','property_participant_graph',
               'performance_message_events_v','number_performance_kpis_v','template_performance_kpis_v',
               'top_buyer_profiles','buyer_profiles_computed','recently_sold_properties_computed']) loop
    d := regexp_replace(pg_get_viewdef(r.oid), ';\s*$', '');
    execute format('create temp view _ops_vn as %s', d);
    insert into lc_mt.t_viewnorm values (r.relname, md5(pg_get_viewdef('pg_temp._ops_vn'::regclass)));
    drop view pg_temp._ops_vn;
  end loop;
end $$;

drop table if exists lc_mt.t_keys;
create table lc_mt.t_keys as
select g.property_id, g.master_owner_id
from public.campaign_target_graph g
where g.property_id is not null and g.master_owner_id is not null
limit 1;

-- Heavy dashboard queries, planned as service BEFORE (index names recorded).
drop table if exists lc_mt.t_q;
create table lc_mt.t_q (name text, sql text);
insert into lc_mt.t_q
select * from (values
  ('properties.by_id',          format('select * from public.properties where property_id = %L', (select property_id from lc_mt.t_keys))),
  ('ownership.links_by_prop',   format('select * from public.map_filter_property_prospect_links where property_id = %L', (select property_id from lc_mt.t_keys))),
  ('ownership.graph_pair',      format('select * from public.campaign_target_graph where property_id = %L and master_owner_id = %L', (select property_id from lc_mt.t_keys), (select master_owner_id from lc_mt.t_keys))),
  ('map.work_item_by_prop',     format('select * from public.v_seller_work_items where property_id = %L', (select property_id from lc_mt.t_keys))),
  ('map.pin_feed_by_prop',      format('select * from public.v_command_map_seller_pin_feed where property_id = %L', (select property_id from lc_mt.t_keys))),
  ('comps.recent_sold_by_prop', format('select * from public.v_recent_sold_comps where property_id = %L', (select property_id from lc_mt.t_keys))),
  ('inbox.threads_by_owner',    format('select * from public.v_operator_inbox_threads where master_owner_id = %L limit 50', (select master_owner_id from lc_mt.t_keys))),
  ('messages.by_property',      format('select * from public.message_events where property_id = %L order by created_at desc limit 100', (select property_id from lc_mt.t_keys)))
) v(name, sql);

drop table if exists lc_mt.t_plan_pre;
create table lc_mt.t_plan_pre as
select name, pg_temp.lines('explain (costs off) ' || sql, null, null) as plan from lc_mt.t_q;

-- Map RPCs: service result and pin timing BEFORE.
drop table if exists lc_mt.t_rpc;
create table lc_mt.t_rpc (name text, sql text);
-- Scalar/jsonb RPCs: the probe must CONSUME the returned value. In
-- `select count(*) from (select f(...)) s` the planner drops the unused STABLE
-- call: the function never runs, no EXECUTE check happens, and the count is
-- always 1. That was the 2026-10-03 E false-fail. Hash the value instead:
-- identical results give identical numbers (abs, so they are never negative), and
-- refusals surface as -1/-2.
insert into lc_mt.t_rpc values
  ('map_search',              'select abs(coalesce(hashtext(public.map_search(''dallas'')::text), 0)::bigint)'),
  ('get_map_area_intel',      'select abs(coalesce(hashtext(public.get_map_area_intel(32.78, -96.80)::text), 0)::bigint)'),
  ('get_map_area_summary',    'select abs(coalesce(hashtext(public.get_map_area_summary(''[[-96.81,32.77],[-96.79,32.77],[-96.79,32.79],[-96.81,32.79]]''::jsonb)::text), 0)::bigint)'),
  ('get_map_lens_areas',      'select count(*) from public.get_map_lens_areas(''equity'', 32.6, -97.0, 33.0, -96.6, 9)'),
  ('get_map_lens_points',     'select count(*) from public.get_map_lens_points(''equity'', 32.6, -97.0, 33.0, -96.6, 11)'),
  ('get_map_sold_comps',      'select count(*) from public.get_map_sold_comps(32.6, -97.0, 33.0, -96.6, 11, ''{}''::jsonb)'),
  ('get_map_sold_comps_list', 'select count(*) from public.get_map_sold_comps_list(32.6, -97.0, 33.0, -96.6, ''{}''::jsonb)'),
  ('get_command_map_seller_pins', 'select count(*) from public.get_command_map_seller_pins(32.6, -97.0, 33.0, -96.6, 12, 500)'),
  ('get_comp_candidates_for_subject', format('select count(*) from public.get_comp_candidates_for_subject(%L, 2, 24, 50)', (select property_id from lc_mt.t_keys))),
  ('get_buyers_for_property', format('select count(*) from public.get_buyers_for_property(%L, 20)', (select property_id from lc_mt.t_keys)));
drop table if exists lc_mt.t_rpc_pre;
create table lc_mt.t_rpc_pre as
select name, pg_temp.probe(sql, null, null) as svc from lc_mt.t_rpc;

select clock_timestamp() as t0 \gset
select pg_temp.probe('select count(*) from public.get_command_map_seller_pins(32.6, -97.0, 33.0, -96.6, 12, 500)', 'authenticated', :'op_uid') as pins_before \gset
select round(extract(epoch from clock_timestamp() - :'t0'::timestamptz) * 1000) as pins_ms_before \gset
drop table if exists lc_mt.t_vars;
create table lc_mt.t_vars as select :'pins_before'::text as pins_before, :'pins_ms_before'::text as pins_ms_before;
