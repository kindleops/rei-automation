-- Single-pass range KPI counts for cockpit queue page (replaces 8 separate head counts).

CREATE OR REPLACE FUNCTION public.cockpit_queue_page_range_counts(
  p_date_basis text DEFAULT 'created_at',
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL,
  p_market text DEFAULT NULL,
  p_sender text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH filtered AS (
    SELECT lower(coalesce(queue_status, '')) AS status
    FROM public.send_queue
    WHERE (
      CASE
        WHEN p_date_basis = 'scheduled_for' THEN
          (p_date_from IS NULL OR scheduled_for >= p_date_from)
          AND (p_date_to IS NULL OR scheduled_for <= p_date_to)
        WHEN p_date_basis = 'updated_at' THEN
          (p_date_from IS NULL OR updated_at >= p_date_from)
          AND (p_date_to IS NULL OR updated_at <= p_date_to)
        ELSE
          (p_date_from IS NULL OR created_at >= p_date_from)
          AND (p_date_to IS NULL OR created_at <= p_date_to)
      END
    )
    AND (p_market IS NULL OR p_market = '' OR p_market = 'all' OR market = p_market)
    AND (p_sender IS NULL OR p_sender = '' OR p_sender = 'all' OR from_phone_number = p_sender)
  ),
  counts AS (
    SELECT
      count(*) FILTER (WHERE status = 'scheduled')::bigint AS scheduled,
      count(*) FILTER (WHERE status IN ('queued', 'ready', 'pending'))::bigint AS queued,
      count(*) FILTER (WHERE status = 'sending')::bigint AS sending,
      count(*) FILTER (WHERE status IN ('sent', 'delivered', 'failed', 'retry', 'retrying'))::bigint AS sent,
      count(*) FILTER (WHERE status = 'delivered')::bigint AS delivered,
      count(*) FILTER (WHERE status IN ('failed', 'retry', 'retrying'))::bigint AS failed,
      count(*) FILTER (WHERE status IN (
        'blocked', 'paused_invalid_queue_row', 'paused_name_missing', 'paused_max_retries',
        'paused_duplicate', 'paused_global_lock', 'duplicate_blocked', 'incident_quarantine'
      ))::bigint AS blocked,
      count(*) FILTER (WHERE status IN ('approval', 'awaiting_approval'))::bigint AS approval,
      count(*)::bigint AS total
    FROM filtered
  )
  SELECT jsonb_build_object(
    'scheduled', scheduled,
    'queued', queued,
    'sending', sending,
    'sent', sent,
    'delivered', delivered,
    'failed', failed,
    'blocked', blocked,
    'approval', approval,
    'optOuts', 0,
    'total', total
  )
  FROM counts;
$$;

GRANT EXECUTE ON FUNCTION public.cockpit_queue_page_range_counts(text, timestamptz, timestamptz, text, text)
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';