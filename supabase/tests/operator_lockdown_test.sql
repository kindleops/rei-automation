-- lc-fixture: posttest
-- =============================================================================
-- POSTTEST for supabase/migrations/20261003130000_operator_lockdown.sql (sections A–E).
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production — not even
-- inside BEGIN … ROLLBACK. Run through the migration test runner on a disposable database.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id operator_lockdown --prod-shape …
-- rc-8.5.15.1: formerly a "rollback-only pretest" that \ir-included the migrations and the
-- rollback file inside its own transaction (and was run with psql against production).
-- operator_lockdown_pretest.sql records the BEFORE state in lc_mt; the runner applies the
-- lockdown; this file asserts A–E in ONE transaction ending in ROLLBACK; section F (the
-- rollback file restores the catalog) is operator_lockdown_rollback_test.sql.
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
\set op_uid    'a2ee0ffe-6f27-475b-a795-ee617c9472c6'
\set nonop_uid '00000000-0000-4000-8000-00000000beef'
select pins_before, pins_ms_before from lc_mt.t_vars \gset

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

-- ------------------------------------------------------ A / B / C ----
do $$
declare r record; op bigint; nonop bigint; an bigint; fails int := 0;
begin
  for r in select * from lc_mt.t_pre order by rel loop
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
  raise notice 'PASS A/B/C on % dashboard relations', (select count(*) from lc_mt.t_pre);
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
  for q in select t.name, t.sql, p.plan from lc_mt.t_q t join lc_mt.t_plan_pre p using (name) loop
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
  for r in select t.name, t.sql, p.svc from lc_mt.t_rpc t join lc_mt.t_rpc_pre p using (name) loop
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

do $$ begin raise notice 'PASS A–E (rolling back; nothing persists)'; end $$;
rollback;
