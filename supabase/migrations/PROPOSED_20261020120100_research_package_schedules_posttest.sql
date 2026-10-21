-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261020120100_research_package_schedules.sql (the owner seed):
-- runs the seed's statements inside BEGIN … ROLLBACK and asserts every schedule is born DISABLED and that a
-- disabled schedule enqueues nothing even with the runtime enabled. Every write rolls back.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- Expected last notice: "posttest(research_package_schedules): 7 schedules born disabled, nothing enqueued".
\set ON_ERROR_STOP on
begin;
do $$
declare v_owner text := gen_random_uuid()::text; r jsonb; n int;
begin
  perform agent.runtime_upsert_schedule('property-research-sweep', 'property.research_sweep', 21600, v_owner, '{"limit": 10}'::jsonb, false, null, 0);
  perform agent.runtime_upsert_schedule('valuation-refresh', 'valuation.refresh', 86400, v_owner, '{"limit": 25}'::jsonb, false, null, 0);
  perform agent.runtime_upsert_schedule('recovery-sweep', 'recovery.sweep', 21600, v_owner, '{"batch_limit": 300, "approved_programs": [], "full_pass_hours": 24}'::jsonb, false, null, 0);
  perform agent.runtime_upsert_schedule('inbox-action-center', 'inbox.action_center', 900, v_owner, '{"batch_limit": 500, "full_pass_hours": 1}'::jsonb, false, null, 0);
  perform agent.runtime_upsert_schedule('ops-supervisor', 'ops.supervisor', 1800, v_owner, '{}'::jsonb, false, null, 0);
  perform agent.runtime_upsert_schedule('conversation-review-digest', 'conversation.review_digest', 86400, v_owner, '{"window_hours": 24}'::jsonb, false, (date_trunc('day', clock_timestamp() at time zone 'utc') + interval '1 day 12 hours') at time zone 'utc', 0);
  perform agent.runtime_upsert_schedule('ops-health-check', 'ops.health_check', 900, v_owner, '{}'::jsonb, false, null, 0);
  select count(*) into n from agent.runtime_schedule where name in ('property-research-sweep', 'valuation-refresh', 'recovery-sweep', 'inbox-action-center', 'ops-supervisor', 'conversation-review-digest', 'ops-health-check');
  if n <> 7 then raise exception 'assert: 7 schedules, got %', n; end if;
  if exists (select 1 from agent.runtime_schedule where name in ('property-research-sweep', 'valuation-refresh', 'recovery-sweep', 'inbox-action-center', 'ops-supervisor', 'conversation-review-digest', 'ops-health-check') and enabled) then
    raise exception 'assert: every Package A schedule is born disabled';
  end if;
  if exists (select 1 from agent.runtime_schedule where name in ('acquisition-discovery', 'pipeline-reconcile', 'conversation-turn-sweep') or kind like 'followup.%' or kind like 'conversation.decide%' or kind = 'conversation.turn') then
    raise exception 'assert: the seed creates no out-of-package schedule';
  end if;
  -- even with the runtime switched on, a disabled schedule enqueues nothing
  update agent.runtime_limits set runtime_enabled = true, emergency_stop = false, emergency_stop_at = null, emergency_stop_by = null, emergency_stop_reason = null where id = 1;
  update agent.runtime_schedule set next_run_at = clock_timestamp() - interval '1 minute';
  r := agent.runtime_enqueue_due_schedules(50);
  if exists (select 1 from agent.research_job where schedule_id is not null) then raise exception 'assert: a disabled schedule enqueued a job (%)', r; end if;
  raise notice 'posttest(research_package_schedules): 7 schedules born disabled, nothing enqueued';
end $$;
rollback;
