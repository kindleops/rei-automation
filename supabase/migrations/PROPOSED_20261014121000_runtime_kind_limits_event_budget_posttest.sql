-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql (formerly
-- the apply half of its pretest). Runs AFTER the runner applied the fix on a disposable database;
-- every write rolls back. The enqueue reading the cap is asserted by the
-- conversation_decide_event_budget posttest (that migration is applied after this fix).
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id runtime_kind_limits_event_budget
-- Expected last notice: "posttest(runtime_kind_limits_event_budget): apply assertions OK".
\set ON_ERROR_STOP on
begin;
do $$
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
  raise notice 'posttest(runtime_kind_limits_event_budget): apply assertions OK';
end $$;
rollback;
