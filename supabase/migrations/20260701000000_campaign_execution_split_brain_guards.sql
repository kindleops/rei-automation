-- Campaign execution split-brain guards (Phase 3).
--
-- Purpose: make the "active + proof + live-row" combination impossible at the
-- database layer, complementing the shared application guards in
-- apps/api/src/lib/domain/campaigns/campaign-live-execution.js.
--
-- Safety / review notes:
--   * All constraints are added `NOT VALID`: they enforce on every future INSERT
--     or UPDATE but do NOT scan or reject pre-existing rows. This is fully
--     additive and safe to apply while the currently-broken campaign still
--     exists — the row is only re-checked when it is next written (e.g. by the
--     canonical reconciliation, which writes it into a consistent live state).
--   * Text comparisons (lower(metadata->>'x') = 'true') are used instead of
--     ::boolean casts so a malformed/legacy metadata value can never raise a
--     cast error on an unrelated write.
--   * These guards deliberately do NOT reference the campaign pause state, so
--     legitimate explicit pause behavior (auto_queue/auto_send off while paused)
--     is never blocked.
--
-- Recommended apply order in production:
--   1. Deploy the API code (queue-aware reconciliation).
--   2. Reconcile the affected campaign through the canonical service so its row
--      becomes internally consistent.
--   3. Apply this migration (constraints are additive / NOT VALID).
--   4. Optionally `VALIDATE CONSTRAINT` after a full backfill audit.

-- Campaign level: an active/activating campaign must not advertise a proof
-- execution mode. This is the primary split-brain state.
ALTER TABLE public.campaigns
  DROP CONSTRAINT IF EXISTS campaigns_no_active_proof_execution_mode;
ALTER TABLE public.campaigns
  ADD CONSTRAINT campaigns_no_active_proof_execution_mode
  CHECK (
    NOT (
      lower(coalesce(status, '')) IN ('active', 'activating')
      AND lower(coalesce(metadata->>'execution_mode', '')) = 'proof'
    )
  ) NOT VALID;

-- Row level: a queue row cannot be simultaneously proof-hydrated and confirmed
-- live (contradictory live/proof row).
ALTER TABLE public.send_queue
  DROP CONSTRAINT IF EXISTS send_queue_no_proof_confirm_live_conflict;
ALTER TABLE public.send_queue
  ADD CONSTRAINT send_queue_no_proof_confirm_live_conflict
  CHECK (
    NOT (
      lower(coalesce(metadata->>'proof_hydration', '')) = 'true'
      AND lower(coalesce(metadata->>'confirm_live', '')) = 'true'
    )
  ) NOT VALID;

-- Row level: a confirmed-live row cannot retain no_send (live rows cannot stay
-- no_send).
ALTER TABLE public.send_queue
  DROP CONSTRAINT IF EXISTS send_queue_no_confirm_live_no_send_conflict;
ALTER TABLE public.send_queue
  ADD CONSTRAINT send_queue_no_confirm_live_no_send_conflict
  CHECK (
    NOT (
      lower(coalesce(metadata->>'confirm_live', '')) = 'true'
      AND lower(coalesce(metadata->>'no_send', '')) = 'true'
    )
  ) NOT VALID;
