-- PROPOSED ONLY — ROLLBACK for PROPOSED_20261015120000_ai_message_templates.sql.
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261015120000_ai_message_templates_rollback.sql
-- Drops the append-only records (their provenance is lost: export first if any exist).
-- Proof: LOCAL DISPOSABLE DATABASE ONLY.
drop trigger if exists ai_message_templates_no_update_delete on public.ai_message_templates;
drop trigger if exists ai_message_templates_no_truncate on public.ai_message_templates;
drop table if exists public.ai_message_templates;
drop function if exists public.ai_message_templates_immutable();
