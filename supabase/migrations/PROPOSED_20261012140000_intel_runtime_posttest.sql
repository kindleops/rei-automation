-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261012140000_intel_runtime.sql (formerly the second half
-- of its pretest). Runs AFTER the runner applied the migration on a disposable database; asserts
-- schema, grants and behaviour (claim / dedupe / transitions / lease reap / cancel / emergency stop /
-- budget refusal / schedule slot / health snapshot) inside BEGIN … ROLLBACK.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id intel_runtime
-- Expected last notice: "pretest(intel_runtime): ALL OK (rolled back)".
\set ON_ERROR_STOP on
begin;

-- ── schema + grants ─────────────────────────────────────────────────────────
do $$
declare n int;
begin
  if (select count(*) from pg_class c where c.relnamespace = 'agent'::regnamespace and c.relkind = 'r' and not (c.relrowsecurity and c.relforcerowsecurity)) > 0 then
    raise exception 'assert: every agent table has RLS enabled + forced';
  end if;
  if exists (select 1 from agent.research_job where runtime_managed) then raise exception 'assert: existing research rows stay research'; end if;
  if exists (select 1 from agent.spend_ledger where job_id is not null or run_id is null) then raise exception 'assert: existing ledger rows stay run-owned'; end if;
  if (select runtime_enabled or emergency_stop or kind_limits <> '{}'::jsonb or max_concurrency_global <> 2 from agent.runtime_limits where id = 1) then
    raise exception 'assert: runtime born OFF (runtime_enabled=false, no kind enabled, global concurrency 2)';
  end if;
  if exists (select 1 from agent.runtime_schedule) then raise exception 'assert: no schedule is seeded'; end if;
  if exists (select 1 from pg_proc p where p.pronamespace = 'agent'::regnamespace and (p.proname like 'runtime\_%' or p.proname = 'ops_health_snapshot')
              and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))) then
    raise exception 'assert: anon / authenticated execute no runtime function';
  end if;
  if (select coalesce(string_agg(p.proname, ','), '') from pg_proc p where p.pronamespace = 'agent'::regnamespace and has_function_privilege('authenticated', p.oid, 'EXECUTE')) <> 'can_read_org' then
    raise exception 'assert: authenticated may execute only can_read_org';
  end if;
  if has_function_privilege('agent_api', 'agent.runtime_upsert_schedule(text, text, integer, text, jsonb, boolean, timestamptz, numeric)', 'EXECUTE')
     or has_function_privilege('agent_api', 'agent.runtime_enqueue_core(text, text, jsonb, text, text, text, integer, integer, numeric, boolean, bigint, timestamptz, timestamptz)', 'EXECUTE')
     or has_function_privilege('agent_api', 'agent.runtime_emit(agent.research_job, text, text, jsonb)', 'EXECUTE') then
    raise exception 'assert: agent_api cannot reach owner-only / internal runtime functions';
  end if;
  if not has_function_privilege('agent_api', 'agent.runtime_claim(text, integer, text[])', 'EXECUTE') then raise exception 'assert: agent_api executes runtime_claim'; end if;
  select count(*) into n from unnest(array['agent.job_event','agent.runtime_schedule','agent.runtime_heartbeat']) t, unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p
   where has_table_privilege('agent_api', t, p) or has_table_privilege('authenticated', t, p) or has_table_privilege('anon', t, p);
  if n > 0 then raise exception 'assert: runtime tables are read-only for every API role (% grants found)', n; end if;
  if has_table_privilege('anon', 'agent.job_event', 'SELECT') then raise exception 'assert: anon reads nothing'; end if;
  if exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where p.prosecdef and s.nspname = 'agent' and not exists (
       select 1 from unnest(p.proconfig) c where c like 'search_path=%')) then
    raise exception 'assert: every agent SECURITY DEFINER function pins search_path';
  end if;
  raise notice 'pretest(intel_runtime): schema + grants OK';
end
$$;

-- ── behaviour (all writes roll back) ────────────────────────────────────────
do $$
declare
  op constant text := '11111111-1111-4111-8111-111111111111';
  r jsonb; c jsonb; j1 text; j2 text; tok uuid; s jsonb; v_state text;
  idem1 constant text := encode(sha256('pretest-1'::bytea), 'hex');
  idem2 constant text := encode(sha256('pretest-2'::bytea), 'hex');
begin
  -- default OFF: nothing claims
  if (agent.runtime_claim('pretest', 2) ->> 'blocked') <> 'runtime_disabled' then raise exception 'assert: disabled runtime claims nothing'; end if;
  -- idempotent enqueue
  r := agent.runtime_enqueue('ops.health_check', idem1, '{}'::jsonb, op);
  j1 := r ->> 'job_id';
  if (r ->> 'state') <> 'queued' or (agent.runtime_enqueue('ops.health_check', idem1, '{}'::jsonb, op) ->> 'job_id') <> j1 then raise exception 'assert: idempotency key dedupes'; end if;
  if (agent.runtime_enqueue('ops.health_check', idem2, '{}'::jsonb, 'system:cron') ->> 'reason') <> 'requested_by_not_named_operator' then raise exception 'assert: named operator required'; end if;
  -- switches: enabled runtime but kind absent → nothing; then arm the kind
  update agent.runtime_limits set runtime_enabled = true where id = 1;
  if (agent.runtime_claim('pretest', 2) ->> 'blocked') <> 'no_kind_enabled' then raise exception 'assert: an absent kind claims nothing'; end if;
  update agent.runtime_limits set kind_limits = jsonb_build_object('ops.health_check', jsonb_build_object('enabled', true, 'max_concurrency', 1, 'armed_by', op)) where id = 1;
  -- emergency stop blocks claims
  perform agent.runtime_emergency_stop(op, 'pretest');
  if (agent.runtime_claim('pretest', 2) ->> 'blocked') <> 'emergency_stop' then raise exception 'assert: emergency stop blocks claims'; end if;
  update agent.runtime_limits set emergency_stop = false, emergency_stop_at = null, emergency_stop_by = null, emergency_stop_reason = null where id = 1;
  -- claim (per-kind concurrency 1)
  perform agent.runtime_enqueue('ops.health_check', idem2, '{}'::jsonb, op);
  c := agent.runtime_claim('pretest', 2);
  if jsonb_array_length(c -> 'claimed') <> 1 then raise exception 'assert: per-kind concurrency 1 claims exactly one (got %)', c; end if;
  tok := (c -> 'claimed' -> 0 ->> 'lease_token')::uuid;
  j1 := c -> 'claimed' -> 0 ->> 'job_id';
  -- illegal transition refused in SQL
  begin
    update agent.research_job set state = 'completed', ended_at = now(), lease_token = null, lease_owner = null, lease_until = null where job_id = j1;
    raise exception 'assert: claimed → completed must be refused';
  exception when check_violation then null;
  end;
  -- budget: research spend switched off ⇒ spend_ledger_guard refuses ⇒ budget_blocked
  update agent.research_limits set enabled = false where id = 1;
  perform agent.runtime_start(j1, tok);
  r := agent.runtime_reserve(j1, tok, 'claude-haiku-4-5', 0.01);
  select state into v_state from agent.research_job where job_id = j1;
  if (r ->> 'ok')::boolean or v_state <> 'budget_blocked' then raise exception 'assert: refused reserve ⇒ budget_blocked (got % / %)', r, v_state; end if;
  if exists (select 1 from agent.spend_ledger where job_id = j1) then raise exception 'assert: a refused reserve writes no ledger row'; end if;
  -- lease expiry ⇒ reaped ⇒ retrying with backoff
  c := agent.runtime_claim('pretest', 1);
  tok := (c -> 'claimed' -> 0 ->> 'lease_token')::uuid;
  j2 := c -> 'claimed' -> 0 ->> 'job_id';
  if j2 is null or j2 = j1 then raise exception 'assert: the second claim takes the other job (got %)', c; end if;
  update agent.research_job set lease_until = clock_timestamp() - interval '1 second' where job_id = j2;
  r := agent.runtime_reap(10);
  select state into v_state from agent.research_job where job_id = j2;
  if v_state <> 'retrying' or (r ->> 'retrying')::int <> 1 then raise exception 'assert: expired lease ⇒ retrying (got % / %)', r, v_state; end if;
  if (select next_attempt_at <= clock_timestamp() from agent.research_job where job_id = j2) then raise exception 'assert: a retry waits for its backoff'; end if;
  if agent.runtime_finish(j2, tok, 'completed') ->> 'reason' <> 'lease_lost' then raise exception 'assert: a reaped lease cannot finish'; end if;
  -- cancel of a non-leased job is immediate
  if agent.runtime_cancel(j2, op) ->> 'state' <> 'cancelled' then raise exception 'assert: cancel of a retrying job is immediate'; end if;
  -- schedule slot enqueues at most once
  s := agent.runtime_upsert_schedule('pretest.health', 'ops.health_check', 300, op, '{}'::jsonb, true, clock_timestamp() - interval '1 second');
  r := agent.runtime_enqueue_due_schedules(10);
  if (r ->> 'enqueued')::int <> 1 then raise exception 'assert: a due schedule enqueues one job (got %)', r; end if;
  perform agent.runtime_cancel((select last_job_id from agent.runtime_schedule where name = 'pretest.health'), op);
  update agent.runtime_schedule set next_run_at = last_slot where name = 'pretest.health';
  r := agent.runtime_enqueue_due_schedules(10);
  if (r ->> 'enqueued')::int <> 0 or (r ->> 'deduped')::int <> 1 then raise exception 'assert: the same slot never enqueues twice (got %)', r; end if;
  if (select count(*) from agent.research_job where schedule_id = (s ->> 'schedule_id')::bigint) <> 1 then raise exception 'assert: one job per slot'; end if;
  -- the read model and the health snapshot run against the real tables
  perform agent.runtime_status();
  r := agent.ops_health_snapshot(15, 10);
  if r -> 'queue' ->> 'cap' <> '1000' then raise exception 'assert: health snapshot shape'; end if;
  -- events are append-only even for the owner path
  begin
    update agent.job_event set type = 'job.tampered' where job_id = j1;
    raise exception 'assert: job_event UPDATE must be refused';
  exception when insufficient_privilege then null;
  end;
  raise notice 'pretest(intel_runtime): behaviour OK';
end
$$;

do $$ begin raise notice 'pretest(intel_runtime): ALL OK (rolled back)'; end $$;
rollback;
