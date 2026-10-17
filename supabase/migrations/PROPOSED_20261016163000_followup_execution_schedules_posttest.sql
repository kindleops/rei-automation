-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261016163000_followup_execution_schedules.sql (rc-8.5.21).
-- The seed takes a psql variable (owner_id) and carries its own BEGIN/COMMIT, so the runner
-- cannot apply it as written; this fixture executes the SAME upsert statements with a test
-- operator id inside BEGIN … ROLLBACK and asserts both schedules are born disabled and that
-- nothing is enqueued while disabled. Keep it in step with the seed file.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- Expected last notice: "posttest(followup_execution_schedules): ALL OK (rolled back)".
\set ON_ERROR_STOP on
begin;
do $$
declare op constant text := '11111111-1111-4111-8111-111111111111'; n int; r jsonb;
begin
  perform agent.runtime_upsert_schedule('followup-execution-sweep', 'followup.execution_sweep', 900, op, '{}'::jsonb, false, null, 0);
  perform agent.runtime_upsert_schedule('followup-reconcile', 'followup.reconcile', 3600, op, '{}'::jsonb, false, null, 0);
  select count(*) into n from agent.runtime_schedule
   where (name, kind, interval_seconds) in (('followup-execution-sweep', 'followup.execution_sweep', 900), ('followup-reconcile', 'followup.reconcile', 3600))
     and budget_cap_usd = 0;
  if n <> 2 then raise exception 'assert: both follow-up schedules are defined at $0 (got %)', n; end if;
  if exists (select 1 from agent.runtime_schedule where name in ('followup-execution-sweep', 'followup-reconcile') and enabled) then
    raise exception 'assert: the schedules are born disabled';
  end if;
  update agent.runtime_schedule set next_run_at = clock_timestamp() - interval '1 minute' where name in ('followup-execution-sweep', 'followup-reconcile');
  r := agent.runtime_enqueue_due_schedules(10);
  if exists (select 1 from agent.research_job where runtime_managed and kind in ('followup.execution_sweep', 'followup.reconcile', 'followup.dispatch')) then
    raise exception 'assert: a disabled schedule enqueues nothing (%)', r;
  end if;
  -- an unarmed dispatch kind cannot be event-enqueued either
  r := agent.runtime_enqueue_event_at('followup.dispatch', 'fu1.posttest', '{}'::jsonb, 60, clock_timestamp() + interval '1 hour');
  if coalesce(r->>'reason', '') <> 'kind_not_armed' then raise exception 'assert: an unarmed followup.dispatch is refused (%)', r; end if;
  raise notice 'posttest(followup_execution_schedules): ALL OK (rolled back)';
end
$$;
rollback;
