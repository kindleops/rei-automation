-- PROPOSED ONLY — PRETEST for PROPOSED_20261014150000_ops_health_snapshot_delivery_ref.sql. Changes NOTHING.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- rc-8.5.20: read-only prerequisite checks; the apply → assert half moved to
-- PROPOSED_20261014150000_ops_health_snapshot_delivery_ref_posttest.sql (a fixture never
-- includes another file — rc-8.5.15.1 linter).
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id ops_health_snapshot_delivery_ref
-- Expected last notice: "pretest(ops_health_snapshot_delivery_ref): prerequisites OK".
\set ON_ERROR_STOP on
do $$
begin
  if to_regprocedure('agent.ops_health_snapshot(integer,integer)') is null then
    raise exception 'pretest: the R2 runtime (PROPOSED_20261012140000_intel_runtime.sql) must be applied first';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'send_queue' and column_name = 'delivered_at') then
    raise exception 'pretest: public.send_queue.delivered_at missing';
  end if;
  raise notice 'pretest(ops_health_snapshot_delivery_ref): prerequisites OK';
end $$;
