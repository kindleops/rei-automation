-- PROPOSED ONLY — ROLLBACK for PROPOSED_20261016120000_conversation_turns.sql.
-- Drops exactly what the migration created (turn rows are discarded; inbound_reply
-- reservations a turn wrote into public.idempotency_ledger stay — they are ordinary
-- reservation rows the template engine / R3 executor read, and expire by retention).
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261016120000_conversation_turns_rollback.sql
-- DISPOSABLE DATABASE for testing (node scripts/db/run-migration-test.mjs --id conversation_turns).
drop function if exists agent.runtime_enqueue_event_at(text, text, jsonb, integer, timestamptz);
drop function if exists public.conversation_turn_due(integer, integer);
drop function if exists public.conversation_turn_reopen(uuid, text, timestamptz, jsonb);
drop function if exists public.conversation_turn_cancel(text, text);
drop function if exists public.conversation_turn_finalize(uuid, uuid, integer, text, jsonb, boolean, text);
drop function if exists public.conversation_turn_claim(uuid, integer, text, integer);
drop function if exists public.conversation_turn_open(text, text, timestamptz, timestamptz, jsonb, text, text);
drop table if exists public.conversation_turns;
