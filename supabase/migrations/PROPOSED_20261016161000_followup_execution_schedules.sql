-- PROPOSED ONLY. NOT APPLIED. OWNER PATH (service_role / owner session).
--
-- rc-8.5.21 FOLLOW-UP EXECUTION PIPELINE schedules — BORN DISABLED (p_enabled = false). Creating a
-- schedule runs nothing: a slot is enqueued only when the schedule is enabled AND
-- agent.runtime_limits.runtime_enabled AND the kind is enabled + armed in kind_limits. Even then
-- every handler does nothing until system_control.followup_execution_mode is set ('dry_run' or
-- 'live'; absent / invalid = off), and the handlers exist only with LC_FOLLOWUP_EXECUTION=1.
--
--   psql "$DB" -v ON_ERROR_STOP=1 -v owner_id=<owner auth uuid> -f PROPOSED_20261016161000_followup_execution_schedules.sql
--
-- Mirrors apps/api/src/lib/domain/followups/followup-execution.js.
--   followup-execution-sweep  followup.execution_sweep  every 15 m  $0  due follow_up_at intents →
--                             one followup.dispatch job each (≤ 36 h ahead), or adopt the live row
--   followup-reconcile        followup.reconcile        every 60 m  $0  dates with no job, jobs with no
--                             outcome, duplicates; bounded transport-only retries
-- followup.dispatch is event-driven (enqueued by the sweep / the reconcile), never scheduled.
-- Requires PROPOSED_20261016120000_conversation_reply_turns.sql (agent.runtime_enqueue_event_at).
\set ON_ERROR_STOP on
begin;
select agent.runtime_upsert_schedule('followup-execution-sweep', 'followup.execution_sweep', 900, :'owner_id', '{}'::jsonb, false, null, 0);
select agent.runtime_upsert_schedule('followup-reconcile', 'followup.reconcile', 3600, :'owner_id', '{}'::jsonb, false, null, 0);
select name, kind, enabled, interval_seconds, next_run_at from agent.runtime_schedule where name in ('followup-execution-sweep', 'followup-reconcile') order by name;
commit;
