-- PROPOSED ONLY. NOT APPLIED. OWNER PATH (service_role / owner session).
--
-- 8.5.20 part C schedule definitions — ALL BORN DISABLED (p_enabled = false). Creating a
-- schedule runs nothing: a slot is enqueued only when the schedule is enabled AND
-- agent.runtime_limits.runtime_enabled AND the kind is enabled + armed in kind_limits.
--
--   psql "$DB" -v ON_ERROR_STOP=1 -v owner_id=<owner auth uuid> -f PROPOSED_20261016140100_operations_schedules.sql
--
-- Mirrors OPERATIONS_SCHEDULE_DEFINITIONS in apps/api/src/lib/agent/operations/operations-kinds.js.
--   recovery-sweep        recovery.sweep        every 6 h   $0 (deterministic; approved_programs = [] ⇒ nothing is ever "eligible")
--   inbox-action-center   inbox.action_center   every 15 m  $0
--   pipeline-reconcile    pipeline.reconcile    every 6 h   $0 (stage proposals = PENDING approvals only)
--   ops-supervisor        ops.supervisor        every 30 m  $0
-- Requires PROPOSED_20261016140000_operations_action_center.sql.
\set ON_ERROR_STOP on
begin;
select agent.runtime_upsert_schedule('recovery-sweep', 'recovery.sweep', 21600, :'owner_id', '{"batch_limit": 300, "approved_programs": [], "full_pass_hours": 24}'::jsonb, false, null, 0);
select agent.runtime_upsert_schedule('inbox-action-center', 'inbox.action_center', 900, :'owner_id', '{"batch_limit": 500, "full_pass_hours": 1}'::jsonb, false, null, 0);
select agent.runtime_upsert_schedule('pipeline-reconcile', 'pipeline.reconcile', 21600, :'owner_id', '{"batch_limit": 300, "propose": true, "max_proposals": 5}'::jsonb, false, null, 0);
select agent.runtime_upsert_schedule('ops-supervisor', 'ops.supervisor', 1800, :'owner_id', '{}'::jsonb, false, null, 0);
select name, kind, enabled, interval_seconds, next_run_at from agent.runtime_schedule where name in ('recovery-sweep', 'inbox-action-center', 'pipeline-reconcile', 'ops-supervisor') order by name;
commit;
