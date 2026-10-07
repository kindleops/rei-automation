-- PROPOSED DRY RUN (read-only) — the rows PROPOSED_20261007121000_terminalize_identity_underivable_rows.sql
-- would terminalize. 2026-10-07 08:45Z: 1 row
--   51c8ae5c-b74b-4514-8d81-b457d9a01e83 · queued · classifier_cleanup_20261001 ·
--   Indianapolis, IN · created 2026-10-02 · 62 refusals · body is an old persona
--   ("This is Greg. I reached out a while back about 2518 Saint Paul St…").
SELECT id, queue_status, source, market, created_at, scheduled_for_utc, updated_at,
       metadata->>'skip_reason' AS skip_reason,
       metadata->>'dispatch_refusal_count' AS refusals,
       left(message_body, 60) AS body_head
FROM public.send_queue
WHERE queue_status IN ('queued', 'pending', 'scheduled')
  AND metadata->>'skip_reason' = 'queue_row_identity_underivable'
  AND metadata->>'dispatch_refusal_count' ~ '^[0-9]{1,9}$'
  AND (metadata->>'dispatch_refusal_count')::int >= 10
  AND sent_at IS NULL
  AND provider_message_id IS NULL
  AND coalesce(is_locked, false) = false
  AND lock_token IS NULL
ORDER BY created_at;
