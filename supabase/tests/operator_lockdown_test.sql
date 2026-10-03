-- =============================================================================
-- Rollback-only pretest for
--   supabase/migrations/PROPOSED_20261003130000_operator_lockdown.sql
-- and its rollback,
--   supabase/rollbacks/PROPOSED_20261003130000_operator_lockdown.rollback.sql
--
-- Run with psql as postgres, from the repo root:
--   psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/operator_lockdown_test.sql
--
-- ONE transaction, ending in ROLLBACK. If operator_read_policies is not applied yet,
-- it is pulled in first (with \ir), then the lockdown, then the checks, then the
-- lockdown ROLLBACK FILE (also with \ir). The test then proves that the rollback
-- restores the exact pre-lockdown catalog, and finally rolls everything back.
-- While it runs it holds ACCESS EXCLUSIVE locks on ~100 tables and views, so the
-- API waits. It takes tens of seconds. Run off-peak, outside a feeder tick, with
-- the owner present.
--
-- What it proves (every check RAISEs on failure; it ends with 'ALL PASS'):
--   A. Operator: every relation the dashboard reads returns exactly what it returned
--      before the lockdown (capped count). It WARNs on any pre-existing gap (service
--      sees rows, operator sees none).
--   B. Authenticated non-operator: 0 rows or permission denied on all of them; 42501
--      from the gated map RPCs; 0 pins.
--   C. anon: denied on all of them, and holds no privilege on any postgres-owned
--      relation in public (except INSERT on inquiries/onboarding_events), no
--      EXECUTE on any definer function, and no TRUNCATE anywhere.
--   D. EXPLAIN, operator after vs service before, on the heavy relations. The gate must
--      be a once-per-query InitPlan (no SubPlan), a parallel plan must stay parallel,
--      and there must be no new Seq Scan on a large table. If an index used before is missing after, it prints REVIEW
--      with both plans.
--   E. Map RPCs: the operator gets exactly the service result (scalar results are
--      hashed, so the call really runs). The non-operator is refused by the gate (-2)
--      and anon is refused EXECUTE (-1). Pin RPC timing
--      before and after is printed.
--   F. The rollback restores ACLs, policies, function definitions, RLS flags,
--      default ACLs and view columns exactly. View text must be exact or equal to
--      its deparse normal form; see t_viewnorm for why.
-- =============================================================================

\set ON_ERROR_STOP on
begin;
set local statement_timeout = '180s';

select to_regprocedure('public.is_ops_operator()') is null as need_read_policies \gset
\if :need_read_policies
\echo 'operator_read_policies not applied: applying it inside this transaction first'
\ir ../migrations/20261003120000_operator_read_policies.sql
\endif

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
create temp table t_rel on commit drop as
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
create temp table t_state_pre on commit drop as select * from pg_temp.catalog_state();

create temp table t_pre on commit drop as
select rel,
       pg_temp.probe(format('select count(*) from (select 1 from public.%I limit 1000) s', rel), null, null)                 as svc,
       pg_temp.probe(format('select count(*) from (select 1 from public.%I limit 1000) s', rel), 'authenticated', :'op_uid') as op_pre
from t_rel;

-- Deparse normal form of the 13 gated views. The rollback can only restore a view
-- from its deparsed text, and deparse is not always a fixpoint. Prod 2026-10-03:
-- number_performance_kpis_v / template_performance_kpis_v have a CTE whose later
-- UNION ALL arms carry no alias. Re-parsing the deparsed text names them after the
-- cast (`'24h'::text AS text`). That alias is ignored: a UNION takes its column names
-- from the first arm. So the restored view is the same query with different text.
-- F accepts a view definition that equals either the original text or its
-- one-round-trip normal form. Column names and types are compared exactly.
create temp table t_viewnorm (relname text primary key, norm_md5 text) on commit drop;
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
    insert into t_viewnorm values (r.relname, md5(pg_get_viewdef('pg_temp._ops_vn'::regclass)));
    drop view pg_temp._ops_vn;
  end loop;
end $$;

create temp table t_keys on commit drop as
select g.property_id, g.master_owner_id
from public.campaign_target_graph g
where g.property_id is not null and g.master_owner_id is not null
limit 1;

-- Heavy dashboard queries, planned as service BEFORE (index names recorded).
create temp table t_q (name text, sql text) on commit drop;
insert into t_q
select * from (values
  ('properties.by_id',          format('select * from public.properties where property_id = %L', (select property_id from t_keys))),
  ('ownership.links_by_prop',   format('select * from public.map_filter_property_prospect_links where property_id = %L', (select property_id from t_keys))),
  ('ownership.graph_pair',      format('select * from public.campaign_target_graph where property_id = %L and master_owner_id = %L', (select property_id from t_keys), (select master_owner_id from t_keys))),
  ('map.work_item_by_prop',     format('select * from public.v_seller_work_items where property_id = %L', (select property_id from t_keys))),
  ('map.pin_feed_by_prop',      format('select * from public.v_command_map_seller_pin_feed where property_id = %L', (select property_id from t_keys))),
  ('comps.recent_sold_by_prop', format('select * from public.v_recent_sold_comps where property_id = %L', (select property_id from t_keys))),
  ('inbox.threads_by_owner',    format('select * from public.v_operator_inbox_threads where master_owner_id = %L limit 50', (select master_owner_id from t_keys))),
  ('messages.by_property',      format('select * from public.message_events where property_id = %L order by created_at desc limit 100', (select property_id from t_keys)))
) v(name, sql);

create temp table t_plan_pre on commit drop as
select name, pg_temp.lines('explain (costs off) ' || sql, null, null) as plan from t_q;

-- Map RPCs: service result and pin timing BEFORE.
create temp table t_rpc (name text, sql text) on commit drop;
-- Scalar/jsonb RPCs: the probe must CONSUME the returned value. In
-- `select count(*) from (select f(...)) s` the planner drops the unused STABLE
-- call: the function never runs, no EXECUTE check happens, and the count is
-- always 1. That was the 2026-10-03 E false-fail. Hash the value instead:
-- identical results give identical numbers (abs, so they are never negative), and
-- refusals surface as -1/-2.
insert into t_rpc values
  ('map_search',              'select abs(coalesce(hashtext(public.map_search(''dallas'')::text), 0)::bigint)'),
  ('get_map_area_intel',      'select abs(coalesce(hashtext(public.get_map_area_intel(32.78, -96.80)::text), 0)::bigint)'),
  ('get_map_area_summary',    'select abs(coalesce(hashtext(public.get_map_area_summary(''[[-96.81,32.77],[-96.79,32.77],[-96.79,32.79],[-96.81,32.79]]''::jsonb)::text), 0)::bigint)'),
  ('get_map_lens_areas',      'select count(*) from public.get_map_lens_areas(''equity'', 32.6, -97.0, 33.0, -96.6, 9)'),
  ('get_map_lens_points',     'select count(*) from public.get_map_lens_points(''equity'', 32.6, -97.0, 33.0, -96.6, 11)'),
  ('get_map_sold_comps',      'select count(*) from public.get_map_sold_comps(32.6, -97.0, 33.0, -96.6, 11, ''{}''::jsonb)'),
  ('get_map_sold_comps_list', 'select count(*) from public.get_map_sold_comps_list(32.6, -97.0, 33.0, -96.6, ''{}''::jsonb)'),
  ('get_command_map_seller_pins', 'select count(*) from public.get_command_map_seller_pins(32.6, -97.0, 33.0, -96.6, 12, 500)'),
  ('get_comp_candidates_for_subject', format('select count(*) from public.get_comp_candidates_for_subject(%L, 2, 24, 50)', (select property_id from t_keys))),
  ('get_buyers_for_property', format('select count(*) from public.get_buyers_for_property(%L, 20)', (select property_id from t_keys)));
create temp table t_rpc_pre on commit drop as
select name, pg_temp.probe(sql, null, null) as svc from t_rpc;

select clock_timestamp() as t0 \gset
select pg_temp.probe('select count(*) from public.get_command_map_seller_pins(32.6, -97.0, 33.0, -96.6, 12, 500)', 'authenticated', :'op_uid') as pins_before \gset
select round(extract(epoch from clock_timestamp() - :'t0'::timestamptz) * 1000) as pins_ms_before \gset

-- ---------------------------------------------------------- APPLY ----
\ir ../migrations/PROPOSED_20261003130000_operator_lockdown.sql

-- ------------------------------------------------------ A / B / C ----
do $$
declare r record; op bigint; nonop bigint; an bigint; fails int := 0;
begin
  for r in select * from t_pre order by rel loop
    op    := pg_temp.probe(format('select count(*) from (select 1 from public.%I limit 1000) s', r.rel), 'authenticated', 'a2ee0ffe-6f27-475b-a795-ee617c9472c6');
    nonop := pg_temp.probe(format('select count(*) from (select 1 from public.%I limit 1000) s', r.rel), 'authenticated', '00000000-0000-4000-8000-00000000beef');
    an    := pg_temp.probe(format('select count(*) from (select 1 from public.%I limit 1000) s', r.rel), 'anon', null);
    raise notice '% svc=% | operator before=% after=% | non-operator=% | anon=%', rpad(r.rel, 34), r.svc, r.op_pre, op, nonop, an;
    if op <> r.op_pre then fails := fails + 1; raise warning 'FAIL A operator changed on %', r.rel; end if;
    if r.svc > 0 and op <= 0 then
      raise warning 'GAP (not caused by the lockdown): operator sees nothing on % although service sees % rows', r.rel, r.svc;
    end if;
    if nonop > 0 then fails := fails + 1; raise warning 'FAIL B non-operator sees rows on %', r.rel; end if;
    if an <> -1 then fails := fails + 1; raise warning 'FAIL C anon not denied on %', r.rel; end if;
  end loop;
  if fails > 0 then raise exception 'FAIL: % dashboard-relation checks failed (see warnings)', fails; end if;
  raise notice 'PASS A/B/C on % dashboard relations', (select count(*) from t_pre);
end $$;

do $$
begin
  if exists (select 1 from pg_class c
             where c.relnamespace = 'public'::regnamespace and c.relowner = 'postgres'::regrole
               and c.relkind in ('r','p','v','m')
               and (has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('anon', c.oid, 'UPDATE')
                    or has_table_privilege('anon', c.oid, 'DELETE') or has_table_privilege('anon', c.oid, 'TRUNCATE')
                    or (has_table_privilege('anon', c.oid, 'INSERT') and c.relname not in ('inquiries','onboarding_events')))) then
    raise exception 'FAIL C: anon still holds a privilege on a public relation';
  end if;
  if exists (select 1 from pg_proc p
             where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace, 'comp_private'::regnamespace)
               and p.proowner = 'postgres'::regrole
               and p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE')) then
    raise exception 'FAIL C: anon can still execute a SECURITY DEFINER function';
  end if;
  -- inbox_filter_field_options (2026-06-19): service_role only. The dashboard reaches it
  -- only through the API (7e0f2f7a), so a direct call is refused for every browser role.
  if has_function_privilege('anon', 'public.inbox_filter_field_options(text,text,jsonb,text,text[])', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.inbox_filter_field_options(text,text,jsonb,text,text[])', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.inbox_filter_field_options(text,text,jsonb,text,text[])', 'EXECUTE') then
    raise exception 'FAIL C: inbox_filter_field_options is not service_role-only';
  end if;
  if pg_temp.probe('select count(*) from (select public.inbox_filter_field_options(''text'', null, ''[]''::jsonb, null, null)) s',
                   'authenticated', 'a2ee0ffe-6f27-475b-a795-ee617c9472c6') <> -1
     or pg_temp.probe('select count(*) from (select public.inbox_filter_field_options(''text'', null, ''[]''::jsonb, null, null)) s',
                      'anon', null) <> -1 then
    raise exception 'FAIL C: inbox_filter_field_options callable from a browser role';
  end if;
  -- Tenant RLS helpers still evaluable by authenticated.
  if exists (select 1 from pg_proc where oid in ('public.is_ops_operator()'::regprocedure,
                 'public.ops_read_allowed()'::regprocedure, 'public.assert_ops_read_allowed()'::regprocedure)
             and proparallel <> 's') then
    raise exception 'FAIL C: an operator gate helper is not PARALLEL SAFE (would serialise every gated query)';
  end if;
  if not has_function_privilege('authenticated', 'private.is_org_member(uuid)', 'EXECUTE') then
    raise exception 'FAIL C: private.is_org_member lost authenticated EXECUTE (tenant policies would break)';
  end if;
  if exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relowner = 'postgres'::regrole
               and c.relkind in ('r','p')
               and (has_table_privilege('anon', c.oid, 'TRUNCATE') or has_table_privilege('authenticated', c.oid, 'TRUNCATE'))) then
    raise exception 'FAIL C: TRUNCATE still granted';
  end if;
  if exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('v','m')
               and c.relowner = 'postgres'::regrole
               and (has_table_privilege('authenticated', c.oid, 'INSERT') or has_table_privilege('authenticated', c.oid, 'UPDATE')
                    or has_table_privilege('authenticated', c.oid, 'DELETE'))) then
    raise exception 'FAIL: authenticated can still write through a view';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='inbox_activity_events' and policyname='ops_operator_all')
     or not exists (select 1 from pg_policies where schemaname='public' and tablename='buyer_match_candidates' and policyname='ops_operator_all') then
    raise exception 'FAIL: the two dashboard write paths lost their operator policy';
  end if;
  raise notice 'PASS C catalog: anon sealed, no definer EXECUTE (public/private/comp_private), inbox_filter_field_options service_role-only, no TRUNCATE, no write-through views; operator write policies present';
end $$;

-- ---------------------------------------------------------- D. EXPLAIN ----
do $$
declare q record; pre text; post text; idx text; fails int := 0;
begin
  for q in select t.name, t.sql, p.plan from t_q t join t_plan_pre p using (name) loop
    post := pg_temp.lines('explain (costs off) ' || q.sql, 'authenticated', 'a2ee0ffe-6f27-475b-a795-ee617c9472c6');
    for idx in select distinct m[1] from regexp_matches(q.plan, 'Index (?:Only )?Scan(?: Backward)? using (\S+)', 'g') m loop
      if position(idx in post) = 0 then
        -- Reported for review rather than failed: the gate's parameter qual can nudge
        -- cost-based choices (for example ORDER BY ... LIMIT), which is not a
        -- regression in itself. A new Seq Scan on a big relation IS a failure (below).
        raise warning 'REVIEW D %: index % used before, not after. Before:%After:%', q.name, idx, E'\n' || q.plan, E'\n' || post;
      end if;
    end loop;
    -- The gate must be an InitPlan (evaluated once per query). It may show as a
    -- One-Time Filter or as an InitPlan param inside a Filter. Never a SubPlan,
    -- which would mean once per row.
    if post not like '%InitPlan%' or post like '%SubPlan%' then
      fails := fails + 1;
      raise warning 'FAIL D %: gate not evaluated once per query:%', q.name, E'\n' || post;
    end if;
    if post ~ 'Seq Scan on (properties|prospects|master_owners|phones|emails|campaign_target_graph|map_filter_property_prospect_links|message_events|send_queue|recently_sold_properties)\M'
       and q.plan !~ 'Seq Scan on (properties|prospects|master_owners|phones|emails|campaign_target_graph|map_filter_property_prospect_links|message_events|send_queue|recently_sold_properties)\M' then
      fails := fails + 1;
      raise warning 'FAIL D %: new Seq Scan on a large table under the gate:%', q.name, E'\n' || post;
    end if;
    if q.plan ~ 'Gather' and post !~ 'Gather' then
      fails := fails + 1;
      raise warning 'FAIL D %: parallel plan lost under the gate (a parallel-unsafe helper?):%', q.name, E'\n' || post;
    end if;
    raise notice 'EXPLAIN % checked', q.name;
  end loop;
  if fails > 0 then raise exception 'FAIL D: % plan regressions', fails; end if;
  raise notice 'PASS D: gate is a once-per-query InitPlan; no new large-table Seq Scan (see any REVIEW warnings)';
end $$;

-- ------------------------------------------------------------- E. RPCs ----
do $$
declare r record; op bigint; nonop bigint; an bigint; fails int := 0;
begin
  for r in select t.name, t.sql, p.svc from t_rpc t join t_rpc_pre p using (name) loop
    op    := pg_temp.probe(r.sql, 'authenticated', 'a2ee0ffe-6f27-475b-a795-ee617c9472c6');
    nonop := pg_temp.probe(r.sql, 'authenticated', '00000000-0000-4000-8000-00000000beef');
    an    := pg_temp.probe(r.sql, 'anon', null);
    raise notice 'rpc % service(before)=% operator=% non-operator=% anon=%  (-1 = no EXECUTE, -2 = operator gate)', rpad(r.name, 32), r.svc, op, nonop, an;
    if r.svc < 0 then fails := fails + 1; raise warning 'FAIL E % errored for service BEFORE (probe or fixture problem)', r.name; end if;
    if op <> r.svc then fails := fails + 1; raise warning 'FAIL E operator differs on % (service % vs operator %)', r.name, r.svc, op; end if;
    if an <> -1 then fails := fails + 1; raise warning 'FAIL E anon not denied EXECUTE on % (got %)', r.name, an; end if;
    if r.name in ('map_search','get_map_area_intel','get_map_area_summary','get_map_lens_areas',
                  'get_map_lens_points','get_map_sold_comps','get_map_sold_comps_list') then
      if nonop <> -2 then fails := fails + 1; raise warning 'FAIL E non-operator not refused by the gate on % (got %)', r.name, nonop; end if;
    elsif nonop > 0 then
      fails := fails + 1; raise warning 'FAIL E non-operator got rows from %', r.name;
    end if;
  end loop;
  if fails > 0 then raise exception 'FAIL E: % RPC checks failed', fails; end if;
  raise notice 'PASS E: map RPCs identical for the operator, refused for non-operator and anon';
end $$;

select clock_timestamp() as t1 \gset
select pg_temp.probe('select count(*) from public.get_command_map_seller_pins(32.6, -97.0, 33.0, -96.6, 12, 500)', 'authenticated', :'op_uid') as pins_after \gset
select round(extract(epoch from clock_timestamp() - :'t1'::timestamptz) * 1000) as pins_ms_after \gset
\echo 'INFO pins RPC (operator): before' :pins_before 'rows in' :pins_ms_before 'ms | after' :pins_after 'rows in' :pins_ms_after 'ms'

-- --------------------------------------------------------- F. ROLLBACK ----
\ir ../rollbacks/PROPOSED_20261003130000_operator_lockdown.rollback.sql

do $$
declare n int; cosmetic text;
begin
  create temp table t_state_post on commit drop as select * from pg_temp.catalog_state();
  -- Views whose restored text is the one-round-trip normal form of the original.
  select string_agg(p.o, ', ') into cosmetic
  from t_state_pre p join t_state_post q on q.k = p.k and q.o = p.o
  join t_viewnorm v on v.relname = p.o
  where p.k = 'view' and q.v <> p.v and q.v = v.norm_md5;
  if cosmetic is not null then
    raise notice 'F: restored as deparse normal form (same query, same columns; alias-only text change): %', cosmetic;
  end if;
  select count(*) into n from (
    (select * from t_state_pre except select * from t_state_post)
    union all
    (select * from t_state_post except select * from t_state_pre)
  ) d
  where not (d.k = 'view' and exists (
          select 1 from t_viewnorm v join t_state_post q on q.k = 'view' and q.o = v.relname
          where v.relname = d.o and q.v = v.norm_md5));
  if n > 0 then
    raise warning 'rollback diff: %', (select string_agg(k || ':' || o, ', ') from (
      (select * from t_state_pre except select * from t_state_post)
      union all (select * from t_state_post except select * from t_state_pre)) d
      where not (d.k = 'view' and exists (
          select 1 from t_viewnorm v join t_state_post q on q.k = 'view' and q.o = v.relname
          where v.relname = d.o and q.v = v.norm_md5)));
    raise exception 'FAIL F: rollback left % catalog differences', n;
  end if;
  raise notice 'PASS F: rollback restores the pre-lockdown catalog (ACLs, policies, RLS, functions, view columns exact; view text exact or deparse-normal)';
end $$;

do $$ begin raise notice 'ALL PASS (rolling back; nothing persists)'; end $$;
rollback;
