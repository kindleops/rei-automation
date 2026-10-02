-- =============================================================================
-- send_queue access policy test — run AFTER applying
-- supabase/migrations/20261001120000_send_queue_rls_lockdown.sql
--
-- Everything runs in ONE transaction that ends in ROLLBACK: no row survives.
-- DML denials are proven with statements that cannot touch rows (WHERE false)
-- or with has_*_privilege checks; TRUNCATE and the claim RPCs are never
-- executed for real (a successful TRUNCATE/claim would lock or move the live
-- queue even inside a transaction). The service_role leg inserts one inert,
-- uncommitted row (invisible to the runner) and removes it.
--
-- Run as postgres (SQL editor / psql). Every check RAISEs on failure; the
-- script prints NOTICE 'PASS ...' lines and finishes with 'ALL PASS'.
-- Before the migration is applied, the anon-insert check fails — that is the
-- expected red state that proves the test bites.
-- =============================================================================

begin;
set local lock_timeout = '3s';
set local statement_timeout = '15s';

-- ---------------------------------------------------------------- catalog ----
do $$
begin
  if exists (select 1 from pg_policies
             where schemaname = 'public' and tablename = 'send_queue'
               and cmd in ('INSERT','UPDATE','DELETE','ALL')
               and roles && array['anon','authenticated','public']::name[]) then
    raise exception 'FAIL: a write policy for anon/authenticated/public still exists on send_queue';
  end if;
  if has_table_privilege('anon', 'public.send_queue', 'SELECT')
     or exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'send_queue'
                  and roles && array['anon']::name[]) then
    raise exception 'FAIL: anon can still read send_queue';
  end if;
  if has_table_privilege('anon', 'public.send_queue', 'TRUNCATE')
     or has_table_privilege('authenticated', 'public.send_queue', 'TRUNCATE') then
    raise exception 'FAIL: anon/authenticated can TRUNCATE send_queue (RLS does not cover TRUNCATE)';
  end if;
  if has_function_privilege('anon', 'public.claim_queue_jobs(integer, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.mark_job_sent(uuid, text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.mark_job_failed(uuid, text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.unlock_stale_jobs(integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.queue_atomic_claim_send_row(uuid, text, uuid, text, text, uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.queue_guarded_mutate_scheduled_for(uuid[], timestamptz, text, jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.campaign_enqueue_next_touch(text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.claim_queue_jobs(integer, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.queue_guarded_mutate_scheduled_for(uuid[], timestamptz, text, jsonb)', 'EXECUTE') then
    raise exception 'FAIL: anon/authenticated can still EXECUTE a queue mutator RPC';
  end if;
  -- supported operator/API path: service_role keeps the RPCs it calls
  if not has_function_privilege('service_role', 'public.queue_guarded_mutate_scheduled_for(uuid[], timestamptz, text, jsonb)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.queue_atomic_claim_send_row(uuid, text, uuid, text, text, uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.claim_queue_jobs(integer, text)', 'EXECUTE') then
    raise exception 'FAIL: service_role lost EXECUTE on a queue RPC used by apps/api';
  end if;
  raise notice 'PASS catalog: no anon/authenticated write policy, no TRUNCATE, RPCs service_role-only';
end $$;

-- ------------------------------------------------------------------- anon ----
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
begin
  begin
    insert into public.send_queue (queue_key, message_body, to_phone_number, metadata)
    values ('rls_policy_test_anon_' || gen_random_uuid(), 'rls test', '+15550000000', '{"rls_policy_test":true}');
    raise exception 'FAIL: anon INSERT into send_queue was allowed';
  exception when insufficient_privilege then
    raise notice 'PASS anon INSERT denied';
  end;
  begin
    update public.send_queue set message_body = message_body where false;
    raise exception 'FAIL: anon UPDATE on send_queue was allowed';
  exception when insufficient_privilege then
    raise notice 'PASS anon UPDATE denied';
  end;
  begin
    delete from public.send_queue where false;
    raise exception 'FAIL: anon DELETE on send_queue was allowed';
  exception when insufficient_privilege then
    raise notice 'PASS anon DELETE denied';
  end;
end $$;
reset role;

-- ---------------------------------------------------------- authenticated ----
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000000"}', true);
do $$
begin
  perform 1 from public.send_queue limit 1;   -- dashboard read path must keep working
  raise notice 'PASS authenticated SELECT allowed';
  begin
    insert into public.send_queue (queue_key, message_body, to_phone_number, metadata)
    values ('rls_policy_test_auth_' || gen_random_uuid(), 'rls test', '+15550000000', '{"rls_policy_test":true}');
    raise exception 'FAIL: authenticated INSERT into send_queue was allowed';
  exception when insufficient_privilege then
    raise notice 'PASS authenticated INSERT denied';
  end;
  begin
    update public.send_queue set message_body = message_body where false;
    raise exception 'FAIL: authenticated UPDATE on send_queue was allowed';
  exception when insufficient_privilege then
    raise notice 'PASS authenticated UPDATE denied';
  end;
  begin
    delete from public.send_queue where false;
    raise exception 'FAIL: authenticated DELETE on send_queue was allowed';
  exception when insufficient_privilege then
    raise notice 'PASS authenticated DELETE denied';
  end;
end $$;
reset role;

-- ----------------------------------------------------------- service_role ----
-- This is the role used by apps/api (queue runner, feeder, campaign scheduler,
-- webhooks) and by the operator action route POST /api/cockpit/queue/control.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare
  v_id uuid;
  v_n  int;
begin
  insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, metadata)
  values ('rls_policy_test_svc_' || gen_random_uuid(), 'cancelled', 'rls test (never sent)', '+15550000000',
          '{"rls_policy_test":true,"no_send":true}')
  returning id into v_id;
  raise notice 'PASS service_role INSERT allowed';

  update public.send_queue set message_body = 'rls test (updated)' where id = v_id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL: service_role UPDATE touched % rows', v_n; end if;
  raise notice 'PASS service_role UPDATE allowed';

  delete from public.send_queue where id = v_id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL: service_role DELETE touched % rows', v_n; end if;
  raise notice 'PASS service_role DELETE allowed';
end $$;
reset role;

do $$ begin raise notice 'ALL PASS'; end $$;

rollback;
