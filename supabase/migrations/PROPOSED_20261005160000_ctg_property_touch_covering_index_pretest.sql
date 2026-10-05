-- PRETEST for PROPOSED_20261005160000_ctg_property_touch_covering_index.sql
-- Read-only. Run in one session before the apply:
SET statement_timeout = '60s';
SET default_transaction_read_only = on;

-- P1. The name is free; nothing half-built is left over from an earlier attempt.
--     Expect 0 rows.
SELECT c.relname, i.indisvalid
FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE c.relname = 'idx_ctg_property_touch_phone';

-- P2. Columns and types are as expected.
--     Expect 3 rows: property_id text, canonical_e164 text, never_contacted boolean.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'campaign_target_graph'
  AND column_name IN ('property_id', 'canonical_e164', 'never_contacted')
ORDER BY column_name;

-- P3. Disk headroom and table size. Expect: heap ≈ 527 MB, total ≈ 849 MB.
SELECT pg_size_pretty(pg_relation_size('public.campaign_target_graph')) AS heap,
       pg_size_pretty(pg_total_relation_size('public.campaign_target_graph')) AS total,
       (SELECT count(*) FROM public.campaign_target_graph) AS rows;   -- ≈ 169,797

-- P4. BASELINE plan (record the time; compare with POSTCHECK Q2).
--     2026-10-05 measurement: Seq Scan on campaign_target_graph, ~2.4 s, read ≈ 67K buffers.
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) FROM public.properties p
WHERE EXISTS (SELECT 1 FROM public.campaign_target_graph tg
              WHERE tg.property_id = p.property_id AND tg.never_contacted IS FALSE);

-- ------------------------------------------------------------------ POSTCHECK
-- Run after the CREATE INDEX CONCURRENTLY statement.
-- Q1. Expect 1 row with indisvalid = t and indisready = t, size ≈ 8–14 MB.
--   SELECT c.relname, i.indisvalid, i.indisready, pg_size_pretty(pg_relation_size(c.oid))
--   FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = 'idx_ctg_property_touch_phone';
-- Q2. Expect "Index Only Scan using idx_ctg_property_touch_phone on campaign_target_graph tg"
--     and no Seq Scan on campaign_target_graph; buffers ≈ 1–2K instead of 67K.
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT count(*) FROM public.properties p
--   WHERE EXISTS (SELECT 1 FROM public.campaign_target_graph tg
--                 WHERE tg.property_id = p.property_id AND tg.never_contacted IS FALSE);
-- Q3. If the plan still shows heap fetches ≈ row count, the visibility map is stale:
--   VACUUM (ANALYZE) public.campaign_target_graph;   -- outside 05:00–08:59 UTC (reconcile)
