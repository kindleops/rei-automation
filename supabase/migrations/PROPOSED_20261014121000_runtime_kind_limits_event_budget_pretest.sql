-- PROPOSED ONLY — PRETEST for PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql. Changes NOTHING.
--   psql "$DB" -v ON_ERROR_STOP=1 -f supabase/migrations/PROPOSED_20261014121000_runtime_kind_limits_event_budget_pretest.sql
-- BEGIN → (intel_runtime, only if not yet applied) → this fix → conversation_decide_event_budget
-- → asserts → this fix's rollback → asserts → ROLLBACK.
-- Expected last notice: "pretest(runtime_kind_limits_event_budget): ALL OK (rolled back)".
\set ON_ERROR_STOP on
begin;
select to_regprocedure('agent.runtime_enqueue_event(text,text,jsonb,integer)') is null as need_runtime \gset
\if :need_runtime
\ir PROPOSED_20261012140000_intel_runtime.sql
\endif
-- the defect, reproduced before the fix: the budget key is refused by the CHECK
do $$
begin
  begin
    update agent.runtime_limits set kind_limits = kind_limits || jsonb_build_object('conversation.decide',
      jsonb_build_object('enabled', false, 'max_concurrency', 1, 'armed_by', 'a2ee0ffe-6f27-475b-a795-ee617c9472c6', 'event_budget_cap_usd', 0.01)) where id = 1;
    raise exception 'assert: before the fix the event_budget_cap_usd key must be refused (defect not reproduced)';
  exception when check_violation then null;
  end;
  raise notice 'pretest(runtime_kind_limits_event_budget): defect reproduced (key refused before the fix)';
end $$;
\ir PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql
\ir PROPOSED_20261013161000_conversation_decide_event_budget.sql
do $$
declare r jsonb; v_cap numeric;
begin
  -- accepted as JSON number and as numeric string
  update agent.runtime_limits set kind_limits = kind_limits || jsonb_build_object('conversation.decide',
    jsonb_build_object('enabled', false, 'max_concurrency', 1, 'armed_by', 'a2ee0ffe-6f27-475b-a795-ee617c9472c6', 'event_budget_cap_usd', 0.01)) where id = 1;
  update agent.runtime_limits set kind_limits = jsonb_set(kind_limits, '{conversation.decide,event_budget_cap_usd}', '"0.01"') where id = 1;
  -- refused: negative, non-numeric, boolean, unknown key
  begin update agent.runtime_limits set kind_limits = jsonb_set(kind_limits, '{conversation.decide,event_budget_cap_usd}', '-1') where id = 1;
        raise exception 'assert: negative refused'; exception when check_violation then null; end;
  begin update agent.runtime_limits set kind_limits = jsonb_set(kind_limits, '{conversation.decide,event_budget_cap_usd}', '"abc"') where id = 1;
        raise exception 'assert: non-numeric refused'; exception when check_violation then null; end;
  begin update agent.runtime_limits set kind_limits = jsonb_set(kind_limits, '{conversation.decide,event_budget_cap_usd}', 'true') where id = 1;
        raise exception 'assert: boolean refused'; exception when check_violation then null; end;
  begin update agent.runtime_limits set kind_limits = jsonb_set(kind_limits, '{conversation.decide,other_key}', '1') where id = 1;
        raise exception 'assert: unknown key still refused'; exception when check_violation then null; end;
  -- the enqueue reads it
  r := agent.runtime_enqueue_event('conversation.decide', 'pretest-fix-sid-1', '{}'::jsonb, 120);
  select budget_cap_usd into v_cap from agent.research_job where job_id = r ->> 'job_id';
  if v_cap <> 0.01 then raise exception 'assert: event job cap 0.01 (got % / %)', v_cap, r; end if;
  raise notice 'pretest(runtime_kind_limits_event_budget): apply assertions OK';
end $$;
\ir PROPOSED_20261013161000_conversation_decide_event_budget_rollback.sql
\ir PROPOSED_20261014121000_runtime_kind_limits_event_budget_rollback.sql
do $$
begin
  if exists (select 1 from agent.runtime_limits, jsonb_each(kind_limits) e(k, v) where id = 1 and v ? 'event_budget_cap_usd') then
    raise exception 'assert: rollback strips event_budget_cap_usd';
  end if;
  if (select (kind_limits -> 'conversation.decide' ->> 'armed_by') from agent.runtime_limits where id = 1) is distinct from 'a2ee0ffe-6f27-475b-a795-ee617c9472c6' then
    raise exception 'assert: rollback keeps the rest of the kind entry';
  end if;
  begin
    update agent.runtime_limits set kind_limits = jsonb_set(kind_limits, '{conversation.decide,event_budget_cap_usd}', '0.01') where id = 1;
    raise exception 'assert: after rollback the key is refused again';
  exception when check_violation then null;
  end;
  raise notice 'pretest(runtime_kind_limits_event_budget): ALL OK (rolled back)';
end $$;
rollback;
