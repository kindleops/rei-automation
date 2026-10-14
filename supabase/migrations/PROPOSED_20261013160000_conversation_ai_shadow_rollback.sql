-- PROPOSED ONLY — ROLLBACK for PROPOSED_20261013160000_conversation_ai_shadow.sql.
-- Drops exactly the two tables the migration created (shadow data is discarded;
-- nothing else references them).
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261013160000_conversation_ai_shadow_rollback.sql
drop table if exists public.conversation_ai_shadow_decisions;
drop table if exists public.conversation_ai_reply_policy;
