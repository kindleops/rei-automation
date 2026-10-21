-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261014120000_persistent_missions.sql (formerly the second
-- half of its pretest). Runs AFTER the runner applied the migration; every write rolls back.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id persistent_missions
-- Expected last notice: "posttest(persistent_missions): ALL OK (rolled back)".
\set ON_ERROR_STOP on
begin;
do $$
declare op constant text := '11111111-1111-4111-8111-111111111111';
begin
  if not agent.runtime_kind_limits_valid(jsonb_build_object('mission.research', jsonb_build_object('enabled', true, 'max_concurrency', 3, 'armed_by', op))) then raise exception 'assert: max_concurrency 3 accepted'; end if;
  if agent.runtime_kind_limits_valid(jsonb_build_object('mission.research', jsonb_build_object('enabled', true, 'max_concurrency', 4, 'armed_by', op))) then raise exception 'assert: max_concurrency 4 refused'; end if;
  if agent.runtime_kind_limits_valid(jsonb_build_object('mission.research', jsonb_build_object('enabled', true, 'max_concurrency', 2))) then raise exception 'assert: enabled needs armed_by'; end if;
  if agent.runtime_kind_limits_valid(jsonb_build_object('research.quick', jsonb_build_object('enabled', false))) then raise exception 'assert: research.* is never a runtime kind'; end if;
  -- rc-8.5.20: the 8.5.15 event budget key survives this re-creation
  if not agent.runtime_kind_limits_valid(jsonb_build_object('conversation.decide', jsonb_build_object('enabled', false, 'max_concurrency', 1, 'armed_by', op, 'event_budget_cap_usd', 0.01))) then raise exception 'assert: event_budget_cap_usd still accepted'; end if;
  if not agent.runtime_kind_limits_valid(jsonb_build_object('conversation.decide', jsonb_build_object('enabled', false, 'armed_by', op, 'event_budget_cap_usd', '0.01'))) then raise exception 'assert: event_budget_cap_usd as numeric string accepted'; end if;
  if agent.runtime_kind_limits_valid(jsonb_build_object('conversation.decide', jsonb_build_object('enabled', false, 'armed_by', op, 'event_budget_cap_usd', -1))) then raise exception 'assert: negative event budget refused'; end if;
  if agent.runtime_kind_limits_valid(jsonb_build_object('conversation.decide', jsonb_build_object('enabled', false, 'armed_by', op, 'other_key', 1))) then raise exception 'assert: unknown key refused'; end if;
  update agent.runtime_limits set kind_limits = jsonb_build_object('mission.research', jsonb_build_object('enabled', false, 'max_concurrency', 3, 'armed_by', op),
                                                                  'conversation.decide', jsonb_build_object('enabled', false, 'max_concurrency', 1, 'armed_by', op, 'event_budget_cap_usd', 0.01)) where id = 1;
  if to_regclass('agent.research_job_requested_recent_idx') is null or to_regclass('agent.finding_type_key_job_idx') is null then raise exception 'assert: indexes exist'; end if;
  if has_function_privilege('anon', 'agent.runtime_kind_limits_valid(jsonb)', 'execute') then raise exception 'assert: anon has no execute'; end if;
  raise notice 'posttest(persistent_missions): behaviour OK';
end
$$;
do $$ begin raise notice 'posttest(persistent_missions): ALL OK (rolled back)'; end $$;
rollback;
