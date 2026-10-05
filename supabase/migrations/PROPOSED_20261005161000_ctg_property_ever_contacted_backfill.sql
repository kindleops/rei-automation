-- STEP 3 of PROPOSED_20261005161000_ctg_property_ever_contacted.sql: batched first fill.
-- Run AFTER _index.sql, using MCP execute_sql (each call is its own transaction).
-- Call repeatedly until "more" is false. Expect about 6 calls with rows ≈ 2000, 2000,
-- 2000, 2000, 2000, ~500, then {"rows":0,"more":false}. Est. 2–6 s per call.
-- {"skipped":"locked"} means a projection tick is running: wait about 1 min and call again.
-- Do not run 05:00–08:59 UTC, when the reconcile cron holds the projection lock.
SET statement_timeout = '60s';
SELECT public.refresh_campaign_target_graph_property_touch(2000);

-- Check when done. Expected on 2026-10-05 data (it grows with sends):
--   ever ≈ 10,521 · ever_and_phone_never ≈ 6,215 (the gap, now visible) · phone_touched_not_ever = 0
-- SELECT count(*) FILTER (WHERE property_ever_contacted)                          AS ever,
--        count(*) FILTER (WHERE property_ever_contacted AND never_contacted)       AS ever_and_phone_never,
--        count(*) FILTER (WHERE NOT property_ever_contacted AND NOT never_contacted) AS phone_touched_not_ever
-- FROM public.campaign_target_graph;
-- phone_touched_not_ever > 0 is legal: a send logged without a property_id, matched to
-- this row only by phone. Record the number; it is not an error.
