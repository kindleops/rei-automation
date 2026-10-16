-- PROPOSED ONLY. NOT APPLIED. OWNER PATH (service_role / owner session).
--
-- 8.5.20 part A schedule definition — BORN DISABLED (p_enabled = false). Creating a schedule
-- runs nothing: a slot is enqueued only when the schedule is enabled AND
-- agent.runtime_limits.runtime_enabled AND the kind is enabled + armed in kind_limits.
--
--   psql "$DB" -v ON_ERROR_STOP=1 -v owner_id=<owner auth uuid> -f PROPOSED_20261016120100_conversation_reply_turns_schedules.sql
--
-- Mirrors CONVERSATION_TURN_SWEEP_SCHEDULE in apps/api/src/lib/domain/conversation-ai/turns/turn-engine.js.
--   conversation-turn-sweep   conversation.turn_sweep   every 10 m   $0 (deterministic restart recovery:
--                             re-enqueues overdue pending turns / expired claims of public.conversation_reply_turns)
-- Requires PROPOSED_20261016120000_conversation_reply_turns.sql.
\set ON_ERROR_STOP on
begin;
select agent.runtime_upsert_schedule('conversation-turn-sweep', 'conversation.turn_sweep', 600, :'owner_id', '{}'::jsonb, false, null, 0);
select name, kind, enabled, interval_seconds, next_run_at from agent.runtime_schedule where name in ('conversation-turn-sweep') order by name;
commit;
