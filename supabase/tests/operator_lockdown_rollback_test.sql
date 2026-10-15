-- lc-fixture: posttest
-- =============================================================================
-- ROLLBACK POSTTEST (section F) for supabase/rollbacks/20261003130000_operator_lockdown.rollback.sql:
-- runs AFTER the runner applied the rollback file; the rollback restores the pre-lockdown
-- catalog recorded by operator_lockdown_pretest.sql (ACLs, policies, RLS, functions, view
-- columns exact; view text exact or deparse-normal).
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production — not even
-- inside BEGIN … ROLLBACK. Run through the migration test runner on a disposable database.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id operator_lockdown --prod-shape …
-- =============================================================================
\set ON_ERROR_STOP on
begin;

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

do $$
declare n int; cosmetic text;
begin
  create temp table t_state_post on commit drop as select * from pg_temp.catalog_state();
  -- Views whose restored text is the one-round-trip normal form of the original.
  select string_agg(p.o, ', ') into cosmetic
  from lc_mt.t_state_pre p join t_state_post q on q.k = p.k and q.o = p.o
  join lc_mt.t_viewnorm v on v.relname = p.o
  where p.k = 'view' and q.v <> p.v and q.v = v.norm_md5;
  if cosmetic is not null then
    raise notice 'F: restored as deparse normal form (same query, same columns; alias-only text change): %', cosmetic;
  end if;
  select count(*) into n from (
    (select * from lc_mt.t_state_pre except select * from t_state_post)
    union all
    (select * from t_state_post except select * from lc_mt.t_state_pre)
  ) d
  where not (d.k = 'view' and exists (
          select 1 from lc_mt.t_viewnorm v join t_state_post q on q.k = 'view' and q.o = v.relname
          where v.relname = d.o and q.v = v.norm_md5));
  if n > 0 then
    raise warning 'rollback diff: %', (select string_agg(k || ':' || o, ', ') from (
      (select * from lc_mt.t_state_pre except select * from t_state_post)
      union all (select * from t_state_post except select * from lc_mt.t_state_pre)) d
      where not (d.k = 'view' and exists (
          select 1 from lc_mt.t_viewnorm v join t_state_post q on q.k = 'view' and q.o = v.relname
          where v.relname = d.o and q.v = v.norm_md5)));
    raise exception 'FAIL F: rollback left % catalog differences', n;
  end if;
  raise notice 'PASS F: rollback restores the pre-lockdown catalog (ACLs, policies, RLS, functions, view columns exact; view text exact or deparse-normal)';
end $$;

do $$ begin raise notice 'ALL PASS (rolling back; nothing persists)'; end $$;
rollback;
