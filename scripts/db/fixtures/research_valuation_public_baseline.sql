-- lc-fixture: setup
-- DISPOSABLE DATABASE ONLY. 8.5.21-b: the production column of public.property_acquisition_scores
-- that agent.ops_research_valuation_snapshot (PROPOSED_20261016162000) reads beyond the
-- operations_public_baseline subset (production type: decision_tier text). Additive and idempotent.
-- Applied by scripts/db/run-migration-test.mjs as setup; never against Supabase.
alter table public.property_acquisition_scores add column if not exists decision_tier text;
