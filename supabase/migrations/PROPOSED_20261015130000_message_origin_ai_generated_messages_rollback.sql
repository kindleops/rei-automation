-- PROPOSED ONLY — ROLLBACK for PROPOSED_20261015130000_message_origin_ai_generated_messages.sql.
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261015130000_message_origin_ai_generated_messages_rollback.sql
-- Drops the origin guard, the origin column and the AI message records + events (their
-- provenance is lost: export first if any exist). Existing send_queue rows are untouched
-- apart from losing message_origin.
-- Test: DISPOSABLE DATABASE ONLY (scripts/db/run-migration-test.mjs).
drop trigger if exists guard_send_queue_message_origin on public.send_queue;
drop function if exists public.guard_send_queue_message_origin();
alter table public.send_queue drop constraint if exists send_queue_message_origin_check;
alter table public.send_queue drop column if exists message_origin;
drop table if exists public.ai_generated_message_events;
drop table if exists public.ai_generated_messages;
drop function if exists public.ai_generated_messages_immutable();
