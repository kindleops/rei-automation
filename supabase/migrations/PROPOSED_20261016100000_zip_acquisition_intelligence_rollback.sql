-- PROPOSED ONLY — ROLLBACK for PROPOSED_20261016100000_zip_acquisition_intelligence.sql.
-- Drops exactly what the migration created (cells, watermarks, versions and outcomes are discarded).
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261016100000_zip_acquisition_intelligence_rollback.sql
-- DISPOSABLE DATABASE for testing (node scripts/db/run-migration-test.mjs --id zip_acquisition_intelligence).
drop view if exists public.acquisition_outcomes_training;
drop table if exists public.acquisition_outcomes;
drop function if exists public.acquisition_outcomes_guard();
drop table if exists public.zip_model_versions;
drop table if exists public.zip_model_build_state;
drop table if exists public.zip_acquisition_economics;
