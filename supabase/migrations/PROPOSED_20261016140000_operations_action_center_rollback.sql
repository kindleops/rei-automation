-- PROPOSED ONLY — ROLLBACK for PROPOSED_20261016140000_operations_action_center.sql (8.5.20 part C).
-- Drops ONLY what the migration created (schema agent). Nothing in public is touched.
-- The durable action states and work items are DROPPED with their tables: export them first
-- if they must be kept.
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261016140000_operations_action_center_rollback.sql
set local lock_timeout = '5s';
drop function if exists agent.ops_brief_facts(timestamptz, timestamptz);
drop function if exists agent.ops_supervisor_snapshot(timestamptz);
drop function if exists agent.ops_pipeline_facts(uuid, integer);
drop function if exists agent.ops_conversation_facts(timestamptz, uuid, integer);
drop function if exists agent.ops_work_item_decide(uuid, text, text);
drop function if exists agent.ops_work_item_sync(text, uuid, jsonb, boolean);
drop function if exists agent.ops_action_state_upsert(text, uuid, jsonb);
drop function if exists agent.ops_scope_of_kind(text);
drop view if exists agent.v_action_center_queue;
drop table if exists agent.ops_work_item;
drop table if exists agent.conversation_action_state;
