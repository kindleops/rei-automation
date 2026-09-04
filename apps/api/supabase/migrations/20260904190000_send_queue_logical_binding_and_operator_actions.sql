-- ─── send_queue subordination + durable operator actions (§11 Slice 1) ──────
--
-- TWO THINGS THE DISPATCH SEAM CANNOT WORK WITHOUT.
--
-- 1. A QUEUE ROW MUST NAME ITS DOMAIN ACTION.
--    send_queue schedules transport. It has never been able to say WHICH
--    seller communication a row represents, so the runner had no choice but to
--    treat queue_status/retry_count/next_retry_at as send authority. Binding a
--    row to a logical communication is what demotes those fields to scheduling
--    hints: the provider call then requires the logical row's permission, not
--    the queue row's.
--
--    Nullable on purpose. 17k historical rows predate §11 and must not be
--    invented into a lineage they never had. A NULL binding does NOT mean
--    "unprotected, send freely" -- the dispatch seam refuses a row whose
--    identity it cannot derive. Absence of identity is a refusal, not a licence.
--
-- 2. A MANUAL SEND MUST BE A DURABLE ACTION BEFORE IT IS A MESSAGE.
--    send-now minted `inbox:send_now:${randomUUID()}` INSIDE the execution
--    path, so the identity of an operator's intent was created by the act of
--    executing it. Nothing could then distinguish "the same click retried"
--    from "a second deliberate click" -- the two are only separable if the
--    action exists durably BEFORE the send is attempted.
--
--    request_idempotency_key is what makes a retry of one click resolve to one
--    action. When a caller supplies none, each call is honestly a NEW operator
--    action rather than a guess dressed up as deduplication.

ALTER TABLE public.send_queue
  ADD COLUMN IF NOT EXISTS logical_communication_id uuid
    REFERENCES public.seller_logical_communications(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_send_queue_logical_communication
  ON public.send_queue (logical_communication_id)
  WHERE logical_communication_id IS NOT NULL;

COMMENT ON COLUMN public.send_queue.logical_communication_id IS
  'The domain action this row schedules (§11 Slice 1). Queue status, retry_count, next_retry_at and lock state are scheduling hints; the logical communication is the send authority. NULL means identity was never established, which the dispatch seam treats as a refusal, not permission.';

CREATE TABLE IF NOT EXISTS public.seller_operator_actions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type             text NOT NULL,
  thread_key              text,
  to_phone_number         text,
  operator_email          text,
  operator_note           text,

  -- Supplied by the caller to make a retry of ONE click resolve to ONE action.
  -- Partial-unique so the common no-key case stays a genuinely new action
  -- rather than colliding every keyless request into one row.
  request_idempotency_key text,

  -- A manual send may deliberately FOLLOW an ambiguous communication. That is a
  -- new action with an audit trail, never a retry of the ambiguous one, and it
  -- must never mutate the prior communication.
  prior_logical_communication_id uuid
    REFERENCES public.seller_logical_communications(id) ON DELETE SET NULL,

  created_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT seller_operator_actions_type_valid
    CHECK (action_type IN ('manual_inbox_send_now', 'map_ownership_check', 'operator_reply'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_operator_actions_idempotency
  ON public.seller_operator_actions (request_idempotency_key)
  WHERE request_idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_seller_operator_actions_thread
  ON public.seller_operator_actions (thread_key, created_at DESC);

ALTER TABLE public.seller_operator_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seller_operator_actions FROM anon, authenticated;

COMMENT ON TABLE public.seller_operator_actions IS
  'Durable operator intent (§11 Slice 1). Created BEFORE any provider attempt so that a manual send has an identity independent of its execution. Retrying one action reuses its id; a separate click is a separate row.';
