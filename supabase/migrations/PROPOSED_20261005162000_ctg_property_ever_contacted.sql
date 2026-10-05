-- PROPOSED — NOT APPLIED. Needs owner approval (it feeds eligibility-adjacent
-- reads). Design note: jobs/c39b0175/tmp/touch-truth/PROPERTY_TOUCH.txt
--
-- Property-level touch truth on the campaign target graph.
--
-- Today never_contacted / last_outbound_at / pending_prior_touch are computed per
-- the graph row's CURRENT best phone (canonical_e164): calc.last_outbound =
-- GREATEST(message_events outbound, send_queue sent) joined ON e164. A property
-- whose seller was texted on another number (or whose phone has since been
-- dropped) reads never_contacted = true. Measured 2026-10-05: 5,893 properties
-- with a send_queue row (sent_at not null, property_id set) read never_contacted
-- (2,360 graph phone now NULL, 3,533 graph phone differs from every number sent).
--
-- This ADDS property-level columns. It changes NO existing column, so Composer
-- eligibility (never_contacted, pending_prior_touch, queue_eligible,
-- queue_block_reason) is untouched until the owner decides otherwise.

ALTER TABLE public.campaign_target_graph
  ADD COLUMN IF NOT EXISTS property_ever_contacted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS property_last_outbound_at timestamptz,
  ADD COLUMN IF NOT EXISTS property_outbound_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.campaign_target_graph.property_ever_contacted IS
  'Any outbound SMS ever logged against this property_id (send_queue sent_at IS NOT NULL ∪ message_events direction outbound), regardless of which phone. Phone-level state stays in never_contacted / pending_prior_touch.';

-- Refresh, called at the end of the daily enrich (after campaign_target_graph_enrich_rows).
-- send_queue: idx_send_queue_property_id; message_events: message_events_property_id_idx.
-- ~10.5K touched properties → small aggregate; the UPDATE touches only rows whose value changes.
CREATE OR REPLACE FUNCTION public.refresh_campaign_target_graph_property_touch()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH sent AS (
    SELECT property_id, max(sent_at) AS last_at, count(*) AS n
    FROM public.send_queue
    WHERE sent_at IS NOT NULL AND property_id IS NOT NULL
    GROUP BY property_id
    UNION ALL
    SELECT property_id,
           max(COALESCE(event_timestamp, sent_at, created_at)) AS last_at,
           count(*) AS n
    FROM public.message_events
    WHERE lower(COALESCE(direction, '')) LIKE 'out%' AND property_id IS NOT NULL
    GROUP BY property_id
  ),
  touch AS (
    -- send_queue and message_events describe the same sends; max() not sum() for the count.
    SELECT property_id, max(last_at) AS last_at, max(n)::int AS n FROM sent GROUP BY property_id
  ),
  upd AS (
    UPDATE public.campaign_target_graph t SET
      property_ever_contacted   = (x.property_id IS NOT NULL),
      property_last_outbound_at = x.last_at,
      property_outbound_count   = COALESCE(x.n, 0)
    FROM (
      SELECT g.graph_id, touch.property_id, touch.last_at, touch.n
      FROM public.campaign_target_graph g
      LEFT JOIN touch ON touch.property_id = g.property_id
    ) x
    WHERE t.graph_id = x.graph_id
      AND (t.property_ever_contacted IS DISTINCT FROM (x.property_id IS NOT NULL)
        OR t.property_last_outbound_at IS DISTINCT FROM x.last_at
        OR t.property_outbound_count IS DISTINCT FROM COALESCE(x.n, 0))
    RETURNING 1
  )
  SELECT count(*)::int FROM upd;
$$;

REVOKE ALL ON FUNCTION public.refresh_campaign_target_graph_property_touch() FROM PUBLIC, anon, authenticated;

-- Covering partial index for the Map "Contacted" bucket (tiny: ~10.5K rows).
-- (CONCURRENTLY must be run as its own statement outside a transaction.)
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_property_ever_contacted
--   ON public.campaign_target_graph (property_id) WHERE property_ever_contacted;

-- PRETEST (read-only, before apply): expected count of property_ever_contacted = true
--   WITH s AS (SELECT DISTINCT property_id FROM send_queue WHERE sent_at IS NOT NULL AND property_id IS NOT NULL
--              UNION SELECT DISTINCT property_id FROM message_events WHERE lower(direction) LIKE 'out%' AND property_id IS NOT NULL)
--   SELECT count(*) FROM s JOIN campaign_target_graph g USING (property_id);   -- 10,521 on 2026-10-05
-- POSTTEST: SELECT refresh_campaign_target_graph_property_touch();  then
--   SELECT count(*) FILTER (WHERE property_ever_contacted), count(*) FILTER (WHERE property_ever_contacted AND never_contacted)
--   FROM campaign_target_graph;   -- expect 10,521 and ~5,893 (the gap now visible, not hidden)
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.refresh_campaign_target_graph_property_touch();
--   ALTER TABLE public.campaign_target_graph
--     DROP COLUMN IF EXISTS property_ever_contacted,
--     DROP COLUMN IF EXISTS property_last_outbound_at,
--     DROP COLUMN IF EXISTS property_outbound_count;
