-- PROPOSED ONLY — ROLLBACK for PROPOSED_20261016162000_ops_research_valuation_snapshot.sql (drops the one read function).
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261016162000_ops_research_valuation_snapshot_rollback.sql
drop function if exists agent.ops_research_valuation_snapshot(timestamptz);
