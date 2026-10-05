-- =============================================================================
-- Property-level touch projection on campaign_target_graph: property_ever_contacted.
-- STATUS: PROPOSED · OWNER-APPROVED 2026-10-05 for apply at/after 12:00 UTC (7 AM CT) · NOT APPLIED.
-- Design: ~/.claude/jobs/c39b0175/tmp/touch-truth/PROPERTY_TOUCH.txt
--         Option B (identity-aware eligibility, NOT in this migration): .../OPTION_B_SPEC.txt
-- Files:  this (transactional DDL)
--         _pretest.sql   read-only checks, run first
--         _index.sql     CREATE INDEX CONCURRENTLY (separate, no transaction)
--         _backfill.sql  batched first fill
--         _schedule.sql  pg_cron job that keeps it fresh
--         _rollback.sql
--
-- APPLY METHOD (exact order; at/after 12:00 UTC):
--   0. Run _pretest.sql (read-only). Expect the numbers it states.
--   1. THIS FILE via MCP apply_migration (one transaction). It begins with
--      SET LOCAL lock_timeout = '5s'. ADD COLUMN with a constant default is
--      metadata-only (PG ≥ 11), so the ACCESS EXCLUSIVE lock lasts milliseconds.
--      If it times out behind a graph writer, simply re-run it.
--   2. _index.sql via MCP execute_sql (CONCURRENTLY, no transaction). ~5–20 s.
--      The column is all-false at this point, so the index starts empty.
--   3. _backfill.sql: call the refresh function repeatedly until more = false.
--      Batches of 2,000 graph rows. ~10.5K rows to fill → 6 calls.
--      Each call: ledger aggregate 0.3 s (measured) + ≤ 2,000 index lookups +
--      ≤ 2,000 non-HOT row updates (the graph has ~30 indexes) → est. 2–6 s per
--      call, ~20–40 s in total. Batched so no single statement holds row locks
--      long or approaches the crons' 20 s / 45 s statement timeouts.
--   4. _schedule.sql via MCP execute_sql: pg_cron job, every 10 min at :05.
--   5. Verify (_pretest POSTCHECK). Then switch the Map display (code: env
--      MAP_TOUCH_PROPERTY_LEVEL=1) and apply PROPOSED_20261005162000_map_tiles_touch_truth.sql.
--
-- Changes NO existing column. never_contacted / last_outbound_at /
-- pending_prior_touch / queue_eligible / queue_block_reason stay phone-level and
-- unchanged, so Composer eligibility is unaffected until Option B is implemented.
-- =============================================================================

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.campaign_target_graph
  ADD COLUMN IF NOT EXISTS property_ever_contacted   boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS property_last_outbound_at timestamptz,
  ADD COLUMN IF NOT EXISTS property_outbound_count   integer     NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.campaign_target_graph.property_ever_contacted IS
  'PROPERTY history: any outbound SMS ever logged against this property_id (send_queue sent_at IS NOT NULL ∪ message_events outbound), to any phone. Phone history stays in never_contacted / last_outbound_at / pending_prior_touch. Maintained by refresh_campaign_target_graph_property_touch().';
COMMENT ON COLUMN public.campaign_target_graph.property_last_outbound_at IS
  'PROPERTY history: latest outbound SMS logged against this property_id, any phone.';
COMMENT ON COLUMN public.campaign_target_graph.property_outbound_count IS
  'PROPERTY history: outbound SMS count for this property_id = max(send_queue sent rows, message_events outbound rows). The two ledgers describe the same sends, so this is max(), not sum().';

-- Converges the property-level columns towards the ledgers, at most p_limit graph
-- rows per call. Candidates are only the touched properties (the ledger, about
-- 10.5K) plus rows currently flagged (via the partial index from _index.sql).
-- It never scans the whole graph. Idempotent: a call with nothing to change
-- writes nothing.
CREATE OR REPLACE FUNCTION public.refresh_campaign_target_graph_property_touch(p_limit integer DEFAULT 2000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 2000), 1), 5000);
  v_rows integer := 0;
BEGIN
  -- Same lock as the graph projection ticks (incremental / reconcile): never interleave with enrich.
  IF NOT pg_try_advisory_xact_lock(hashtext('campaign_target_graph_projection')) THEN
    RETURN jsonb_build_object('skipped', 'locked');
  END IF;

  WITH sent AS (
    SELECT property_id, max(sent_at) AS last_at, count(*) AS n
    FROM public.send_queue
    WHERE sent_at IS NOT NULL AND property_id IS NOT NULL
    GROUP BY property_id
    UNION ALL
    SELECT property_id, max(COALESCE(event_timestamp, sent_at, created_at)) AS last_at, count(*) AS n
    FROM public.message_events
    WHERE lower(COALESCE(direction, '')) LIKE 'out%' AND property_id IS NOT NULL
    GROUP BY property_id
  ),
  touch AS (
    SELECT property_id, max(last_at) AS last_at, max(n)::integer AS n
    FROM sent GROUP BY property_id
  ),
  cand AS (
    SELECT property_id FROM touch
    UNION
    SELECT g.property_id FROM public.campaign_target_graph g WHERE g.property_ever_contacted
  ),
  diff AS (
    SELECT g.graph_id,
           (t.property_id IS NOT NULL) AS ever,
           t.last_at,
           COALESCE(t.n, 0) AS n
    FROM cand c
    JOIN public.campaign_target_graph g ON g.property_id = c.property_id
    LEFT JOIN touch t ON t.property_id = c.property_id
    WHERE g.property_ever_contacted   IS DISTINCT FROM (t.property_id IS NOT NULL)
       OR g.property_last_outbound_at IS DISTINCT FROM t.last_at
       OR g.property_outbound_count   IS DISTINCT FROM COALESCE(t.n, 0)
    LIMIT v_limit
  ),
  upd AS (
    UPDATE public.campaign_target_graph g SET
      property_ever_contacted   = d.ever,
      property_last_outbound_at = d.last_at,
      property_outbound_count   = d.n
    FROM diff d
    WHERE g.graph_id = d.graph_id
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_rows FROM upd;

  RETURN jsonb_build_object(
    'rows', v_rows,
    'more', v_rows >= v_limit,
    'ms', floor(EXTRACT(epoch FROM clock_timestamp() - v_started) * 1000)::integer
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_campaign_target_graph_property_touch(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_campaign_target_graph_property_touch(integer) FROM anon, authenticated;
