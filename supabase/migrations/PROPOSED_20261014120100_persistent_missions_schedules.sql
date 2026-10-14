-- PROPOSED ONLY. NOT APPLIED. OWNER PATH (service_role / owner session).
--
-- 8.5.18 schedule definitions — ALL BORN DISABLED (p_enabled = false). Creating a
-- schedule runs nothing: a slot is enqueued only when the schedule is enabled AND
-- agent.runtime_limits.runtime_enabled AND the kind is enabled + armed in kind_limits.
--
--   psql "$DB" -v ON_ERROR_STOP=1 -v owner_id=<owner auth uuid> -f PROPOSED_20261014120100_persistent_missions_schedules.sql
--
-- owner_id: the named operator every scheduled job is accountable to (requested_by;
-- its spend reserves are attributed to it). Mirrors SCHEDULE_DEFINITIONS in
-- apps/api/src/lib/agent/missions/mission-kinds.js.
--   acquisition-discovery       acquisition.discovery        every 6 h   job cap $0.25 (one Haiku ranking call)
--   ops-health-check            ops.health_check             every 15 m  $0 (definition only; the 8.5.15 handler is unchanged)
--   conversation-review-digest  conversation.review_digest   every 24 h  $0 (deterministic); first slot 12:00 UTC (07:00 CT)
\set ON_ERROR_STOP on
begin;
select agent.runtime_upsert_schedule('acquisition-discovery', 'acquisition.discovery', 21600, :'owner_id',
  '{"scan_limit": 400, "rank_top_n": 12, "draft": true}'::jsonb, false, null, 0.25);
select agent.runtime_upsert_schedule('ops-health-check', 'ops.health_check', 900, :'owner_id', '{}'::jsonb, false, null, 0);
select agent.runtime_upsert_schedule('conversation-review-digest', 'conversation.review_digest', 86400, :'owner_id',
  '{"window_hours": 24}'::jsonb, false, (date_trunc('day', clock_timestamp() at time zone 'utc') + interval '1 day 12 hours') at time zone 'utc', 0);
select name, kind, enabled, interval_seconds, next_run_at from agent.runtime_schedule where name in ('acquisition-discovery', 'ops-health-check', 'conversation-review-digest') order by name;
commit;
