-- PROPOSED ONLY — run BEFORE applying PROPOSED_20261010120000_agent_s3_persistence.sql (gate B).
-- Read-only. Raises (aborting the apply session) if any prerequisite is missing
-- or if the target already exists. Run inside the same session as the apply:
--   psql "$DB" -v ON_ERROR_STOP=1 -f ..._pretest.sql -f ..._persistence.sql
do $$
begin
  if current_setting('server_version_num')::int < 150000 then
    raise exception 'pretest: PostgreSQL >= 15 required, found %', current_setting('server_version');
  end if;
  if to_regprocedure('gen_random_uuid()') is null then
    raise exception 'pretest: gen_random_uuid() missing';
  end if;
  if to_regprocedure('auth.uid()') is null then
    raise exception 'pretest: auth.uid() missing (Supabase auth schema required for RLS policies)';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')
     or not exists (select 1 from pg_roles where rolname = 'authenticated')
     or not exists (select 1 from pg_roles where rolname = 'anon') then
    raise exception 'pretest: Supabase roles service_role / authenticated / anon required';
  end if;
  if not (select rolbypassrls from pg_roles where rolname = 'service_role') then
    raise exception 'pretest: service_role must bypass RLS (it is the only writer)';
  end if;
  -- the applying role owns the SECURITY DEFINER functions; with FORCE RLS it must bypass RLS
  if not (select rolbypassrls or rolsuper from pg_roles where rolname = current_user) then
    raise exception 'pretest: applying role % must have BYPASSRLS (FORCE ROW LEVEL SECURITY + security definer functions)', current_user;
  end if;
  if to_regclass('agent.run') is not null or to_regclass('agent.run_event') is not null then
    raise exception 'pretest: agent.run / agent.run_event already exist — the S1 PROPOSED schema or a previous apply is present; reconcile first';
  end if;
  if exists (select 1 from pg_namespace where nspname = 'agent')
     and exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'agent') then
    raise exception 'pretest: schema agent exists and is not empty';
  end if;
  if to_regclass('public.idempotency_ledger') is null then
    raise exception 'pretest: public.idempotency_ledger (reused for tool idempotency) is missing';
  end if;
  -- the scoped agent_api policy is only a boundary if RLS is on for the ledger
  if not (select relrowsecurity from pg_class where oid = 'public.idempotency_ledger'::regclass) then
    raise exception 'pretest: RLS must be enabled on public.idempotency_ledger';
  end if;
  -- SECURITY DEFINER functions any role could execute through PUBLIC that the
  -- migration cannot fix (owned by another role). Allowlist: PostGIS read-only metadata.
  declare v_list text;
  begin
    select string_agg(p.oid::regprocedure::text, ', ' order by 1) into v_list
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.prosecdef
       and n.nspname not in ('agent', 'pg_catalog', 'information_schema')
       and pg_get_userbyid(p.proowner) <> current_user
       and p.proname not in ('st_estimatedextent')
       and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
       and exists (select 1 from aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a where a.grantee = 0 and a.privilege_type = 'USAGE');
    if v_list is not null then
      raise exception 'pretest: PUBLIC-executable SECURITY DEFINER functions owned by another role would be reachable by agent_api: %', v_list;
    end if;
  end;
  raise notice 'pretest: OK';
end
$$;
