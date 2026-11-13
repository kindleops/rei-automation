-- PROPOSED ONLY — ROLLBACK for PROPOSED_20261015191000_ai_operator_feedback.sql.
-- Drops exactly what the migration created (feedback + eval-set data is discarded).
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261015191000_ai_operator_feedback_rollback.sql
-- DISPOSABLE DATABASE for testing (node scripts/db/run-migration-test.mjs --id ai_operator_feedback).
drop table if exists public.ai_eval_sets;
drop table if exists public.ai_operator_feedback;
drop function if exists public.ai_feedback_immutable_guard();
