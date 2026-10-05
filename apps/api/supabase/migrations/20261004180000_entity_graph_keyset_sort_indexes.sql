-- APPLIED to prod 2026-10-05 00:16–00:22 UTC (owner approved all 22; built one at a time, CONCURRENTLY; all indisvalid; ~140 MB total).
-- Supersedes PROPOSED_20261004120000_entity_graph_property_sort_indexes.sql.
--
-- WHY: the Entity Graph table sorts the WHOLE property cohort (page 2
-- continues page 1 exactly) only for columns with a btree on
-- (column, property_id). The server detects these indexes at runtime
-- (entity-graph-property-sort.js, SORT_INDEX_SQL: valid, non-partial btree,
-- first two keys = column ASC, property_id ASC) and uses keyset paging; any
-- column without one stays "Sorted within loaded rows". So this file can be
-- applied whole, trimmed, or one index at a time — the app picks each up
-- within 10 minutes (detection cache), no deploy needed.
--
-- One (col, property_id) index serves BOTH directions (forward scan = ASC,
-- backward = DESC), with nulls served separately by `col IS NULL ORDER BY
-- property_id` on the same index. That replaces the four NULLS-LAST single
-- column indexes of PROPOSED_20261004120000 (value / equity / market /
-- address) — they are folded in below as #8, #9, #17, #18.
-- property_id must be in the index: measured 10-04, equity_percent DESC on
-- the existing single-column index = incremental sort over a 94K-row tie
-- group, 5.5 s.
--
-- rec_* columns (#19–#22) live on property_record_summary (173K rows,
-- 36 MB). `rec_x IS NOT NULL` reduces the view's LEFT JOIN to an inner join,
-- so the planner drives from the summary index (measured with the existing
-- summary mortgage_count index: Index Scan on property_record_summary ->
-- nested loop into properties).
--
-- SIZE: estimated from pg_stats widths x 171K rows, calibrated 2.07x to the
-- real size of the existing idx_properties_property_id (11 MB).
-- BUILD TIME: CONCURRENTLY = two passes over the heap. properties heap is
-- 961 MB (46 indexes, 498 MB today): est. 10–30 s per index off-peak;
-- property_record_summary: ~1–2 s each. Total est. 5–10 min for all 22.
-- WRITE COST: each index adds one btree insert per properties write
-- (imports). Offsets available: properties has 4 identical btree(property_id)
-- indexes (idx_properties_property_id, idx_dashboard_properties_property_id,
-- idx_cmd_map_properties_property_id, uq_properties_property_id; ~43 MB) and
-- 2 identical btree(final_acquisition_score DESC) (~37 MB) — not dropped
-- here; a separate owner decision.
--
--  #  index                                   column                     est. size  operator value
--  1  idx_properties_eg_year_built             year_built                 ~11 MB     high
--  2  idx_properties_eg_eff_year_built         effective_year_built       ~11 MB     medium
--  3  idx_properties_eg_bedrooms               total_bedrooms             ~11 MB     high
--  4  idx_properties_eg_baths                  total_baths                ~14 MB     high
--  5  idx_properties_eg_building_sqft          building_square_feet       ~14 MB     high
--  6  idx_properties_eg_lot_sqft               lot_square_feet            ~14 MB     medium
--  7  idx_properties_eg_units                  units_count                ~11 MB     high
--  8  idx_properties_eg_estimated_value        estimated_value            ~14 MB     high (was #1 of 120000)
--  9  idx_properties_eg_equity_percent         equity_percent             ~14 MB     high (was #2)
-- 10  idx_properties_eg_equity_amount          equity_amount              ~14 MB     medium
-- 11  idx_properties_eg_repair_cost            estimated_repair_cost      ~14 MB     high
-- 12  idx_properties_eg_sale_date              sale_date (ISO text)       ~14 MB     high
-- 13  idx_properties_eg_sale_price             sale_price                 ~14 MB     medium
-- 14  idx_properties_eg_zoning                 zoning                     ~11 MB     medium
-- 15  idx_properties_eg_loan_balance           total_loan_balance         ~11 MB     medium
-- 16  idx_properties_eg_ownership_years        ownership_years            ~14 MB     high
-- 17  idx_properties_eg_market                 market                     ~17 MB     high (was #3)
-- 18  idx_properties_eg_address                property_address_full      ~27 MB     high (was #4)
-- 19  idx_prs_eg_mortgage_balance              summary.mortgage_balance   ~14 MB     high (Balance)
-- 20  idx_prs_eg_last_sale_date                summary.last_sale_date     ~11 MB     high (Last sale)
-- 21  idx_prs_eg_mortgage_count                summary.mortgage_count     ~11 MB     medium (Loans)
-- 22  idx_prs_eg_lien_count                    summary.lien_count         ~11 MB     medium (Liens)
-- TOTAL: 22 indexes, est. ~300 MB (properties 18 = ~255 MB, summary 4 = ~47 MB).
-- Suggested trim if the owner wants half: keep the "high" rows (14 indexes, ~205 MB).
--
-- APPLY: outside any transaction (CONCURRENTLY cannot run in one), one
-- statement at a time, e.g. psql without -1, or MCP execute_sql per
-- statement. If a build fails it leaves an INVALID index: the app ignores
-- invalid indexes (indisvalid); drop it and retry.
--
-- PRETEST (read-only) per column, before and after:
--   SET statement_timeout='30s'; SET default_transaction_read_only=on;
--   EXPLAIN SELECT property_id FROM public.v_entity_graph_properties
--    WHERE year_built IS NOT NULL ORDER BY year_built ASC NULLS LAST, property_id ASC LIMIT 61;
--   before: Sort (full); after: Index Scan using idx_properties_eg_year_built, no Sort node.
--   Descending: ORDER BY year_built DESC NULLS FIRST, property_id DESC -> Index Scan Backward.
--   Nulls tail: WHERE year_built IS NULL AND property_id > '0' ORDER BY property_id LIMIT 61.
-- POST-CHECK: the detection query the app runs:
--   (see SORT_INDEX_SQL in apps/api/src/lib/domain/entity-graph/entity-graph-property-sort.js)
--
-- ROLLBACK (each independent; the app falls back to "sorted within loaded
-- rows" for that column within 10 minutes):
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_properties_eg_year_built;
--   ... same for every name below.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_eg_year_built ON public.properties (year_built, property_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_eg_eff_year_built ON public.properties (effective_year_built, property_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_eg_bedrooms ON public.properties (total_bedrooms, property_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_eg_baths ON public.properties (total_baths, property_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_eg_building_sqft ON public.properties (building_square_feet, property_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_eg_lot_sqft ON public.properties (lot_square_feet, property_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_eg_units ON public.properties (units_count, property_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_eg_estimated_value ON public.properties (estimated_value, property_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_eg_equity_percent ON public.properties (equity_percent, property_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_eg_equity_amount ON public.properties (equity_amount, property_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_eg_repair_cost ON public.properties (estimated_repair_cost, property_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_eg_sale_date ON public.properties (sale_date, property_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_eg_sale_price ON public.properties (sale_price, property_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_eg_zoning ON public.properties (zoning, property_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_eg_loan_balance ON public.properties (total_loan_balance, property_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_eg_ownership_years ON public.properties (ownership_years, property_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_eg_market ON public.properties (market, property_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_eg_address ON public.properties (property_address_full, property_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prs_eg_mortgage_balance ON public.property_record_summary (mortgage_balance, property_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prs_eg_last_sale_date ON public.property_record_summary (last_sale_date, property_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prs_eg_mortgage_count ON public.property_record_summary (mortgage_count, property_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prs_eg_lien_count ON public.property_record_summary (lien_count, property_id);
