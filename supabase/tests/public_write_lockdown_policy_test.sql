-- =============================================================================
-- Public write lockdown policy test. Run AFTER applying
-- supabase/migrations/20261001121000_public_write_lockdown.sql
--
-- One transaction ending in ROLLBACK. Denials are proven with statements that
-- cannot change data:
--   INSERT ... DEFAULT VALUES inside a subtransaction. The permission check
--     runs at executor start, before any row is built, so a granted INSERT
--     shows up as success or as a constraint error. Both count as FAIL.
--   UPDATE ... WHERE false
--   DELETE ... WHERE false
-- TRUNCATE and the lock/claim RPCs are never executed; they are checked with
-- has_*_privilege. Run as postgres. The script prints NOTICE PASS lines and
-- ends with 'ALL PASS'.
-- =============================================================================

begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create temp table _lockdown_tables (t text primary key, anon_select boolean not null) on commit drop;
insert into _lockdown_tables values
  ('queue_global_execution_lock', false), ('queue_canary_authorizations', false),
  ('acquisition_opportunities', false), ('acquisition_opportunity_history', false),
  ('acquisition_score_snapshots', false), ('buyer_offers', false), ('buyer_agreements', false),
  ('emd_receipts', false), ('settlement_records', false), ('seller_automation_executions', false),
  ('seller_automation_execution_steps', false), ('seller_followup_state', false),
  ('contact_property_resolution', false), ('thread_identity_binding', false),
  ('workflow_scheduled_tasks', false), ('sms_templates', false),
  ('message_events', false);
grant select on _lockdown_tables to anon, authenticated, service_role;

-- ---------------------------------------------------------------- catalog ----
do $$
declare r record;
begin
  for r in select t, anon_select from _lockdown_tables loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || r.t)::regclass) then
      raise exception 'FAIL: RLS disabled on %', r.t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = r.t
                 and cmd in ('INSERT','UPDATE','DELETE','ALL')
                 and roles && array['anon','authenticated']::name[]) then
      raise exception 'FAIL: write policy for anon/authenticated on %', r.t;
    end if;
    if has_table_privilege('anon', 'public.' || r.t, 'INSERT') or has_table_privilege('anon', 'public.' || r.t, 'UPDATE')
       or has_table_privilege('anon', 'public.' || r.t, 'DELETE') or has_table_privilege('anon', 'public.' || r.t, 'TRUNCATE')
       or has_table_privilege('authenticated', 'public.' || r.t, 'INSERT') or has_table_privilege('authenticated', 'public.' || r.t, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || r.t, 'DELETE') or has_table_privilege('authenticated', 'public.' || r.t, 'TRUNCATE') then
      raise exception 'FAIL: anon/authenticated still hold a write grant on %', r.t;
    end if;
    if has_table_privilege('anon', 'public.' || r.t, 'SELECT') <> r.anon_select then
      raise exception 'FAIL: anon SELECT on % is %, expected %', r.t, not r.anon_select, r.anon_select;
    end if;
    if not has_table_privilege('authenticated', 'public.' || r.t, 'SELECT') then
      raise exception 'FAIL: authenticated lost SELECT on % (dashboard read/realtime)', r.t;
    end if;
    if not (has_table_privilege('service_role', 'public.' || r.t, 'INSERT')
            and has_table_privilege('service_role', 'public.' || r.t, 'UPDATE')
            and has_table_privilege('service_role', 'public.' || r.t, 'DELETE')) then
      raise exception 'FAIL: service_role lost a write grant on %', r.t;
    end if;
  end loop;
  if not (select rolbypassrls from pg_roles where rolname = 'service_role') then
    raise exception 'FAIL: service_role does not bypass RLS';
  end if;
  if exists (select 1 from unnest(array[
       'public.queue_acquire_global_execution_lock(text,uuid,text,text,integer)',
       'public.queue_release_global_execution_lock(uuid)',
       'public.backfill_acquisition_opportunities_from_threads()',
       'public.reconcile_acquisition_opportunities_from_canonical_truth()',
       'public.apply_template_quarantine(integer,numeric,integer,numeric,boolean)',
       'public.bulk_import_templates(jsonb)',
       'public.log_message_event(text,text,integer,text,text,text)']) f
     where has_function_privilege('anon', f, 'EXECUTE')
        or has_function_privilege('authenticated', f, 'EXECUTE')
        or not has_function_privilege('service_role', f, 'EXECUTE')) then
    raise exception 'FAIL: writer RPC EXECUTE is not service_role-only';
  end if;
  raise notice 'PASS catalog: RLS on, no anon/authenticated write grant or policy, RPCs service_role-only';
end $$;

-- Shared probe: attempt INSERT/UPDATE/DELETE on every table as the current role.
create or replace function pg_temp.probe_writes_denied(p_role text) returns void language plpgsql as $$
declare r record; v_col text;
begin
  for r in select t from _lockdown_tables loop
    select a.attname into v_col from pg_attribute a
     where a.attrelid = ('public.' || r.t)::regclass and a.attnum > 0 and not a.attisdropped
       and a.attgenerated = '' and a.attidentity <> 'a'
     order by a.attnum limit 1;
    begin
      execute format('insert into public.%I default values', r.t);
      raise exception 'FAIL: % INSERT into % succeeded', p_role, r.t;
    exception
      when insufficient_privilege then null;
      when others then
        if sqlerrm like 'FAIL:%' then raise; end if;
        raise exception 'FAIL: % INSERT into % passed the permission check (then: %)', p_role, r.t, sqlerrm;
    end;
    begin
      execute format('update public.%I set %I = %I where false', r.t, v_col, v_col);
      raise exception 'FAIL: % UPDATE on % allowed', p_role, r.t;
    exception when insufficient_privilege then null;
    end;
    begin
      execute format('delete from public.%I where false', r.t);
      raise exception 'FAIL: % DELETE on % allowed', p_role, r.t;
    exception when insufficient_privilege then null;
    end;
  end loop;
  raise notice 'PASS % INSERT/UPDATE/DELETE denied on all % tables', p_role, (select count(*) from _lockdown_tables);
end $$;
grant execute on function pg_temp.probe_writes_denied(text) to anon, authenticated;

-- ------------------------------------------------------------------- anon ----
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select pg_temp.probe_writes_denied('anon');
do $$
begin
  begin
    perform 1 from public.acquisition_opportunities limit 1;
    raise exception 'FAIL: anon can still read acquisition_opportunities';
  exception when insufficient_privilege then
    raise notice 'PASS anon SELECT denied (acquisition_opportunities)';
  end;
end $$;
reset role;

-- ---------------------------------------------------------- authenticated ----
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000000"}', true);
select pg_temp.probe_writes_denied('authenticated');
do $$
declare r record;
begin
  for r in select t from _lockdown_tables loop
    execute format('select 1 from public.%I limit 1', r.t);   -- dashboard read / realtime path
  end loop;
  raise notice 'PASS authenticated SELECT allowed on every table';
end $$;
reset role;

-- ----------------------------------------------------------- service_role ----
-- The apps/api / worker / operator path. A no-op UPDATE and DELETE prove the
-- verbs are permitted without changing data.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare r record; v_col text;
begin
  for r in select t from _lockdown_tables loop
    select a.attname into v_col from pg_attribute a
     where a.attrelid = ('public.' || r.t)::regclass and a.attnum > 0 and not a.attisdropped
       and a.attgenerated = '' and a.attidentity <> 'a'
     order by a.attnum limit 1;
    execute format('update public.%I set %I = %I where false', r.t, v_col, v_col);
    execute format('delete from public.%I where false', r.t);
    execute format('select 1 from public.%I limit 1', r.t);
  end loop;
  raise notice 'PASS service_role SELECT/UPDATE/DELETE permitted on every table';
end $$;
reset role;

do $$ begin raise notice 'ALL PASS'; end $$;

rollback;
