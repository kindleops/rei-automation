-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261014120100_persistent_missions_schedules.sql (rc-8.5.20).
-- The seed takes a psql variable (owner_id) and carries its own BEGIN/COMMIT, so the runner
-- cannot apply it as written; this fixture executes the SAME three upsert statements with a
-- test operator id inside BEGIN … ROLLBACK and asserts every schedule is born disabled and
-- that nothing is enqueued while disabled. Keep it in step with the seed file.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- Expected last notice: "posttest(persistent_missions_schedules): ALL OK (rolled back)".
\set ON_ERROR_STOP on
begin;
do $$
declare op constant text := '11111111-1111-4111-8111-111111111111'; n int; r jsonb;
begin
  perform agent.runtime_upsert_schedule('acquisition-discovery', 'acquisition.discovery', 21600, op,
    '{"scan_limit": 400, "rank_top_n": 12, "draft": true}'::jsonb, false, null, 0.25);
  perform agent.runtime_upsert_schedule('ops-health-check', 'ops.health_check', 900, op, '{}'::jsonb, false, null, 0);
  perform agent.runtime_upsert_schedule('conversation-review-digest', 'conversation.review_digest', 86400, op,
    '{"window_hours": 24}'::jsonb, false, (date_trunc('day', clock_timestamp() at time zone 'utc') + interval '1 day 12 hours') at time zone 'utc', 0);
  select count(*) into n from agent.runtime_schedule where name in ('acquisition-discovery', 'ops-health-check', 'conversation-review-digest');
  if n <> 3 then raise exception 'assert: three schedules defined (got %)', n; end if;
  if exists (select 1 from agent.runtime_schedule where name in ('acquisition-discovery', 'ops-health-check', 'conversation-review-digest') and enabled) then
    raise exception 'assert: every schedule is born disabled';
  end if;
  update agent.runtime_schedule set next_run_at = clock_timestamp() - interval '1 minute' where name in ('acquisition-discovery', 'ops-health-check', 'conversation-review-digest');
  r := agent.runtime_enqueue_due_schedules(10);
  if exists (select 1 from agent.research_job where runtime_managed and kind in ('acquisition.discovery', 'ops.health_check', 'conversation.review_digest')) then
    raise exception 'assert: a disabled schedule enqueues nothing (%)', r;
  end if;
  raise notice 'posttest(persistent_missions_schedules): ALL OK (rolled back)';
end
$$;
rollback;
