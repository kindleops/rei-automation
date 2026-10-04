-- PROPOSED — NOT APPLIED. Owner approval required.
--
-- Entity Graph table: make the remaining property header sorts index-backed
-- so they can run server-side (today they are demoted to "sorted within
-- loaded rows" by PROPERTY_FAST_SORTS in entity-graph-service.js).
--
-- Measured 10-04 (EXPLAIN on v_entity_graph_properties, 60-row page,
-- ORDER BY <col> <dir> NULLS LAST, property_id): every sort below is a full
-- Sort of the joined view (est. cost 133K) and timed the browse out in the
-- RC 8.3.2 visual pass. A btree serves its own order and its exact reverse
-- (ASC NULLS LAST <-> DESC NULLS FIRST), so "nulls last" in the other
-- direction needs its own index:
--
--   Value   ASC  NULLS LAST  -> existing index is DESC NULLS LAST
--   Equity  DESC NULLS LAST  -> existing index is DESC (= NULLS FIRST)
--   Market  DESC NULLS LAST  -> existing index is ASC  (= NULLS LAST)
--   Address DESC NULLS LAST  -> existing index is ASC  (= NULLS LAST)
--
-- rec_mortgage_balance / rec_last_sale_date come through the view's joins to
-- property_record_summary; no properties index can drive them. They stay
-- "sorted within loaded rows".
--
-- Apply OUTSIDE a transaction (CONCURRENTLY), one statement at a time, off
-- peak. properties ~171K rows; each build is a single sequential pass.
-- After applying, add the new (column, direction) pairs to
-- PROPERTY_FAST_SORTS and re-run the EXPLAIN pretest below.

-- Pretest (read-only): each must show "Sort" (not an Index Scan) before,
-- and an Index Scan + Incremental Sort after.
--   SET statement_timeout='30s'; SET default_transaction_read_only=on;
--   EXPLAIN SELECT property_id FROM public.v_entity_graph_properties ORDER BY estimated_value ASC NULLS LAST, property_id LIMIT 60;
--   EXPLAIN SELECT property_id FROM public.v_entity_graph_properties ORDER BY equity_percent DESC NULLS LAST, property_id LIMIT 60;
--   EXPLAIN SELECT property_id FROM public.v_entity_graph_properties ORDER BY market DESC NULLS LAST, property_id LIMIT 60;
--   EXPLAIN SELECT property_id FROM public.v_entity_graph_properties ORDER BY property_address_full DESC NULLS LAST, property_id LIMIT 60;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_estimated_value_asc_nl
  ON public.properties (estimated_value ASC NULLS LAST);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_equity_percent_desc_nl
  ON public.properties (equity_percent DESC NULLS LAST);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_market_desc_nl
  ON public.properties (market DESC NULLS LAST);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_address_full_desc_nl
  ON public.properties (property_address_full DESC NULLS LAST);
