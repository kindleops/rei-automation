-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261016100100_property_research_schedules.sql (8.5.20 part B).
-- The seed takes a psql variable (owner_id) and carries its own BEGIN/COMMIT, so the runner
-- cannot apply it as written; this fixture executes the SAME upsert statement with a test
-- operator id inside BEGIN … ROLLBACK and asserts the schedule is born disabled and that nothing
-- is enqueued while disabled. Keep it in step with the seed file.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- Expected last notice: "posttest(property_research_schedules): ALL OK (rolled back)".
\set ON_ERROR_STOP on
begin;
do $$
declare op constant text := '11111111-1111-4111-8111-111111111111'; n int; r jsonb;
begin
  perform agent.runtime_upsert_schedule('property-research-sweep', 'property.research_sweep', 21600, op, '{"limit": 25}'::jsonb, false, null, 0);
  select count(*) into n from agent.runtime_schedule where name = 'property-research-sweep' and kind = 'property.research_sweep' and interval_seconds = 21600
     and budget_cap_usd = 0 and input = '{"limit": 25}'::jsonb;
  if n <> 1 then raise exception 'assert: the property-research-sweep schedule is defined (got %)', n; end if;
  if exists (select 1 from agent.runtime_schedule where name = 'property-research-sweep' and enabled) then
    raise exception 'assert: the schedule is born disabled';
  end if;
  update agent.runtime_schedule set next_run_at = clock_timestamp() - interval '1 minute' where name = 'property-research-sweep';
  r := agent.runtime_enqueue_due_schedules(10);
  if exists (select 1 from agent.research_job where runtime_managed and kind in ('property.research_sweep', 'property.research')) then
    raise exception 'assert: a disabled schedule enqueues nothing (%)', r;
  end if;
  raise notice 'posttest(property_research_schedules): ALL OK (rolled back)';
end
$$;
rollback;
