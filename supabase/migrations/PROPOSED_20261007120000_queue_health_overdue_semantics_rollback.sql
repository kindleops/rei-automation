-- PROPOSED ROLLBACK — restores public.cockpit_queue_processor_health() exactly as
-- it was in production on 2026-10-07 (pg_get_functiondef, fetched read-only).
-- Pairs with PROPOSED_20261007120000_queue_health_overdue_semantics.sql.

CREATE OR REPLACE FUNCTION public.cockpit_queue_processor_health()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
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
$function$
;
