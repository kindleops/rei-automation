-- PROPOSED ROLLBACK for PROPOSED_20261007121000_terminalize_identity_underivable_rows.sql
-- Restores each repaired row's previous status and reasons from
-- metadata.terminal_refusal and removes the repair's metadata keys. The row
-- will then be refused by the dispatcher again (and, with the processor fix
-- deployed, terminalized by it on the next claim).

BEGIN;
SET LOCAL statement_timeout = '30s';

UPDATE public.send_queue q
SET queue_status = q.metadata->'terminal_refusal'->>'previous_queue_status',
    guard_status = q.metadata->'terminal_refusal'->>'previous_guard_status',
    guard_reason = q.metadata->'terminal_refusal'->>'previous_guard_reason',
    blocked_reason = q.metadata->'terminal_refusal'->>'previous_blocked_reason',
    updated_at = now(),
    metadata = (q.metadata - 'terminal_refusal' - 'final_queue_status' - 'blocked_by' - 'blocked_at' - 'finalized_at')
WHERE q.queue_status = 'blocked'
  AND q.metadata->'terminal_refusal'->>'repair' = 'PROPOSED_20261007121000';

COMMIT;
