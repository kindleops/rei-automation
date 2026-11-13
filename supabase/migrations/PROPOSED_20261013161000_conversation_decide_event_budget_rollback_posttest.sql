-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST for PROPOSED_20261013161000_conversation_decide_event_budget_rollback.sql:
-- runs AFTER the runner applied the rollback file; every write rolls back.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id conversation_decide_event_budget
-- Expected last notice: "pretest(conversation_decide_event_budget): ALL OK (rolled back)".
\set ON_ERROR_STOP on
begin;
-- The old single-transaction pretest reached this point with the kind still armed and
-- event_budget_cap_usd = "0.01" from the apply assertions; re-create exactly that state so the
-- check proves the ROLLED-BACK function ignores the budget key (cap 0).
update agent.runtime_limits set kind_limits = kind_limits || jsonb_build_object('conversation.decide', jsonb_build_object('armed_by', gen_random_uuid()::text, 'enabled', false, 'max_concurrency', 1, 'event_budget_cap_usd', '0.01')) where id = 1;
do $$
declare r jsonb; v_cap numeric;
begin
  r := agent.runtime_enqueue_event('conversation.decide', 'pretest-sid-4', '{}'::jsonb, 100);
  select budget_cap_usd into v_cap from agent.research_job where job_id = r ->> 'job_id';
  if v_cap <> 0 then raise exception 'assert: rollback restores cap 0'; end if;
  raise notice 'pretest(conversation_decide_event_budget): ALL OK (rolled back)';
end $$;

rollback;
