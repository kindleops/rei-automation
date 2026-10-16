-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST for PROPOSED_20261014121000_runtime_kind_limits_event_budget_rollback.sql.
-- Runs AFTER the runner applied the rollback on a disposable database; every write rolls back.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- Expected last notice: "rollback posttest(runtime_kind_limits_event_budget): OK".
\set ON_ERROR_STOP on
begin;
do $$
begin
  if exists (select 1 from agent.runtime_limits, jsonb_each(kind_limits) e(k, v) where id = 1 and v ? 'event_budget_cap_usd') then
    raise exception 'assert: rollback leaves no event_budget_cap_usd key';
  end if;
  begin
    update agent.runtime_limits set kind_limits = kind_limits || jsonb_build_object('conversation.decide',
      jsonb_build_object('enabled', false, 'max_concurrency', 1, 'armed_by', 'a2ee0ffe-6f27-475b-a795-ee617c9472c6', 'event_budget_cap_usd', 0.01)) where id = 1;
    raise exception 'assert: after rollback the key is refused again';
  exception when check_violation then null;
  end;
  -- the rest of a kind entry is still accepted
  update agent.runtime_limits set kind_limits = kind_limits || jsonb_build_object('conversation.decide',
    jsonb_build_object('enabled', false, 'max_concurrency', 1, 'armed_by', 'a2ee0ffe-6f27-475b-a795-ee617c9472c6')) where id = 1;
  raise notice 'rollback posttest(runtime_kind_limits_event_budget): OK';
end $$;
rollback;
