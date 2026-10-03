-- =============================================================================
-- Rollback-only pretest for
--   supabase/migrations/PROPOSED_20261003120000_operator_read_policies.sql
--
-- Run with psql as the DB owner (postgres), from the repo root:
--   psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/operator_read_policies_test.sql
-- It needs psql because it pulls the migration in with \ir, so the test always
-- exercises the exact file that will be applied.
--
-- Everything runs in ONE transaction that ends in ROLLBACK. Nothing survives:
-- not the table, the function, the policies, the grants or the seed row. While it
-- runs, CREATE POLICY holds ACCESS EXCLUSIVE locks on the 16 tables until the
-- ROLLBACK, so API reads of properties, campaign_target_graph and the rest WAIT
-- for the post-apply section, which takes seconds (the heavy BEFORE probes run
-- before any lock is taken). Run it off-peak, outside a feeder or campaign tick.
--
-- What it proves (every check RAISEs on failure; it ends with 'ALL PASS'):
--   1. Allowed operator (a2ee0ffe-...) : rows > 0 wherever service role sees rows.
--   2. Authenticated NON-operator      : 0 rows on every relation, with no error.
--   3. anon                            : exactly the same visibility as before.
--   4. Catalog: SELECT-only policies; helper is SECURITY DEFINER + STABLE +
--      search_path=''; the allowlist is unreadable by anon/authenticated; anon
--      gained no grant.
--   5. EXPLAIN for the key dashboard queries, as the operator: the gate is a
--      hoisted One-Time Filter (InitPlan, once per query) and the index is used.
--   6. The SECURITY INVOKER RPCs (comps, buyers) return rows for the operator.
-- Before/after counts print as NOTICE lines.
-- =============================================================================

\set ON_ERROR_STOP on
begin;
set local statement_timeout = '120s';

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

create temp table t_rel (rel text primary key) on commit drop;
insert into t_rel values
  ('properties'),('prospects'),('master_owners'),('phones'),('emails'),('campaigns'),
  ('campaign_targets'),('campaign_target_graph'),('recently_sold_properties'),
  ('sms_suppression_list'),('sub_owners'),('thread_ai_state'),
  ('property_acquisition_scores'),('universal_lead_command_cache'),
  ('property_cash_offer_snapshots'),('sms_campaign_targets');

\set op_uid    'a2ee0ffe-6f27-475b-a795-ee617c9472c6'
\set nonop_uid '00000000-0000-4000-8000-00000000beef'

-- ------------------------------------------------------- BEFORE state ----
create temp table t_pre on commit drop as
select rel,
       pg_temp.probe(rel, null,            null)          as svc,
       pg_temp.probe(rel, 'anon',          null)          as anon_pre,
       pg_temp.probe(rel, 'authenticated', :'op_uid')     as op_pre,
       has_table_privilege('anon', ('public.' || rel)::regclass, 'SELECT') as anon_grant_pre
from t_rel;

-- Sample keys for the key dashboard queries (read as postgres).
create temp table t_keys on commit drop as
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

-- --------------------------------------------------- APPLY (in txn) ----
\ir ../migrations/PROPOSED_20261003120000_operator_read_policies.sql

-- -------------------------------------------------------- catalog ----
do $$
declare r record;
begin
  if not exists (select 1 from public.ops_operators where user_id = 'a2ee0ffe-6f27-475b-a795-ee617c9472c6') then
    raise exception 'FAIL: operator seed row missing';
  end if;
  select p.prosecdef, p.provolatile, p.proconfig into r
    from pg_proc p where p.oid = 'public.is_ops_operator()'::regprocedure;
  if not r.prosecdef then raise exception 'FAIL: is_ops_operator is not SECURITY DEFINER'; end if;
  if r.provolatile <> 's' then raise exception 'FAIL: is_ops_operator is not STABLE'; end if;
  if not (r.proconfig @> array['search_path=""']) then
    raise exception 'FAIL: is_ops_operator search_path is not empty: %', r.proconfig;
  end if;
  if has_function_privilege('anon', 'public.is_ops_operator()', 'EXECUTE') then
    raise exception 'FAIL: anon can execute is_ops_operator';
  end if;
  if has_table_privilege('anon', 'public.ops_operators', 'SELECT')
     or has_table_privilege('authenticated', 'public.ops_operators', 'SELECT') then
    raise exception 'FAIL: the allowlist is readable by anon/authenticated';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ops_operators') then
    raise exception 'FAIL: ops_operators must have no policies';
  end if;
  if exists (select 1 from pg_policies
             where schemaname = 'public' and policyname = 'ops_operator_read'
               and (cmd <> 'SELECT' or roles <> array['authenticated']::name[])) then
    raise exception 'FAIL: an ops_operator_read policy is not SELECT-to-authenticated';
  end if;
  if (select count(*) from pg_policies p join t_rel t on t.rel = p.tablename
       where p.schemaname = 'public' and p.policyname = 'ops_operator_read') <> 16 then
    raise exception 'FAIL: expected 16 ops_operator_read policies';
  end if;
  raise notice 'PASS catalog: helper definer/stable/search_path, allowlist sealed, 16 SELECT-only policies';
end $$;

-- ------------------------------------------------------ AFTER probes ----
create temp table t_post on commit drop as
select p.rel, p.svc, p.anon_pre, p.op_pre, p.anon_grant_pre,
       pg_temp.probe(p.rel, 'authenticated', :'op_uid')    as op_post,
       pg_temp.probe(p.rel, 'authenticated', :'nonop_uid') as nonop_post,
       pg_temp.probe(p.rel, 'anon',          null)         as anon_post,
       has_table_privilege('anon', ('public.' || p.rel)::regclass, 'SELECT') as anon_grant_post
from t_pre p;

do $$
declare r record;
begin
  for r in select * from t_post order by rel loop
    raise notice '% | svc(cap 1000)=% | operator before=% after=% | non-operator after=% | anon before=% after=%',
      rpad(r.rel, 30), r.svc, r.op_pre, r.op_post, r.nonop_post, r.anon_pre, r.anon_post;
    if r.svc > 0 and r.op_post <= 0 then
      raise exception 'FAIL: operator still sees nothing on % (svc=%)', r.rel, r.svc;
    end if;
    if r.op_post < 0 then raise exception 'FAIL: operator denied on %', r.rel; end if;
    if r.nonop_post <> 0 then
      raise exception 'FAIL: non-operator authenticated user got % on %', r.nonop_post, r.rel;
    end if;
    if r.anon_post is distinct from r.anon_pre or r.anon_grant_post is distinct from r.anon_grant_pre then
      raise exception 'FAIL: anon visibility changed on % (% -> %)', r.rel, r.anon_pre, r.anon_post;
    end if;
  end loop;
  raise notice 'PASS probes: operator reads restored, non-operator 0, anon unchanged';
end $$;

-- ------------------------------------------- key dashboard queries ----
-- Each query runs as the operator: a count (vs postgres), then EXPLAIN. Assert
-- the gate is hoisted (One-Time Filter) and the expected index is used.
create temp table t_q (name text, sql text, want_index boolean) on commit drop;
insert into t_q
select * from (values
  ('map.universe_count',
     'select count(property_id) from public.properties', false),
  ('comps/map.property_by_id',
     format('select * from public.properties where property_id = %L limit 1', (select property_id from t_keys)), true),
  ('inbox/queue.properties_in_100',
     format('select property_id, property_address_full, market from public.properties where property_id = any(%L::text[])', (select prop_ids from t_keys)), true),
  ('map.master_owner_by_id',
     format('select * from public.master_owners where master_owner_id = %L limit 1', (select master_owner_id from t_keys)), true),
  ('map.prospects_by_owner',
     format('select * from public.prospects where master_owner_id = %L', (select prospect_owner from t_keys)), true),
  ('map.phones_by_owner',
     format('select * from public.phones where master_owner_id = %L', (select phone_owner from t_keys)), true),
  ('map.ownership_graph_pair',
     format('select * from public.campaign_target_graph where property_id = %L and master_owner_id = %L', (select property_id from t_keys), (select master_owner_id from t_keys)), true),
  ('inbox.buyer_match_sold_by_zip',
     format('select * from public.recently_sold_properties where property_address_zip = %L and sale_price is not null order by sale_date desc limit 50', (select zip from t_keys)), true),
  ('campaigns.list',
     'select id, name, status from public.campaigns order by created_at desc limit 200', false),
  ('campaigns.targets_for_list',
     format('select campaign_id, status from public.campaign_targets where campaign_id = any(%L::uuid[])', (select campaign_ids from t_keys)), false),
  ('nexus.hot_lead_count',
     'select count(*) from public.thread_ai_state where deal_temperature = ''hot''', false)
) v(name, sql, want_index);

do $$
declare q record; n_svc bigint; n_op bigint; plan text;
begin
  for q in select * from t_q loop
    execute format('select count(*) from (%s) s', q.sql) into n_svc;
    n_op := pg_temp.run_as(format('select count(*) from (%s) s', q.sql), 'authenticated',
                           'a2ee0ffe-6f27-475b-a795-ee617c9472c6')::bigint;
    plan := pg_temp.run_as('explain (costs off) ' || q.sql, 'authenticated',
                           'a2ee0ffe-6f27-475b-a795-ee617c9472c6');
    raise notice '% rows: service=% operator=%', rpad(q.name, 32), n_svc, n_op;
    if plan like '%One-Time Filter: false%' then
      raise notice '  (skipped plan check for %: no sample key in prod)', q.name;
      continue;
    end if;
    if n_op <> n_svc then
      raise exception 'FAIL: % operator count % <> service count %', q.name, n_op, n_svc;
    end if;
    -- Once per query: an InitPlan (shown as a One-Time Filter or as an InitPlan
    -- param inside a Filter), never a per-row SubPlan.
    if plan not like '%InitPlan%' or plan like '%SubPlan%' then
      raise exception 'FAIL: % gate not evaluated once per query:%', q.name, E'\n' || plan;
    end if;
    if q.want_index and plan not like '%Index%' then
      raise exception 'FAIL: % lost its index under RLS:%', q.name, E'\n' || plan;
    end if;
  end loop;
  raise notice 'PASS explain: gate is a once-per-query InitPlan, indexes kept';
end $$;

-- Informational, not asserted: ILIKE is not LEAKPROOF, so under RLS it cannot be
-- an index qual. This compares the Advanced-Filters-style plan before and after.
do $$
declare p_svc text; p_op text;
  s text := 'select count(*) from public.properties where property_address_full ilike ''%main st%''';
begin
  p_svc := pg_temp.run_as('explain (costs off) ' || s, null, null);
  p_op  := pg_temp.run_as('explain (costs off) ' || s, 'authenticated', 'a2ee0ffe-6f27-475b-a795-ee617c9472c6');
  raise notice 'INFO ilike plan as service:%', E'\n' || p_svc;
  raise notice 'INFO ilike plan as operator:%', E'\n' || p_op;
end $$;

-- ------------------------------------------------ invoker RPCs ----
do $$
declare k record; svc bigint; op bigint;
begin
  select * into k from t_keys;
  execute format('select count(*) from public.get_comp_candidates_for_subject(%L, 2, 24, 50)', k.property_id) into svc;
  op := pg_temp.run_as(format('select count(*) from public.get_comp_candidates_for_subject(%L, 2, 24, 50)', k.property_id),
                       'authenticated', 'a2ee0ffe-6f27-475b-a795-ee617c9472c6')::bigint;
  raise notice 'rpc get_comp_candidates_for_subject: service=% operator=%', svc, op;
  if op <> svc then raise exception 'FAIL: comps RPC differs for operator'; end if;
  execute format('select count(*) from public.get_buyers_for_property(%L, 20)', k.property_id) into svc;
  op := pg_temp.run_as(format('select count(*) from public.get_buyers_for_property(%L, 20)', k.property_id),
                       'authenticated', 'a2ee0ffe-6f27-475b-a795-ee617c9472c6')::bigint;
  raise notice 'rpc get_buyers_for_property: service=% operator=%', svc, op;
  if op <> svc then raise exception 'FAIL: buyers RPC differs for operator'; end if;
  op := pg_temp.run_as(format('select count(*) from public.get_comp_candidates_for_subject(%L, 2, 24, 50)', k.property_id),
                       'authenticated', '00000000-0000-4000-8000-00000000beef')::bigint;
  if op <> 0 then raise exception 'FAIL: non-operator gets comps rows'; end if;
  raise notice 'PASS rpc: invoker RPCs restored for operator, still empty for non-operator';
end $$;

do $$ begin raise notice 'ALL PASS (rolling back; nothing persists)'; end $$;
rollback;
