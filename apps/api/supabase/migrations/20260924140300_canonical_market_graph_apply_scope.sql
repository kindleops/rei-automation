-- ════════════════════════════════════════════════════════════════════════════
-- CANONICAL MARKET GEOGRAPHY — graph data step, scoped to markets.
--
-- Measured before running (2026-09-24): the graph's stored sender coverage
-- (165,215 of 169,797) was computed before ten of the twelve sender numbers
-- entered system_control.sms_blocked_sender_numbers. Resolving routes under
-- CURRENT sender health gives 78,433 covered for the OLD labels and 78,433 for
-- the NEW canonical labels — the market change moves coverage by zero; exact
-- market matches rise 18,838 → 28,133. Recomputing coverage inside this step
-- would book an 86,782-row sender-health swing as a geography change, so the
-- market step leaves coverage to the regular graph refresh that owns it.
-- ════════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.apply_canonical_markets_to_campaign_graph();

CREATE OR REPLACE FUNCTION public.apply_canonical_markets_to_campaign_graph(
  p_refresh_sender_coverage boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_changed integer := 0;
  v_coverage record;
  v_facets integer := 0;
  v_result jsonb;
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

  v_result := jsonb_build_object('graph_rows_remarketed', v_changed);

  IF p_refresh_sender_coverage THEN
    SELECT * INTO v_coverage
    FROM refresh_campaign_target_graph_sender_coverage('canonical_market_backfill_20260924');
    v_result := v_result || jsonb_build_object(
      'graph_rows', v_coverage.graph_rows,
      'exact_market_covered', v_coverage.exact_market_covered,
      'fallback_covered', v_coverage.fallback_covered,
      'sender_covered', v_coverage.sender_covered,
      'uncovered_gap', v_coverage.uncovered_gap
    );
  END IF;

  SELECT refresh_campaign_target_graph_facets() INTO v_facets;

  RETURN v_result || jsonb_build_object('facet_rows', v_facets);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_canonical_markets_to_campaign_graph(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_canonical_markets_to_campaign_graph(boolean) TO service_role;
