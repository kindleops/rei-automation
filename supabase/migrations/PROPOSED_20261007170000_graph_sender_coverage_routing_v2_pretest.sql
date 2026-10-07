-- PRETEST for Sender Routing 2.0 r3 activation — ONE TRANSACTION, ENDS IN ROLLBACK. Nothing persists.
-- Owner / lead run only (it takes write locks inside its transaction; never from an agent):
--   cd supabase/migrations && psql "$DB" -X -v ON_ERROR_STOP=1 -f PROPOSED_20261007170000_graph_sender_coverage_routing_v2_pretest.sql
--
-- Applies, inside this transaction only:
--   20261002130000_sender_routing_v2.sql                    (tables, RLS, write fn, switches OFF)
--   20261002130100_sender_routing_v2_seed_proposed_graph.sql (r3 seed: 12 pools, 112 routes, 53 markets, Chicago CONFIGURING row)
--   PROPOSED_20261007170000_graph_sender_coverage_routing_v2.sql (v2 pick helper + resolver)
-- then asserts the invariants, previews the resolver per market with the switch OFF and ON
-- (the ON flip is inside the transaction), and ROLLS BACK.
-- Expected (read-only dry run 2026-10-07, activation-dry-run.mjs; coverage-sql-parity.mjs
-- matched the helper body with the JS policy on 58/58 markets):
--   OFF: covered = markets with their own healthy number only (exact-market rule).
--   ON : 53 routed markets covered except where every pool is ineligible; the 5 unmapped
--        markets (Memphis, New Orleans, Louisville, Pittsburgh, Rochester) uncovered;
--        Miami covered REGIONALLY by Tampa (2999 cooling, 5670 blocked); St. Louis covered
--        regionally by Minneapolis until its inbound proof lands; Chicago covered regionally
--        by Indianapolis until +18722547122 is activated.

\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout = '120s';

\ir 20261002130000_sender_routing_v2.sql
\ir 20261002130100_sender_routing_v2_seed_proposed_graph.sql
\ir PROPOSED_20261007170000_graph_sender_coverage_routing_v2.sql

-- ── invariants (each raises on failure) ─────────────────────────────────────
DO $$
DECLARE v int; v_txt text;
BEGIN
  SELECT count(*) INTO v FROM public.sender_pools;           IF v <> 12  THEN RAISE EXCEPTION 'pools: % (expected 12)', v; END IF;
  SELECT count(*) INTO v FROM public.market_sender_routes;   IF v <> 112 THEN RAISE EXCEPTION 'routes: % (expected 112)', v; END IF;
  SELECT count(DISTINCT market_id) INTO v FROM public.market_sender_routes; IF v <> 53 THEN RAISE EXCEPTION 'routed markets: % (expected 53)', v; END IF;
  -- every route market is an active canonical market (FK + is_active)
  SELECT count(*) INTO v FROM public.market_sender_routes m LEFT JOIN public.canonical_markets c ON c.id = m.market_id AND c.is_active WHERE c.id IS NULL;
  IF v > 0 THEN RAISE EXCEPTION '% routes on inactive markets', v; END IF;
  -- unmapped markets stay unmapped
  SELECT string_agg(market_id, ',') INTO v_txt FROM public.market_sender_routes WHERE market_id IN ('memphis-tn','new-orleans-la','louisville-ky','pittsburgh-pa','rochester-ny');
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'unmapped markets got routes: %', v_txt; END IF;
  -- every member resolved (13 live numbers in pools + Chicago) and no number in two pools (UNIQUE)
  SELECT count(*) INTO v FROM public.sender_pool_numbers; IF v <> 19 THEN RAISE EXCEPTION 'pool members: % (expected 19: every local number except retired 4780, plus Chicago)', v; END IF;
  -- Chicago is in the fleet but cannot carry traffic before activation
  SELECT count(*) INTO v FROM public.textgrid_numbers WHERE phone_number = '+18722547122' AND status = 'paused' AND metadata->>'onboarding_stage' = 'configuring' AND daily_limit = 800;
  IF v <> 1 THEN RAISE EXCEPTION 'Chicago CONFIGURING row missing or not paused/800'; END IF;
  -- the switches the seed must not touch
  SELECT count(*) INTO v FROM public.system_control WHERE key = 'sender_routing_v2_enabled' AND lower(trim(value)) = 'false';
  IF v <> 1 THEN RAISE EXCEPTION 'sender_routing_v2_enabled is not false after the seed'; END IF;
  -- send-time health guard prerequisites for a REGIONAL first touch (sms-health-guard.js)
  SELECT count(*) INTO v FROM public.system_control WHERE key = 'allow_regional_fallback_for_first_touch' AND lower(trim(value)) IN ('true','1','yes','on');
  IF v <> 1 THEN RAISE EXCEPTION 'allow_regional_fallback_for_first_touch must be true or the guard refuses every regional first touch'; END IF;
  SELECT count(*) INTO v FROM public.system_control WHERE key = 'require_local_routing' AND lower(trim(value)) IN ('true','1','yes','on');
  IF v > 0 THEN RAISE EXCEPTION 'require_local_routing is on: the guard refuses every regional send'; END IF;
END $$;

-- ── preview: switch OFF (exact-market) ──────────────────────────────────────
\echo '== resolver with sender_routing_v2_enabled = false (exact-market rule) =='
SELECT g.market, g.rows_route_dependent, r.sender_covered, r.route_type, r.sender_market, right(r.sender_phone_number, 4) AS sender
FROM (
  SELECT market, max(state) AS state,
         count(*) FILTER (WHERE queue_block_reason IS NULL OR queue_block_reason = 'no_sender_coverage') AS rows_route_dependent
  FROM public.campaign_target_graph WHERE market IS NOT NULL GROUP BY market HAVING count(*) >= 100
) g CROSS JOIN LATERAL public.resolve_campaign_safe_sender_route(g.market, g.state) r
ORDER BY g.rows_route_dependent DESC;

-- ── preview: switch ON (inside this transaction only) ───────────────────────
UPDATE public.system_control SET value = 'true' WHERE key = 'sender_routing_v2_enabled';
\echo '== resolver with sender_routing_v2_enabled = true (approved graph r3) =='
SELECT g.market, g.rows_route_dependent, r.sender_covered, r.route_type, r.routing_rule_name, r.sender_market, right(r.sender_phone_number, 4) AS sender, r.safe_sender_count
FROM (
  SELECT market, max(state) AS state,
         count(*) FILTER (WHERE queue_block_reason IS NULL OR queue_block_reason = 'no_sender_coverage') AS rows_route_dependent
  FROM public.campaign_target_graph WHERE market IS NOT NULL GROUP BY market HAVING count(*) >= 100
) g CROSS JOIN LATERAL public.resolve_campaign_safe_sender_route(g.market, g.state) r
ORDER BY g.rows_route_dependent DESC;

\echo '== totals ON: covered exact / regional / uncovered (route-dependent rows) =='
SELECT r.route_type, sum(g.n) AS route_dependent_rows, count(*) AS markets
FROM (
  SELECT market, max(state) AS state, count(*) FILTER (WHERE queue_block_reason IS NULL OR queue_block_reason = 'no_sender_coverage') AS n
  FROM public.campaign_target_graph WHERE market IS NOT NULL GROUP BY market
) g CROSS JOIN LATERAL public.resolve_campaign_safe_sender_route(g.market, g.state) r
GROUP BY r.route_type ORDER BY 2 DESC;

ROLLBACK;
\echo 'PRETEST DONE: rolled back, nothing persisted.'
