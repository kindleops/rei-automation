-- ─────────────────────────────────────────────────────────────────────────────
-- Inbound processing ledger: one durable row per inbound processing attempt,
-- carrying the canonical TERMINAL DISPOSITION for the launch invariant
-- "every inbound event reaches exactly one explicit terminal disposition".
--
-- Why a table (and not metadata on message_events):
--   * the prior idempotency/disposition record lived in
--     /tmp/real-estate-automation-runtime-state (per-instance, ephemeral on
--     Vercel) — a webhook retry on a different lambda saw nothing;
--   * several webhook exit paths (empty body, malformed payload, invalid
--     signature) never create a message_events row at all, so the disposition
--     record cannot live there;
--   * the SLA scan needs one indexed query: "processing rows older than N
--     minutes with no terminal disposition" → P0 alert.
--
-- This migration is additive only. Nothing reads it until the disposition
-- recorder ships in the same release.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.inbound_processing_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  provider_message_sid text,
  thread_key text,
  from_phone text,
  to_phone text,
  message_preview text,
  received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'completed', 'failed')),
  attempt_count integer NOT NULL DEFAULT 1,
  terminal_disposition text
    CHECK (
      terminal_disposition IS NULL OR terminal_disposition IN (
        'reply_sent',
        'reply_deferred_compliance',
        'suppressed_opt_out',
        'suppressed_wrong_number',
        'suppressed_policy',
        'human_review_required',
        'duplicate_ignored',
        'no_reply_required',
        'failed_retriable',
        'failed_terminal'
      )
    ),
  disposition_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  classifier_version text,
  detected_intent text,
  confidence numeric,
  processing_run_id uuid,
  latency_ms integer,
  error_message text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A completed attempt without a disposition is exactly the silent drop the
  -- launch invariant forbids: make it unrepresentable.
  CONSTRAINT inbound_ledger_completed_requires_disposition
    CHECK (status <> 'completed' OR terminal_disposition IS NOT NULL)
);

-- One ledger row per idempotency key: retries update attempt_count in place.
CREATE UNIQUE INDEX IF NOT EXISTS inbound_processing_ledger_idempotency_key_idx
  ON public.inbound_processing_ledger (idempotency_key);

-- SLA scan: processing rows past the disposition deadline.
CREATE INDEX IF NOT EXISTS inbound_processing_ledger_status_received_idx
  ON public.inbound_processing_ledger (status, received_at);

CREATE INDEX IF NOT EXISTS inbound_processing_ledger_provider_sid_idx
  ON public.inbound_processing_ledger (provider_message_sid);

CREATE INDEX IF NOT EXISTS inbound_processing_ledger_thread_key_idx
  ON public.inbound_processing_ledger (thread_key);

ALTER TABLE public.inbound_processing_ledger ENABLE ROW LEVEL SECURITY;
