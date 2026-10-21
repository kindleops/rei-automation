-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST for PROPOSED_20261014120000_persistent_missions_rollback.sql (rc-8.5.20).
-- After the rollback: max_concurrency 3 is refused again and the 8.5.15 event budget key is still accepted.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- Expected last notice: "rollback posttest(persistent_missions): OK".
\set ON_ERROR_STOP on
begin;
do $$
declare op constant text := '11111111-1111-4111-8111-111111111111';
begin
  if agent.runtime_kind_limits_valid(jsonb_build_object('mission.research', jsonb_build_object('enabled', false, 'max_concurrency', 3, 'armed_by', op))) then raise exception 'assert: max_concurrency 3 refused after rollback'; end if;
  if not agent.runtime_kind_limits_valid(jsonb_build_object('conversation.decide', jsonb_build_object('enabled', false, 'max_concurrency', 2, 'armed_by', op, 'event_budget_cap_usd', 0.01))) then raise exception 'assert: event budget key still accepted after rollback'; end if;
  raise notice 'rollback posttest(persistent_missions): OK';
end
$$;
rollback;
