-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST for PROPOSED_20261016162000_ops_research_valuation_snapshot_rollback.sql.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- Expected last notice: "rollback_posttest(ops_research_valuation_snapshot): dropped, part C intact".
\set ON_ERROR_STOP on
begin;
do $$
begin
  if to_regprocedure('agent.ops_research_valuation_snapshot(timestamptz)') is not null then raise exception 'assert: dropped'; end if;
  if to_regprocedure('agent.ops_supervisor_snapshot(timestamptz)') is null then raise exception 'assert: part C read model intact'; end if;
  raise notice 'rollback_posttest(ops_research_valuation_snapshot): dropped, part C intact';
end $$;
rollback;
