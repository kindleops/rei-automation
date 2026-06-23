-- Phase 2C — Campaign progress engine.
--
-- Deterministic, lightweight progress aggregation derived from real send_queue
-- rows and message_events. No fake counters. No giant runtime joins: response
-- metrics are scoped to the campaign's OWN queue rows via queue_id, so the
-- inbound scan is bounded by campaign size, not the whole events table.

-- Attribution index: campaign -> its send_queue rows.
CREATE INDEX IF NOT EXISTS idx_send_queue_campaign_id
  ON public.send_queue (campaign_id)
  WHERE campaign_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.campaign_recompute_progress(p_campaign_id uuid)
RETURNS public.campaigns
LANGUAGE plpgsql
AS $$
DECLARE
  v_row public.campaigns;
  v_queued    integer := 0;
  v_sent      integer := 0;
  v_delivered integer := 0;
  v_failed    integer := 0;
  v_replied   integer := 0;
  v_positive  integer := 0;
  v_opt_out   integer := 0;
BEGIN
  -- Outbound funnel from the campaign's own send_queue rows.
  SELECT
    count(*) FILTER (WHERE queue_status IN
      ('queued','scheduled','pending','ready','approved','processing','sending')),
    count(*) FILTER (WHERE sent_at IS NOT NULL OR queue_status IN ('sent','delivered')),
    count(*) FILTER (WHERE delivered_at IS NOT NULL OR queue_status = 'delivered'),
    count(*) FILTER (WHERE queue_status IN ('failed','failed_transport')
                        OR failed_reason IS NOT NULL)
  INTO v_queued, v_sent, v_delivered, v_failed
  FROM public.send_queue
  WHERE campaign_id = p_campaign_id;

  -- Inbound response metrics, bounded to this campaign's queue rows.
  SELECT
    count(*) FILTER (WHERE me.direction = 'inbound'),
    count(*) FILTER (WHERE me.direction = 'inbound' AND me.detected_intent IN
      ('ownership_confirmed','asking_price_provided','asks_offer',
       'seller_interested','needs_call','need_time')),
    count(*) FILTER (WHERE me.direction = 'inbound'
       AND (me.is_opt_out IS TRUE OR me.detected_intent = 'opt_out'))
  INTO v_replied, v_positive, v_opt_out
  FROM public.message_events me
  WHERE me.queue_id IN (
    SELECT id FROM public.send_queue WHERE campaign_id = p_campaign_id
  );

  UPDATE public.campaigns SET
    queued_count       = coalesce(v_queued, 0),
    sent_count         = coalesce(v_sent, 0),
    delivered_count    = coalesce(v_delivered, 0),
    failed_count       = coalesce(v_failed, 0),
    replied_count      = coalesce(v_replied, 0),
    positive_count     = coalesce(v_positive, 0),
    opt_out_count      = coalesce(v_opt_out, 0),
    progress_synced_at = now(),
    updated_at         = now()
  WHERE id = p_campaign_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- Lightweight read model: snapshot counters + derived rates + lifecycle facts.
-- Reads cached counters only (no aggregation at read time), so it is cheap and
-- realtime-safe for the operator UX.
CREATE OR REPLACE VIEW public.campaign_runtime_summary AS
SELECT
  c.id AS campaign_id,
  c.name,
  c.status,
  c.scheduled_for,
  c.activated_at,
  c.paused_at,
  c.completed_at,
  c.failed_at,
  c.failure_reason,
  c.last_transition_at,
  c.activation_attempt_count,
  c.execution_lock_token IS NOT NULL AS hydration_active,
  c.execution_heartbeat_at,
  c.hydration_cursor,
  c.progress_synced_at,
  c.queued_count,
  c.sent_count,
  c.delivered_count,
  c.failed_count,
  c.replied_count,
  c.positive_count,
  c.opt_out_count,
  (c.queued_count + c.sent_count) AS total_planned,
  CASE WHEN c.sent_count > 0
       THEN round((c.delivered_count::numeric / c.sent_count) * 100, 1) ELSE 0 END AS delivery_rate_pct,
  CASE WHEN c.sent_count > 0
       THEN round((c.replied_count::numeric / c.sent_count) * 100, 1) ELSE 0 END AS reply_rate_pct,
  CASE WHEN c.replied_count > 0
       THEN round((c.positive_count::numeric / c.replied_count) * 100, 1) ELSE 0 END AS positive_rate_pct,
  CASE WHEN c.sent_count > 0
       THEN round((c.opt_out_count::numeric / c.sent_count) * 100, 1) ELSE 0 END AS opt_out_rate_pct,
  CASE WHEN (c.queued_count + c.sent_count) > 0
       THEN round((c.sent_count::numeric / (c.queued_count + c.sent_count)) * 100, 1) ELSE 0 END AS hydration_progress_pct
FROM public.campaigns c;
