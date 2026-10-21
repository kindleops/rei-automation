-- PROPOSED ONLY — PRETEST for PROPOSED_20261020120000_research_event_budget_ceilings.sql. Changes NOTHING.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id research_event_budget_ceilings
-- Expected last notice: "pretest(research_event_budget_ceilings): prerequisites OK, zero event budget reproduced".
\set ON_ERROR_STOP on
begin;
do $$
declare r jsonb; v_cap numeric; v_op text := gen_random_uuid()::text;
begin
  if to_regprocedure('agent.runtime_enqueue_event(text,text,jsonb,integer)') is null or to_regprocedure('agent.runtime_kind_limits_valid(jsonb)') is null then
    raise exception 'pretest(research_event_budget_ceilings): apply intel_runtime and runtime_kind_limits_event_budget first';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'agent' and table_name = 'runtime_limits' and column_name = 'event_budget_ceilings') then
    raise exception 'pretest(research_event_budget_ceilings): agent.runtime_limits.event_budget_ceilings already exists';
  end if;
  if to_regprocedure('agent.runtime_event_budget_ceiling(text)') is not null then
    raise exception 'pretest(research_event_budget_ceilings): agent.runtime_event_budget_ceiling already exists';
  end if;
  -- the kind-limits fix must be in (else the per-job key cannot be written at all)
  begin
    update agent.runtime_limits set kind_limits = kind_limits || jsonb_build_object('property.research', jsonb_build_object('armed_by', v_op, 'enabled', false, 'max_concurrency', 1, 'event_budget_cap_usd', 0.30)) where id = 1;
  exception when check_violation then
    raise exception 'pretest(research_event_budget_ceilings): PROPOSED_20261014121000_runtime_kind_limits_event_budget must be applied first';
  end;
  -- the limitation, reproduced: production's enqueue gives an armed event job a $0 budget (intel_runtime body)
  -- or the literal 0.05 clamp (PROPOSED_20261013161000 body, NOT part of Package A)
  r := agent.runtime_enqueue_event('property.research', 'pretest-prop-1', '{}'::jsonb, 120);
  select budget_cap_usd into v_cap from agent.research_job where job_id = r ->> 'job_id';
  if v_cap is null or v_cap not in (0, 0.05) then raise exception 'pretest(research_event_budget_ceilings): expected the production budget 0 (or the 0.05 clamp), got %', v_cap; end if;
  raise notice 'pretest(research_event_budget_ceilings): prerequisites OK, zero event budget reproduced (got %)', v_cap;
end $$;
rollback;
