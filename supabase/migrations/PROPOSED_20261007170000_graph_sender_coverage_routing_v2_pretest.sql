-- PRETEST for Sender Routing 2.0 r3 activation (PROPOSED_20261007170000_graph_sender_coverage_routing_v2). Changes NOTHING.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production — not even
-- inside BEGIN … ROLLBACK. Run through the migration test runner on a disposable database.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id graph_sender_coverage_routing_v2 --prod-shape …
-- rc-8.5.15.1: this file used to be ONE transaction that \ir-included four apply files and was
-- meant to be run with psql against production. Now:
--   this file                         read-only prerequisite checks
--   the runner applies, in order      20261002130000_sender_routing_v2.sql,
--                                     20261002130100_sender_routing_v2_seed_proposed_graph.sql,
--                                     ..._fleet_snapshot.sql (fixture: fleet BEFORE the backfill → lc_mt),
--                                     PROPOSED_20261007171000_sender_routing_v2_evidence_backfill.sql,
--                                     PROPOSED_20261007170000_graph_sender_coverage_routing_v2.sql
--   ..._posttest.sql                  the invariants and the resolver preview, switch OFF then ON,
--                                     in ONE transaction ending in ROLLBACK
--   rollback files                    170000, 171000, then supabase/rollbacks/20261002130000_..._ROLLBACK.sql
-- The expectations below were measured read-only on production 2026-10-07; on a disposable
-- database they hold only for a production-shaped fleet snapshot.
-- Expected (read-only preview 2026-10-07 evening, coverage-sql-parity.mjs --live-evidence; SQL helper
-- and JS policy agree on 58/58 markets): v2 ON covers 53 markets — the 12 with their own number exact
-- (Chicago excepted: +18722547122 has no inbound yet, so Chicago routes via Indianapolis until the
-- backfill is re-run after its first inbound), the rest regional; Detroit / Cleveland via Indianapolis,
-- Kansas City via St. Louis; the 5 unmapped markets uncovered (as today).
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF to_regclass('public.sender_pools') IS NOT NULL OR to_regclass('public.market_sender_routes') IS NOT NULL THEN
    RAISE EXCEPTION 'pretest(sender_routing_v2): sender_pools / market_sender_routes already exist — 20261002130000 is applied; reconcile first';
  END IF;
  IF to_regclass('public.textgrid_numbers') IS NULL OR to_regclass('public.canonical_markets') IS NULL OR to_regclass('public.system_control') IS NULL
     OR to_regclass('public.campaign_target_graph') IS NULL OR to_regclass('public.send_queue') IS NULL OR to_regclass('public.message_events') IS NULL THEN
    RAISE EXCEPTION 'pretest(sender_routing_v2): textgrid_numbers / canonical_markets / system_control / campaign_target_graph / send_queue / message_events missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'resolve_campaign_safe_sender_route' AND pronamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'pretest(sender_routing_v2): public.resolve_campaign_safe_sender_route (the function the migration replaces) missing';
  END IF;
  RAISE NOTICE 'pretest(sender_routing_v2): prerequisites OK';
END $$;
