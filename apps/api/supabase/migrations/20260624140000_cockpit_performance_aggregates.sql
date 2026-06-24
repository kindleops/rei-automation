-- Cockpit performance: aggregate RPCs and supporting indexes.
-- Evidence-driven indexes on predicates used by ops metrics, queue control, and inbox lookups.

CREATE INDEX IF NOT EXISTS idx_send_queue_queue_status
  ON public.send_queue (queue_status);

CREATE INDEX IF NOT EXISTS idx_send_queue_created_at
  ON public.send_queue (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_send_queue_updated_at
  ON public.send_queue (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_send_queue_sent_at
  ON public.send_queue (sent_at DESC)
  WHERE sent_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_send_queue_delivered_at
  ON public.send_queue (delivered_at DESC)
  WHERE delivered_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_send_queue_thread_key
  ON public.send_queue (thread_key)
  WHERE thread_key IS NOT NULL AND thread_key <> '';

CREATE INDEX IF NOT EXISTS idx_send_queue_to_phone_number
  ON public.send_queue (to_phone_number)
  WHERE to_phone_number IS NOT NULL AND to_phone_number <> '';

CREATE INDEX IF NOT EXISTS idx_send_queue_property_id
  ON public.send_queue (property_id)
  WHERE property_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_events_created_at
  ON public.message_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_message_events_thread_key
  ON public.message_events (thread_key)
  WHERE thread_key IS NOT NULL AND thread_key <> '';

CREATE INDEX IF NOT EXISTS idx_message_events_event_timestamp
  ON public.message_events (event_timestamp DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_message_events_direction_created_at
  ON public.message_events (direction, created_at DESC);

CREATE OR REPLACE FUNCTION public.cockpit_queue_processor_health()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH today_start AS (
    SELECT date_trunc('day', now()) AS ts
  ),
  lag_cutoff AS (
    SELECT now() - interval '15 minutes' AS ts
  ),
  counts AS (
    SELECT
      (SELECT count(*)::bigint FROM public.send_queue WHERE queue_status = 'queued') AS queued,
      (SELECT count(*)::bigint FROM public.send_queue WHERE queue_status = 'pending') AS pending,
      (SELECT count(*)::bigint FROM public.send_queue WHERE queue_status = 'approval') AS approval,
      (SELECT count(*)::bigint FROM public.send_queue WHERE queue_status = 'scheduled') AS scheduled,
      (SELECT count(*)::bigint FROM public.send_queue WHERE queue_status = 'processing') AS processing,
      (SELECT count(*)::bigint FROM public.send_queue
        WHERE queue_status IN ('queued', 'pending', 'processing')
          AND created_at < (SELECT ts FROM lag_cutoff)) AS lag_active,
      (SELECT count(*)::bigint FROM public.send_queue
        WHERE sent_at >= (SELECT ts FROM today_start)) AS sent_today,
      (SELECT count(*)::bigint FROM public.send_queue
        WHERE queue_status = 'delivered' AND delivered_at >= (SELECT ts FROM today_start)) AS delivered_today,
      (SELECT count(*)::bigint FROM public.send_queue
        WHERE queue_status = 'failed' AND updated_at >= (SELECT ts FROM today_start)) AS failed_today,
      (SELECT count(*)::bigint FROM public.send_queue
        WHERE queue_status IN ('queued', 'pending', 'approval', 'scheduled', 'processing')
          AND updated_at < (SELECT ts FROM lag_cutoff)) AS stale_active,
      (SELECT count(*)::bigint FROM public.send_queue
        WHERE queue_status IN ('queued', 'pending', 'approval', 'scheduled', 'processing')
          AND to_phone_number IS NULL) AS orphaned_active,
      (SELECT count(*)::bigint FROM public.send_queue
        WHERE queue_status IN ('queued', 'pending', 'approval', 'scheduled', 'processing')
          AND retry_count > 1) AS retried_gt_one,
      (SELECT count(*)::bigint FROM public.send_queue
        WHERE queue_status = 'processing'
          AND (is_locked IS FALSE OR lock_token IS NULL)) AS processing_lock_conflicts
  ),
  oldest_queued AS (
    SELECT created_at
    FROM public.send_queue
    WHERE queue_status = 'queued'
    ORDER BY created_at ASC
    LIMIT 1
  ),
  latest_sent AS (
    SELECT coalesce(sent_at, updated_at, created_at) AS at
    FROM public.send_queue
    WHERE queue_status IN ('sent', 'delivered')
    ORDER BY sent_at DESC NULLS LAST, updated_at DESC, created_at DESC
    LIMIT 1
  ),
  latest_webhook AS (
    SELECT created_at
    FROM public.webhook_log
    ORDER BY created_at DESC
    LIMIT 1
  ),
  issue_sample AS (
    SELECT jsonb_agg(row_to_json(s)::jsonb) AS rows
    FROM (
      SELECT
        id,
        queue_status,
        created_at,
        updated_at,
        scheduled_for_utc,
        sent_at,
        delivered_at,
        guard_reason,
        blocked_reason,
        failed_reason,
        paused_reason,
        dedupe_key,
        market,
        property_address,
        to_phone_number,
        master_owner_id,
        property_id
      FROM public.send_queue
      WHERE queue_status IN ('failed', 'blocked', 'paused_invalid_queue_row', 'paused_duplicate', 'processing')
         OR guard_reason IS NOT NULL
         OR blocked_reason IS NOT NULL
         OR failed_reason IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 50
    ) s
  )
  SELECT jsonb_build_object(
    'counts', (SELECT to_jsonb(counts.*) FROM counts),
    'oldest_queued_at', (SELECT created_at FROM oldest_queued),
    'latest_sent_at', (SELECT at FROM latest_sent),
    'latest_webhook_at', (SELECT created_at FROM latest_webhook),
    'issue_sample', coalesce((SELECT rows FROM issue_sample), '[]'::jsonb)
  );
$$;

CREATE OR REPLACE FUNCTION public.cockpit_ops_metrics_snapshot(
  p_window_start timestamptz,
  p_window_end timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH msg AS (
    SELECT *
    FROM public.message_events
    WHERE created_at >= p_window_start
      AND created_at <= p_window_end
  ),
  queue_rows AS (
    SELECT *
    FROM public.send_queue
    WHERE created_at >= p_window_start
      AND created_at <= p_window_end
  ),
  outbound AS (
    SELECT *
    FROM msg
    WHERE lower(coalesce(direction, '')) = 'outbound'
  ),
  inbound AS (
    SELECT *
    FROM msg
    WHERE lower(coalesce(direction, '')) = 'inbound'
  ),
  outbound_stats AS (
    SELECT
      count(*)::bigint AS sent_count,
      count(*) FILTER (
        WHERE lower(coalesce(provider_delivery_status, delivery_status, '')) = 'delivered'
      )::bigint AS delivered_count,
      count(*) FILTER (
        WHERE lower(coalesce(provider_delivery_status, delivery_status, '')) IN ('failed', 'undelivered', 'rejected', 'error')
          OR is_final_failure IS TRUE
      )::bigint AS failed_count
    FROM outbound
    WHERE lower(coalesce(provider_delivery_status, delivery_status, '')) IN ('delivered', 'failed', 'undelivered', 'rejected', 'error', 'sent', 'accepted', 'queued', 'sending')
       OR lower(coalesce(delivery_status, '')) IN ('delivered', 'failed', 'sent', 'queued', 'sending', 'accepted')
  ),
  inbound_stats AS (
    SELECT
      count(*)::bigint AS received_count,
      count(*) FILTER (WHERE is_opt_out IS TRUE OR lower(coalesce(detected_intent, '')) = 'opt_out')::bigint AS opt_out_count,
      count(*) FILTER (
        WHERE lower(coalesce(detected_intent, '')) IN (
          'seller_interested', 'asking_price_provided', 'asks_offer', 'ownership_confirmed', 'price_anchor'
        )
      )::bigint AS positive_count,
      count(*) FILTER (
        WHERE lower(coalesce(detected_intent, '')) IN (
          'negative', 'not_interested', 'opt_out', 'wrong_number', 'hostile', 'hostile_or_legal'
        )
      )::bigint AS negative_count
    FROM inbound
  ),
  queue_stats AS (
    SELECT
      count(*) FILTER (WHERE lower(queue_status) = 'pending')::bigint AS pending_count,
      count(*) FILTER (WHERE lower(queue_status) = 'queued')::bigint AS queued_count,
      count(*) FILTER (WHERE lower(queue_status) IN ('queued', 'pending', 'scheduled'))::bigint AS queue_waiting_count,
      count(*) FILTER (WHERE lower(queue_status) = 'failed')::bigint AS queue_failed_today_count
    FROM queue_rows
  ),
  active_queue AS (
    SELECT count(*)::bigint AS active_total
    FROM public.send_queue
    WHERE lower(queue_status) IN ('queued', 'pending', 'scheduled', 'processing', 'sending', 'approval')
  ),
  sender_perf AS (
    SELECT coalesce(jsonb_agg(row_to_json(s)::jsonb ORDER BY s.sent_count DESC), '[]'::jsonb) AS rows
    FROM (
      SELECT
        coalesce(nullif(from_phone_number, ''), 'unknown') AS sender,
        count(*)::bigint AS sent_count,
        count(*) FILTER (WHERE lower(coalesce(provider_delivery_status, delivery_status, '')) = 'delivered')::bigint AS delivered_count,
        count(*) FILTER (WHERE lower(coalesce(provider_delivery_status, delivery_status, '')) IN ('failed', 'undelivered', 'rejected', 'error'))::bigint AS failed_count,
        count(*) FILTER (WHERE lower(coalesce(failure_bucket, '')) LIKE '%content%')::bigint AS content_filter_count,
        count(*) FILTER (WHERE lower(coalesce(failure_reason, '')) LIKE '%invalid%')::bigint AS invalid_to_count
      FROM outbound
      GROUP BY 1
      ORDER BY count(*) DESC
      LIMIT 20
    ) s
  )
  SELECT jsonb_build_object(
    'window_start', p_window_start,
    'window_end', p_window_end,
    'message_rows', (SELECT count(*)::bigint FROM msg),
    'queue_rows', (SELECT count(*)::bigint FROM queue_rows),
    'active_queue_rows', (SELECT active_total FROM active_queue),
    'sent_count', (SELECT sent_count FROM outbound_stats),
    'delivered_count', (SELECT delivered_count FROM outbound_stats),
    'failed_count', (SELECT failed_count FROM outbound_stats),
    'received_count', (SELECT received_count FROM inbound_stats),
    'opt_out_count', (SELECT opt_out_count FROM inbound_stats),
    'positive_count', (SELECT positive_count FROM inbound_stats),
    'negative_count', (SELECT negative_count FROM inbound_stats),
    'pending_count', (SELECT pending_count FROM queue_stats),
    'queued_count', (SELECT queued_count FROM queue_stats),
    'queue_waiting_count', (SELECT queue_waiting_count FROM queue_stats),
    'queue_failed_today_count', (SELECT queue_failed_today_count FROM queue_stats),
    'sender_performance', (SELECT rows FROM sender_perf)
  );
$$;

GRANT EXECUTE ON FUNCTION public.cockpit_queue_processor_health() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cockpit_ops_metrics_snapshot(timestamptz, timestamptz) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';