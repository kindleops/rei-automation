-- ════════════════════════════════════════════════════════════════════════════
-- CANONICAL MARKET GEOGRAPHY — part 3 of 3: campaign graph + sender identity.
-- Requires 20260924140000 and 20260924140100 (properties are canonical).
--
-- This migration only DEFINES. The data step — bringing the live campaign
-- graph into line and recomputing sender coverage and facets — runs through
-- public.apply_canonical_markets_to_campaign_graph(), invoked over the
-- database API like the graph refresh itself: sender coverage resolves a route
-- for every one of ~170k graph rows and takes minutes, longer than a migration
-- connection holds (the first attempt was rolled back whole when it dropped).
-- ════════════════════════════════════════════════════════════════════════════

-- The stage builder fell back to master_owners.routing_market (504 raw values)
-- and prospects.primary_market when a property had no market, re-injecting
-- municipalities on every refresh. The property's canonical market only.
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.refresh_campaign_target_graph_stage_batch(uuid,integer,integer,text,text)'::regprocedure);
  v_old text := 'COALESCE(NULLIF(p.market, ''''), NULLIF(mo.routing_market, ''''), NULLIF(pr.primary_market, '''')) AS market';
  v_new text := 'NULLIF(p.market, '''') AS market';
BEGIN
  IF position(v_old IN v_def) > 0 THEN
    EXECUTE replace(v_def, v_old, v_new);
  ELSIF position(v_new IN v_def) = 0 THEN
    RAISE EXCEPTION 'refresh_campaign_target_graph_stage_batch market expression not found; refusing to guess';
  END IF;
END $$;

-- Sender routing identity: an incoming label is resolved to its canonical
-- market before the exact-market match, so "Diamond Bar, CA" matches the Los
-- Angeles sender exactly instead of only by state. Health, blocklists, state
-- fallback order and sender selection are untouched.
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.resolve_campaign_safe_sender_route(text,text)'::regprocedure);
  v_old text := 'public.normalize_campaign_sender_market(p_market) AS market_key,';
  v_new text := 'public.normalize_campaign_sender_market(COALESCE((SELECT r.market_name FROM public.resolve_canonical_market(NULL, NULL, NULL, p_state, p_market) r), p_market)) AS market_key,';
BEGIN
  IF position(v_old IN v_def) > 0 THEN
    EXECUTE replace(v_def, v_old, v_new);
  ELSIF position(v_new IN v_def) = 0 THEN
    RAISE EXCEPTION 'resolve_campaign_safe_sender_route market_key expression not found; refusing to guess';
  END IF;
END $$;

-- The data step. Idempotent: rows already canonical are not touched, and the
-- coverage/facet refreshes are the same ones the graph commit runs.
CREATE OR REPLACE FUNCTION public.apply_canonical_markets_to_campaign_graph()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_changed integer := 0;
  v_coverage record;
  v_facets integer := 0;
BEGIN
  PERFORM set_config('statement_timeout', '0', true);

  INSERT INTO canonical_market_backfill_log (table_name, row_id, old_market, new_market_id, new_market, source)
  SELECT 'campaign_target_graph', g.graph_id::text, g.market, p.canonical_market_id, p.market, 'properties.canonical_market_id'
  FROM campaign_target_graph g
  JOIN properties p ON p.property_id = g.property_id
  WHERE g.market IS DISTINCT FROM p.market;

  UPDATE campaign_target_graph g
  SET market = p.market
  FROM properties p
  WHERE p.property_id = g.property_id
    AND g.market IS DISTINCT FROM p.market;
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  SELECT * INTO v_coverage
  FROM refresh_campaign_target_graph_sender_coverage('canonical_market_backfill_20260924');

  SELECT refresh_campaign_target_graph_facets() INTO v_facets;

  RETURN jsonb_build_object(
    'graph_rows_remarketed', v_changed,
    'graph_rows', v_coverage.graph_rows,
    'exact_market_covered', v_coverage.exact_market_covered,
    'fallback_covered', v_coverage.fallback_covered,
    'sender_covered', v_coverage.sender_covered,
    'uncovered_gap', v_coverage.uncovered_gap,
    'facet_rows', v_facets
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_canonical_markets_to_campaign_graph() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_canonical_markets_to_campaign_graph() TO service_role;
