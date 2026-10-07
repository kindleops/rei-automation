-- PROPOSED — queue health counts OVERDUE rows, not merely old ones (owner approval required)
--
-- Why: the desktop machine badge reads "Degraded" permanently. deriveStatus()
-- (apps/api/src/lib/cockpit/queue-processor-health-service.js) degrades on
-- lag_active > 0 OR stale_active > 0, and this RPC defined them as
--   stale_active = any queued/pending/approval/scheduled/processing row with
--                  updated_at > 15 min old  -> every future-scheduled row
--   lag_active   = queued/pending/processing created > 15 min ago, due or not
-- Measured 2026-10-07 08:40Z: 85 'scheduled' rows, all due in the future
-- (earliest 13:08Z), all counted stale; plus 1 queued row the dispatcher has
-- refused 62 times (queue_row_identity_underivable).
--
-- New definitions (identical to summarizeOverdue() in the service, which also
-- serves the JS fallback and overlays the old RPC until this is applied):
--   due_at             = coalesce(scheduled_for_utc, created_at)
--   overdue_active     = queued/pending/scheduled/processing, due_at < now()-15m,
--                        dispatch_refusal_count < 5
--   lag_active         = overdue_active ∩ queued/pending/processing
--   stale_active       = overdue_active ∩ updated_at < now()-15m
--   refused_repeatedly = active rows with metadata.dispatch_refusal_count >= 5
--                        (ATTENTION, not degraded; sample in refused_sample)
-- Approval rows never count as overdue/stale; they keep their own count.
-- New top-level keys: oldest_overdue_due_at, refused_sample. Every existing key
-- is kept (same names, same types); consumers: queue-processor-health-service,
-- command-wall/wall-snapshot-service (reads lag_active directly).
--
-- Safety: CREATE OR REPLACE of a STABLE read-only SQL function; same signature
-- and return type, so grants are preserved. No data change.
-- Rollback: PROPOSED_20261007120000_queue_health_overdue_semantics_rollback.sql
--   (the current definition, byte for byte from pg_get_functiondef).

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
  active AS (
    SELECT
      id,
      queue_status,
      created_at,
      updated_at,
      market,
      source,
      metadata->>'skip_reason' AS skip_reason,
      coalesce(scheduled_for_utc, created_at) AS due_at,
      CASE WHEN metadata->>'dispatch_refusal_count' ~ '^[0-9]{1,9}$'
           THEN (metadata->>'dispatch_refusal_count')::int ELSE 0 END AS refusals
    FROM public.send_queue
    WHERE queue_status IN ('queued', 'pending', 'approval', 'scheduled', 'processing')
  ),
  overdue AS (
    SELECT *
    FROM active
    WHERE queue_status IN ('queued', 'pending', 'scheduled', 'processing')
      AND refusals < 5
      AND due_at < (SELECT ts FROM lag_cutoff)
  ),
  counts AS (
    SELECT
      (SELECT count(*)::bigint FROM public.send_queue WHERE queue_status = 'queued') AS queued,
      (SELECT count(*)::bigint FROM public.send_queue WHERE queue_status = 'pending') AS pending,
      (SELECT count(*)::bigint FROM public.send_queue WHERE queue_status = 'approval') AS approval,
      (SELECT count(*)::bigint FROM public.send_queue WHERE queue_status = 'scheduled') AS scheduled,
      (SELECT count(*)::bigint FROM public.send_queue WHERE queue_status = 'processing') AS processing,
      (SELECT count(*)::bigint FROM overdue
        WHERE queue_status IN ('queued', 'pending', 'processing')) AS lag_active,
      (SELECT count(*)::bigint FROM public.send_queue
        WHERE sent_at >= (SELECT ts FROM today_start)) AS sent_today,
      (SELECT count(*)::bigint FROM public.send_queue
        WHERE queue_status = 'delivered' AND delivered_at >= (SELECT ts FROM today_start)) AS delivered_today,
      (SELECT count(*)::bigint FROM public.send_queue
        WHERE queue_status = 'failed' AND updated_at >= (SELECT ts FROM today_start)) AS failed_today,
      (SELECT count(*)::bigint FROM overdue
        WHERE updated_at < (SELECT ts FROM lag_cutoff)) AS stale_active,
      (SELECT count(*)::bigint FROM overdue) AS overdue_active,
      (SELECT count(*)::bigint FROM active WHERE refusals >= 5) AS refused_repeatedly,
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
  refused_sample AS (
    SELECT jsonb_agg(row_to_json(r)::jsonb) AS rows
    FROM (
      SELECT id, queue_status, market, source, refusals AS dispatch_refusal_count, skip_reason, created_at
      FROM active
      WHERE refusals >= 5
      ORDER BY refusals DESC, created_at ASC
      LIMIT 5
    ) r
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
    'oldest_overdue_due_at', (SELECT min(due_at) FROM overdue),
    'latest_sent_at', (SELECT at FROM latest_sent),
    'latest_webhook_at', (SELECT created_at FROM latest_webhook),
    'issue_sample', coalesce((SELECT rows FROM issue_sample), '[]'::jsonb),
    'refused_sample', coalesce((SELECT rows FROM refused_sample), '[]'::jsonb)
  );
$function$;
