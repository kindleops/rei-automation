-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261016160000_runtime_event_budget_ceilings.sql: runs AFTER the
-- runner applied the migration; every write rolls back.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id runtime_event_budget_ceilings
-- Expected last notice: "posttest(runtime_event_budget_ceilings): apply assertions OK".
\set ON_ERROR_STOP on
begin;
do $$
declare r jsonb; v_cap numeric; v_op text := gen_random_uuid()::text; v_def text;
begin
  -- born OFF: the default row carries no ceiling ⇒ every kind keeps the 0.05 clamp
  if (select event_budget_ceilings from agent.runtime_limits where id = 1) <> '{}'::jsonb then raise exception 'assert: default ceilings must be {}'; end if;
  update agent.runtime_limits set kind_limits = kind_limits
      || jsonb_build_object('property.research', jsonb_build_object('armed_by', v_op, 'enabled', false, 'max_concurrency', 1, 'event_budget_cap_usd', 0.30))
      || jsonb_build_object('conversation.decide', jsonb_build_object('armed_by', v_op, 'enabled', false, 'max_concurrency', 1, 'event_budget_cap_usd', 0.30)) where id = 1;
  r := agent.runtime_enqueue_event('property.research', 'posttest-prop-1', '{}'::jsonb, 120);
  select budget_cap_usd into v_cap from agent.research_job where job_id = r ->> 'job_id';
  if v_cap <> 0.05 then raise exception 'assert: no ceiling ⇒ 0.05, got %', v_cap; end if;

  -- the owner sets the property.research ceiling to 0.30
  update agent.runtime_limits set event_budget_ceilings = '{"property.research": 0.30}'::jsonb where id = 1;
  r := agent.runtime_enqueue_event('property.research', 'posttest-prop-2', '{}'::jsonb, 120);
  select budget_cap_usd into v_cap from agent.research_job where job_id = r ->> 'job_id';
  if v_cap <> 0.30 then raise exception 'assert: ceiling 0.30 ⇒ cap 0.30, got %', v_cap; end if;
  -- the per-job amount still governs below the ceiling
  update agent.runtime_limits set kind_limits = jsonb_set(kind_limits, '{property.research,event_budget_cap_usd}', '0.12') where id = 1;
  r := agent.runtime_enqueue_event('property.research', 'posttest-prop-3', '{}'::jsonb, 120);
  select budget_cap_usd into v_cap from agent.research_job where job_id = r ->> 'job_id';
  if v_cap <> 0.12 then raise exception 'assert: amount below ceiling kept, got %', v_cap; end if;
  -- a kind without a ceiling is unchanged
  r := agent.runtime_enqueue_event('conversation.decide', 'posttest-conv-1', '{}'::jsonb, 100);
  select budget_cap_usd into v_cap from agent.research_job where job_id = r ->> 'job_id';
  if v_cap <> 0.05 then raise exception 'assert: other kinds keep 0.05, got %', v_cap; end if;
  -- the delayed enqueue reads the same ceiling
  update agent.runtime_limits set kind_limits = jsonb_set(kind_limits, '{property.research,event_budget_cap_usd}', '9') where id = 1;
  r := agent.runtime_enqueue_event_at('property.research', 'posttest-prop-4', '{}'::jsonb, 120, clock_timestamp() + interval '5 minutes');
  if not (r ->> 'ok')::boolean then raise exception 'assert: enqueue_event_at ok (%)', r; end if;
  select budget_cap_usd into v_cap from agent.research_job where job_id = r ->> 'job_id';
  if v_cap <> 0.30 then raise exception 'assert: enqueue_event_at clamps at the ceiling 0.30, got %', v_cap; end if;
  -- the hard max: a ceiling above 0.30, a negative, a string or an invalid kind is refused
  begin update agent.runtime_limits set event_budget_ceilings = '{"property.research": 0.31}'::jsonb where id = 1;
        raise exception 'assert: 0.31 refused'; exception when check_violation then null; end;
  begin update agent.runtime_limits set event_budget_ceilings = '{"property.research": -0.01}'::jsonb where id = 1;
        raise exception 'assert: negative refused'; exception when check_violation then null; end;
  begin update agent.runtime_limits set event_budget_ceilings = '{"property.research": "0.2"}'::jsonb where id = 1;
        raise exception 'assert: string refused'; exception when check_violation then null; end;
  begin update agent.runtime_limits set event_budget_ceilings = '{"research.quick": 0.1}'::jsonb where id = 1;
        raise exception 'assert: reserved research.* kind refused'; exception when check_violation then null; end;
  -- body drift guard: both enqueue functions read the ceiling function, never a literal 0.05
  select pg_get_functiondef('agent.runtime_enqueue_event(text,text,jsonb,integer)'::regprocedure) into v_def;
  if position('runtime_event_budget_ceiling(p_kind)' in v_def) = 0 or position('0.05)' in v_def) > 0 then raise exception 'assert: runtime_enqueue_event clamps at the ceiling function'; end if;
  select pg_get_functiondef('agent.runtime_enqueue_event_at(text,text,jsonb,integer,timestamptz)'::regprocedure) into v_def;
  if position('runtime_event_budget_ceiling(p_kind)' in v_def) = 0 or position('0.05)' in v_def) > 0 then raise exception 'assert: runtime_enqueue_event_at clamps at the ceiling function'; end if;
  -- agent_api may call the clamp, nobody else
  if has_function_privilege('anon', 'agent.runtime_event_budget_ceiling(text)', 'execute') then raise exception 'assert: anon cannot execute the ceiling'; end if;
  raise notice 'posttest(runtime_event_budget_ceilings): apply assertions OK';
end $$;
rollback;
