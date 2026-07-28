-- Seller inbound burst coordination (durable debounce).
-- Groups rapid same-thread inbound messages into one orchestration generation.
-- Raw messages remain in message_events; this table is only the decision timer/claim.
--
-- ACTIVATION PREREQUISITES (SELLER_INBOUND_BURST_ENABLED must stay false until ALL hold):
--   1. This migration is applied to the target database (table + claim RPC).
--      If the flag is enabled without the schema, burst appends throw, the
--      inbound webhook fails the idempotency record and returns an error, and
--      the provider retries — fail-closed; no message is silently swallowed
--      and NO per-message auto-reply fallback occurs.
--   2. A flush worker is wired (cron/scheduler POSTing
--      /api/internal/seller-flow/flush-inbound-bursts with the internal
--      secret) at a cadence <= the 20s debounce window's practical latency
--      budget. Without it, non-safety bursts finalize only when a LATER
--      inbound forces the hard-close rollover's inline flush — delayed, never
--      lost. Safety latches (STOP / wrong number / hostile) always finalize
--      inline on receipt regardless of the flush worker.
--   3. Flush-path auto-reply gating (system_control auto_reply_mode /
--      auto_reply_enabled) is resolved by the flush caller before live
--      queueing is allowed; the default flush context stays non-live.

CREATE TABLE IF NOT EXISTS public.seller_inbound_bursts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_key text NOT NULL,
  generation integer NOT NULL,
  burst_id text NOT NULL,
  status text NOT NULL
    CHECK (status IN ('open', 'claimed', 'completed', 'suppressed', 'failed', 'cancelled')),
  first_event_id text,
  latest_event_id text,
  constituent_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  constituent_messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  first_received_at timestamptz NOT NULL,
  last_received_at timestamptz NOT NULL,
  eligible_at timestamptz NOT NULL,
  hard_close_at timestamptz NOT NULL,
  safety_latched boolean NOT NULL DEFAULT false,
  safety_reason text,
  safety_kind text,
  version integer NOT NULL DEFAULT 1,
  policy_version text,
  decision_idempotency_key text,
  claim_token text,
  claimed_at timestamptz,
  claimed_by text,
  attempt_count integer NOT NULL DEFAULT 0,
  completed_at timestamptz,
  result_summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seller_inbound_bursts_thread_generation_unique UNIQUE (thread_key, generation),
  CONSTRAINT seller_inbound_bursts_burst_id_unique UNIQUE (burst_id)
);

COMMENT ON TABLE public.seller_inbound_bursts IS
  'Durable seller-inbound burst debounce state. One open generation per thread. Does not store raw SMS authority — message_events remains the message ledger. completed_at is the terminal marker (completed AND finalized-suppressed); claimed_at + lease governs crash reclaim.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_seller_inbound_bursts_one_open_per_thread
  ON public.seller_inbound_bursts (thread_key)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_seller_inbound_bursts_eligible
  ON public.seller_inbound_bursts (eligible_at ASC)
  WHERE status IN ('open', 'suppressed');

-- Stale-claim reclaim scan (crash recovery).
CREATE INDEX IF NOT EXISTS idx_seller_inbound_bursts_claimed_at
  ON public.seller_inbound_bursts (claimed_at ASC)
  WHERE status = 'claimed';

CREATE INDEX IF NOT EXISTS idx_seller_inbound_bursts_thread_generation
  ON public.seller_inbound_bursts (thread_key, generation DESC);

-- Atomic claim: exclusive worker for eligible open/suppressed bursts, plus
-- deterministic stale-lease reclaim of claimed work whose worker died.
--
-- Claimability (must match isClaimableBurst in seller-inbound-burst-policy.js):
--   * completed_at IS NULL always (completed / finalized-suppressed are terminal)
--   * status IN (open, suppressed): eligible_at <= now AND no live claim lease
--     (claimed_at NULL or older than the lease) — a fresh claim is never stolen
--   * status = claimed: claimed_at older than the lease (crash recovery only)
--   * failed / cancelled: never claimable
-- Reclaim retains generation, constituent_messages and decision_idempotency_key;
-- it only rotates claim_token/claimed_at/claimed_by and increments attempt_count.
CREATE OR REPLACE FUNCTION public.claim_seller_inbound_burst(
  p_thread_key text DEFAULT NULL,
  p_burst_id text DEFAULT NULL,
  p_now timestamptz DEFAULT now(),
  p_worker_id text DEFAULT 'worker',
  p_claim_token text DEFAULT NULL,
  p_lease_ms bigint DEFAULT 300000
)
RETURNS SETOF public.seller_inbound_bursts
LANGUAGE plpgsql
AS $$
DECLARE
  v_token text := COALESCE(NULLIF(trim(p_claim_token), ''), encode(gen_random_bytes(16), 'hex'));
  v_stale timestamptz := p_now - make_interval(secs => GREATEST(p_lease_ms, 0) / 1000.0);
  v_id uuid;
  v_safety boolean;
BEGIN
  SELECT b.id, b.safety_latched
    INTO v_id, v_safety
  FROM public.seller_inbound_bursts b
  WHERE b.completed_at IS NULL
    AND (
      (
        b.status IN ('open', 'suppressed')
        AND b.eligible_at <= p_now
        AND (b.claimed_at IS NULL OR b.claimed_at <= v_stale)
      )
      OR (
        b.status = 'claimed'
        AND b.claimed_at IS NOT NULL
        AND b.claimed_at <= v_stale
      )
    )
    AND (p_burst_id IS NULL OR b.burst_id = p_burst_id)
    AND (p_thread_key IS NULL OR b.thread_key = p_thread_key)
  ORDER BY b.eligible_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.seller_inbound_bursts b
  SET
    status = CASE WHEN COALESCE(v_safety, false) THEN 'suppressed' ELSE 'claimed' END,
    claim_token = v_token,
    claimed_at = p_now,
    claimed_by = COALESCE(NULLIF(trim(p_worker_id), ''), 'worker'),
    attempt_count = b.attempt_count + 1,
    version = b.version + 1,
    updated_at = p_now
  WHERE b.id = v_id
  RETURNING b.*;
END;
$$;

COMMENT ON FUNCTION public.claim_seller_inbound_burst IS
  'Atomically claim one eligible seller inbound burst for exclusive finalize (SKIP LOCKED), including stale-lease reclaim of claimed work whose worker died. Fresh claims are never stolen; completed/finalized-suppressed rows are never reclaimed.';
