-- FORWARD: backfill uncovered 21610 sender-recipient pairs only (2 rows)
INSERT INTO public.sms_suppression_list (
  phone_e164,
  sender_phone_e164,
  phone_number,
  suppression_type,
  suppression_reason,
  is_active,
  suppressed_at,
  source
)
SELECT DISTINCT
  sq.to_phone_number,
  sq.from_phone_number,
  sq.to_phone_number,
  'provider_blacklist_pair',
  COALESCE(NULLIF(sq.failed_reason, ''), 'provider_blacklist_21610'),
  true,
  NOW(),
  'reconciliation_21610_pair_backfill'
FROM public.send_queue sq
WHERE sq.failed_reason ILIKE '%21610%'
  AND sq.to_phone_number IS NOT NULL
  AND sq.from_phone_number IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.sms_suppression_list ssl
    WHERE ssl.phone_e164 = sq.to_phone_number
      AND ssl.sender_phone_e164 = sq.from_phone_number
  )
ON CONFLICT (phone_e164, sender_phone_e164) DO NOTHING;

-- FORWARD: terminalize any still-retryable 21610 queue rows (predicate scoped to 21610 only)
UPDATE public.send_queue
SET
  queue_status = 'failed',
  next_retry_at = NULL,
  is_locked = false,
  locked_at = NULL,
  lock_token = NULL,
  updated_at = NOW(),
  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'reconciled_at', NOW(),
    'reconciliation_reason', 'provider_blacklist_21610',
    'final_queue_status', 'failed'
  )
WHERE failed_reason ILIKE '%21610%'
  AND queue_status IN ('queued','scheduled','pending','processing','ready','runnable','paused','paused_after_hours');

-- ROLLBACK: remove only reconciliation backfill rows
DELETE FROM public.sms_suppression_list
WHERE source = 'reconciliation_21610_pair_backfill'
  AND suppression_type = 'provider_blacklist_pair';
