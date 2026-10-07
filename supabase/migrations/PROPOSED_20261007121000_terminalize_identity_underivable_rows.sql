-- PROPOSED one-off repair (owner approval required; production data write)
--
-- Why: a queued row whose identity the canonical seam cannot derive
-- (queue_row_identity_underivable: no action anchor) is refused on every
-- dispatch attempt forever. The processor now terminalizes such rows after
-- 10 refusals (dispatch-refusal-backoff.js, system_control
-- queue_terminal_refusal_limit), but only when it next claims them. This ends
-- the ones already stuck, with the same shape the processor writes.
--
-- Today (2026-10-07 08:45Z, read-only dry run
-- PROPOSED_20261007121000_terminalize_identity_underivable_rows_dryrun.sql): 1 row,
--   51c8ae5c-b74b-4514-8d81-b457d9a01e83 (Indianapolis, 62 refusals, old persona body).
--
-- Guards: never sent, no provider id, unlocked, still carrying the reason,
-- >= 10 refusals. Expect UPDATE 1. The previous status/reasons are kept in
-- metadata.terminal_refusal so the rollback can restore them.
-- Rollback: PROPOSED_20261007121000_terminalize_identity_underivable_rows_rollback.sql

BEGIN;
SET LOCAL statement_timeout = '30s';

UPDATE public.send_queue q
SET queue_status = 'blocked',
    guard_status = 'blocked',
    guard_reason = 'queue_row_identity_underivable',
    blocked_reason = 'queue_row_identity_underivable',
    updated_at = now(),
    metadata = coalesce(q.metadata, '{}'::jsonb) || jsonb_build_object(
      'skip_reason', 'queue_row_identity_underivable',
      'final_queue_status', 'blocked',
      'blocked_by', 'repair_20261007_terminal_refusal',
      'blocked_at', now(),
      'finalized_at', now(),
      'terminal_refusal', jsonb_build_object(
        'reason', 'queue_row_identity_underivable',
        'refusal_count', (q.metadata->>'dispatch_refusal_count')::int,
        'first_refused_at', q.metadata->>'dispatch_refusal_first_at',
        'terminalized_at', now(),
        'repair', 'PROPOSED_20261007121000',
        'previous_queue_status', q.queue_status,
        'previous_guard_status', q.guard_status,
        'previous_guard_reason', q.guard_reason,
        'previous_blocked_reason', q.blocked_reason
      )
    )
WHERE q.queue_status IN ('queued', 'pending', 'scheduled')
  AND q.metadata->>'skip_reason' = 'queue_row_identity_underivable'
  AND q.metadata->>'dispatch_refusal_count' ~ '^[0-9]{1,9}$'
  AND (q.metadata->>'dispatch_refusal_count')::int >= 10
  AND q.sent_at IS NULL
  AND q.provider_message_id IS NULL
  AND coalesce(q.is_locked, false) = false
  AND q.lock_token IS NULL;

-- verify: expect the stuck row(s) blocked and nothing else touched
SELECT id, queue_status, blocked_reason, metadata->'terminal_refusal' AS terminal_refusal
FROM public.send_queue
WHERE metadata->'terminal_refusal'->>'repair' = 'PROPOSED_20261007121000';

COMMIT;
