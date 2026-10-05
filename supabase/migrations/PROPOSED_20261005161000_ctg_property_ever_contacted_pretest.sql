-- PRETEST for PROPOSED_20261005161000_ctg_property_ever_contacted.sql. Read-only, no DDL.
-- (A rollback-txn DDL pretest would hold ACCESS EXCLUSIVE on the graph for the whole
-- backfill and block Composer and the crons, so the fill logic is measured as a SELECT.)
-- Run in one session, outside 05:00–08:59 UTC:
SET statement_timeout = '60s';
SET default_transaction_read_only = on;
\timing on

-- P1. Nothing exists yet. Expect 0 / 0 / 0.
SELECT (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'campaign_target_graph'
           AND column_name IN ('property_ever_contacted', 'property_last_outbound_at', 'property_outbound_count')) AS cols,
       (SELECT count(*) FROM pg_proc WHERE proname = 'refresh_campaign_target_graph_property_touch') AS fn,
       (SELECT count(*) FROM cron.job WHERE jobname = 'campaign_graph_property_touch') AS cron_job;

-- P2. The exact fill set the function will write.
--     2026-10-05: touched_properties 10,551 · in_graph 10,521 · gap (phone-level says never) 6,215.
--     Time: the ledger aggregate alone measured 0.29 s.
WITH sent AS (
  SELECT property_id, max(sent_at) AS last_at, count(*) AS n
  FROM public.send_queue WHERE sent_at IS NOT NULL AND property_id IS NOT NULL GROUP BY property_id
  UNION ALL
  SELECT property_id, max(COALESCE(event_timestamp, sent_at, created_at)), count(*)
  FROM public.message_events WHERE lower(COALESCE(direction, '')) LIKE 'out%' AND property_id IS NOT NULL GROUP BY property_id
),
touch AS (SELECT property_id, max(last_at) AS last_at, max(n)::int AS n FROM sent GROUP BY property_id)
SELECT count(*)                                   AS touched_properties,
       count(g.graph_id)                          AS in_graph,
       count(*) FILTER (WHERE g.never_contacted)  AS gap_phone_level_says_never,
       max(t.n)                                   AS max_outbound_per_property
FROM touch t
LEFT JOIN public.campaign_target_graph g ON g.property_id = t.property_id;

-- P3. Plan shape for the per-call candidate join. Expect index scans on
--     campaign_target_graph by property_id (idx_ctg_property_touch_phone once
--     20261005160000 is applied), NOT a Seq Scan of the graph.
EXPLAIN
WITH touch AS (
  SELECT DISTINCT property_id FROM public.send_queue WHERE sent_at IS NOT NULL AND property_id IS NOT NULL
)
SELECT g.graph_id FROM touch c JOIN public.campaign_target_graph g ON g.property_id = c.property_id;

-- P4. Update-cost inputs: index count on the graph (each non-HOT update touches all of them).
SELECT count(*) AS graph_indexes FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'campaign_target_graph';

-- ------------------------------------------------------------------ POSTCHECK (after _backfill)
-- SELECT count(*) FILTER (WHERE property_ever_contacted) AS ever,                         -- ≈ P2.in_graph
--        count(*) FILTER (WHERE property_ever_contacted AND never_contacted) AS gap,      -- ≈ P2.gap
--        count(*) FILTER (WHERE property_outbound_count > 0 AND NOT property_ever_contacted) AS bad   -- 0
-- FROM public.campaign_target_graph;
-- SELECT public.refresh_campaign_target_graph_property_touch(2000);   -- expect {"rows":0,"more":false}
