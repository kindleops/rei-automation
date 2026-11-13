-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261013161000_conversation_decide_event_budget.sql: runs
-- AFTER the runner applied the migration; every write rolls back.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id conversation_decide_event_budget
-- Expected last notice: "pretest(conversation_decide_event_budget): apply assertions OK".
\set ON_ERROR_STOP on
begin;
do $$
declare r jsonb; v_cap numeric; v_op text := gen_random_uuid()::text;
begin
  -- not armed ⇒ refused
  update agent.runtime_limits set kind_limits = kind_limits - 'conversation.decide' where id = 1;
  r := agent.runtime_enqueue_event('conversation.decide', 'pretest-sid-1', '{}'::jsonb, 100);
  if (r ->> 'ok')::boolean then raise exception 'assert: unarmed kind must be refused'; end if;
  -- armed, no budget key ⇒ cap 0 (unchanged behaviour)
  update agent.runtime_limits set kind_limits = kind_limits || jsonb_build_object('conversation.decide', jsonb_build_object('armed_by', v_op, 'enabled', false, 'max_concurrency', 1)) where id = 1;
  r := agent.runtime_enqueue_event('conversation.decide', 'pretest-sid-1', '{}'::jsonb, 100);
  if not (r ->> 'ok')::boolean then raise exception 'assert: armed kind enqueues (%)', r; end if;
  select budget_cap_usd into v_cap from agent.research_job where job_id = r ->> 'job_id';
  if v_cap <> 0 then raise exception 'assert: no budget key ⇒ cap 0, got %', v_cap; end if;
  -- same event key ⇒ deduped onto the same job
  if not coalesce((agent.runtime_enqueue_event('conversation.decide', 'pretest-sid-1', '{}'::jsonb, 100) ->> 'deduped')::boolean, false) then
    raise exception 'assert: duplicate inbound dedupes';
  end if;
  -- budget key honoured and clamped to 0.05
  update agent.runtime_limits set kind_limits = jsonb_set(kind_limits, '{conversation.decide,event_budget_cap_usd}', '"9"') where id = 1;
  r := agent.runtime_enqueue_event('conversation.decide', 'pretest-sid-2', '{}'::jsonb, 100);
  select budget_cap_usd into v_cap from agent.research_job where job_id = r ->> 'job_id';
  if v_cap <> 0.05 then raise exception 'assert: cap clamped to 0.05, got %', v_cap; end if;
  update agent.runtime_limits set kind_limits = jsonb_set(kind_limits, '{conversation.decide,event_budget_cap_usd}', '"0.01"') where id = 1;
  r := agent.runtime_enqueue_event('conversation.decide', 'pretest-sid-3', '{}'::jsonb, 100);
  select budget_cap_usd into v_cap from agent.research_job where job_id = r ->> 'job_id';
  if v_cap <> 0.01 then raise exception 'assert: cap 0.01, got %', v_cap; end if;
  raise notice 'pretest(conversation_decide_event_budget): apply assertions OK';
end $$;
rollback;
