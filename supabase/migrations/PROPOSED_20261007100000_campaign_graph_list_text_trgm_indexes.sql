-- PROPOSED — campaign_target_graph list-text trigram indexes (owner approval required)
--
-- Why: Composer whole-cohort count with a flag filter and no market
-- ("properties.property_flags_text is_any_of [Vacant Home]") fails 502
-- cohort_count_unavailable. The graph filter is a token regex
--   property_flags_text ~* '(^|;)[[:space:]]*(vacant home)[[:space:]]*(;|$)'
-- with no supporting index: EXPLAIN ANALYZE 2026-10-07 = Bitmap Heap Scan over
-- 90,186 queue-eligible rows, 47,611 heap blocks, 85,733 removed, 14.6 s for
-- 3,664 matches — over the PostgREST role timeout (authenticator 8 s).
-- pg_trgm (1.6, installed) GIN indexes serve ~* regex with literal tokens, so
-- the planner reads only trigram-candidate rows. Same pattern for the other two
-- list-text columns the filter planner treats as token lists
-- (GRAPH_LIST_TEXT_COLUMNS: podio_tags, property_flags_text, matching_flags_text).
--
-- Safety: CREATE INDEX CONCURRENTLY (no write lock), new indexes only, no data
-- change. Table 169,797 rows / 527 MB heap; text columns average ~100 chars.
-- Run outside a transaction, one statement at a time; off-peak; verify
-- indisvalid afterwards and drop + recreate any invalid index.
-- Rollback: PROPOSED_20261007100000_campaign_graph_list_text_trgm_indexes_rollback.sql

SET statement_timeout = '15min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_property_flags_text_trgm
  ON public.campaign_target_graph USING gin (property_flags_text gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_podio_tags_trgm
  ON public.campaign_target_graph USING gin (podio_tags gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_matching_flags_text_trgm
  ON public.campaign_target_graph USING gin (matching_flags_text gin_trgm_ops);

-- Verify:
-- select indexrelid::regclass, indisvalid from pg_index
--  where indexrelid::regclass::text like 'idx_ctg_%_trgm';
-- explain analyze select count(*) from public.campaign_target_graph
--  where queue_eligible and property_flags_text ~* '(^|;)[[:space:]]*(vacant home)[[:space:]]*(;|$)';
