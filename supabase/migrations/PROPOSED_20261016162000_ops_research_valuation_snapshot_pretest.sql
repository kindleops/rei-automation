-- PROPOSED ONLY — PRETEST for PROPOSED_20261016162000_ops_research_valuation_snapshot.sql. Changes NOTHING.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id ops_research_valuation_snapshot
-- Expected last notice: "pretest(ops_research_valuation_snapshot): prerequisites OK".
\set ON_ERROR_STOP on
begin;
do $$
begin
  if to_regprocedure('agent.ops_supervisor_snapshot(timestamptz)') is null then
    raise exception 'pretest(ops_research_valuation_snapshot): apply PROPOSED_20261016140000_operations_action_center.sql first';
  end if;
  if to_regclass('public.acquisition_opportunities') is null or to_regclass('public.property_acquisition_scores') is null
     or to_regclass('public.seller_offers') is null or to_regclass('public.message_events') is null then
    raise exception 'pretest(ops_research_valuation_snapshot): public read relations missing';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'property_acquisition_scores' and column_name = 'decision_tier') then
    raise exception 'pretest(ops_research_valuation_snapshot): public.property_acquisition_scores.decision_tier missing';
  end if;
  if to_regprocedure('agent.ops_research_valuation_snapshot(timestamptz)') is not null then
    raise exception 'pretest(ops_research_valuation_snapshot): already applied';
  end if;
  raise notice 'pretest(ops_research_valuation_snapshot): prerequisites OK';
end $$;
rollback;
