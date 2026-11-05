-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261016140100_operations_schedules.sql (8.5.20 part C).
-- The seed takes a psql variable (owner_id) and carries its own BEGIN/COMMIT, so the runner
-- cannot apply it as written; this fixture executes the SAME four upsert statements with a
-- test operator id inside BEGIN … ROLLBACK and asserts every schedule is born disabled and
-- that nothing is enqueued while disabled. Keep it in step with the seed file.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- Expected last notice: "posttest(operations_schedules): ALL OK (rolled back)".
\set ON_ERROR_STOP on
begin;
do $$
declare op constant text := '11111111-1111-4111-8111-111111111111'; n int; r jsonb;
begin
  perform agent.runtime_upsert_schedule('recovery-sweep', 'recovery.sweep', 21600, op, '{"batch_limit": 300, "approved_programs": [], "full_pass_hours": 24}'::jsonb, false, null, 0);
  perform agent.runtime_upsert_schedule('inbox-action-center', 'inbox.action_center', 900, op, '{"batch_limit": 500, "full_pass_hours": 1}'::jsonb, false, null, 0);
  perform agent.runtime_upsert_schedule('pipeline-reconcile', 'pipeline.reconcile', 21600, op, '{"batch_limit": 300, "propose": true, "max_proposals": 5}'::jsonb, false, null, 0);
  perform agent.runtime_upsert_schedule('ops-supervisor', 'ops.supervisor', 1800, op, '{}'::jsonb, false, null, 0);
  select count(*) into n from agent.runtime_schedule where name in ('recovery-sweep', 'inbox-action-center', 'pipeline-reconcile', 'ops-supervisor');
  if n <> 4 then raise exception 'assert: four schedules defined (got %)', n; end if;
  if exists (select 1 from agent.runtime_schedule where name in ('recovery-sweep', 'inbox-action-center', 'pipeline-reconcile', 'ops-supervisor') and enabled) then
    raise exception 'assert: every schedule is born disabled';
  end if;
  update agent.runtime_schedule set next_run_at = clock_timestamp() - interval '1 minute' where name in ('recovery-sweep', 'inbox-action-center', 'pipeline-reconcile', 'ops-supervisor');
  r := agent.runtime_enqueue_due_schedules(10);
  if exists (select 1 from agent.research_job where runtime_managed and kind in ('recovery.sweep', 'inbox.action_center', 'pipeline.reconcile', 'ops.supervisor')) then
    raise exception 'assert: a disabled schedule enqueues nothing (%)', r;
  end if;
  raise notice 'posttest(operations_schedules): ALL OK (rolled back)';
end
$$;
rollback;
