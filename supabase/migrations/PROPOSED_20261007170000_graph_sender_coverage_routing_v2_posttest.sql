-- lc-fixture: posttest
-- POSTTEST for Sender Routing 2.0 r3 activation: runs AFTER the runner applied 130000, 130100,
-- the fleet snapshot, 171000 and 170000 on a disposable database. Invariants, then the resolver
-- preview with sender_routing_v2_enabled OFF and ON (the ON flip is inside this transaction),
-- then ROLLBACK. Formerly the second half of ..._pretest.sql.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production — not even
-- inside BEGIN … ROLLBACK. Run through the migration test runner on a disposable database.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id graph_sender_coverage_routing_v2 --prod-shape …
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout = '120s';

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
  -- Chicago: present, in the chicago pool, and NOT paused or changed by the seed (owner activated it 2026-10-07)
  SELECT count(*) INTO v FROM public.textgrid_numbers tn JOIN public.sender_pool_numbers spn ON spn.textgrid_number_id = tn.id
    JOIN public.sender_pools sp ON sp.id = spn.sender_pool_id AND sp.pool_key = 'chicago' WHERE tn.phone_number = '+18722547122';
  IF v <> 1 THEN RAISE EXCEPTION 'Chicago missing from the chicago pool'; END IF;
  -- the seed + backfill never touch status / daily_limit / health of any number
  SELECT count(*) INTO v FROM public.textgrid_numbers tn JOIN lc_mt.pretest_fleet_before b ON b.id = tn.id
   WHERE tn.status IS DISTINCT FROM b.status OR tn.daily_limit IS DISTINCT FROM b.daily_limit OR tn.health_state IS DISTINCT FROM b.health_state;
  IF v > 0 THEN RAISE EXCEPTION 'seed/backfill changed status/daily_limit/health on % numbers', v; END IF;
  -- every number with delivered traffic is now registered (else v2 would stop it)
  SELECT count(*) INTO v FROM public.textgrid_numbers tn
   WHERE lower(trim(COALESCE(tn.metadata->>'lifecycle_state', ''))) <> 'retired'
     AND EXISTS (SELECT 1 FROM public.send_queue sq WHERE sq.from_phone_number = tn.phone_number AND sq.delivered_at IS NOT NULL)
     AND lower(trim(COALESCE(tn.registration_status, ''))) <> 'registered';
  IF v > 0 THEN RAISE EXCEPTION '% delivering numbers still unregistered after the backfill', v; END IF;
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

DO $$
DECLARE v_txt text;
BEGIN
  -- every market that can send TODAY (its own active, unblocked, non-cooling number) still resolves with v2 ON
  SELECT string_agg(DISTINCT tn.market, ', ') INTO v_txt
  FROM public.textgrid_numbers tn
  CROSS JOIN LATERAL public.resolve_campaign_safe_sender_route(tn.market, right(tn.market, 2)) r
  WHERE tn.status = 'active' AND lower(COALESCE(tn.health_state, '')) NOT IN ('cooling', 'blocked', 'quarantined', 'spam_flagged', 'suspended')
    AND NOT r.sender_covered;
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'v2 ON would stop markets that send today: %', v_txt; END IF;
  SELECT string_agg(m, ', ') INTO v_txt FROM (VALUES ('Detroit, MI', 'MI'), ('Cleveland, OH', 'OH'), ('Kansas City, MO', 'MO')) x(m, st)
  CROSS JOIN LATERAL public.resolve_campaign_safe_sender_route(x.m, x.st) r WHERE NOT r.sender_covered OR r.route_type <> 'approved_regional_fallback';
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'expected a regional route for: %', v_txt; END IF;
END $$;

\echo '== totals ON: covered exact / regional / uncovered (route-dependent rows) =='
SELECT r.route_type, sum(g.n) AS route_dependent_rows, count(*) AS markets
FROM (
  SELECT market, max(state) AS state, count(*) FILTER (WHERE queue_block_reason IS NULL OR queue_block_reason = 'no_sender_coverage') AS n
  FROM public.campaign_target_graph WHERE market IS NOT NULL GROUP BY market
) g CROSS JOIN LATERAL public.resolve_campaign_safe_sender_route(g.market, g.state) r
GROUP BY r.route_type ORDER BY 2 DESC;

ROLLBACK;
\echo 'POSTTEST DONE: rolled back, nothing persisted.'
