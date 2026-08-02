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
  -- PII minimization: never store raw seller message text. A SHA-256 digest +
  -- length is enough to correlate retries and detect divergent payloads.
  body_sha256 text,
  body_length integer NOT NULL DEFAULT 0,
  received_at timestamptz NOT NULL DEFAULT now(),
  -- Retention deadline: receipt + INBOUND_LEDGER_RETENTION_DAYS (30 days).
  -- Rows past this instant are hard-deleted by the daily
  -- /api/internal/inbound/ledger-retention-purge cron.
  retain_until timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
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

-- Retention purge: the daily cleanup selects expired rows by retain_until in
-- bounded batches (select-then-delete), so the deadline column must be
-- indexed or the purge degrades to a sequential scan as the table grows.
CREATE INDEX IF NOT EXISTS inbound_processing_ledger_retain_until_idx
  ON public.inbound_processing_ledger (retain_until);

-- Retention policy of record. The ledger stores seller phone numbers (they ARE
-- the thread identifiers the SLA scan and ops correlation need) and message
-- digests, never raw message text. Every row is hard-deleted once retain_until
-- passes; the writer (inbound-processing-ledger.js, INBOUND_LEDGER_RETENTION_DAYS)
-- and this default must stay at the same 30-day window.
COMMENT ON TABLE public.inbound_processing_ledger IS
  'Durable per-inbound terminal-disposition ledger. PII minimization: no raw message text (body_sha256 + body_length only); seller phone numbers kept as thread identifiers. Retention: rows are hard-deleted after retain_until (receipt + 30 days) by the daily /api/internal/inbound/ledger-retention-purge cron.';

COMMENT ON COLUMN public.inbound_processing_ledger.retain_until IS
  'Hard-delete deadline: received_at + 30-day retention window (INBOUND_LEDGER_RETENTION_DAYS). Enforced by /api/internal/inbound/ledger-retention-purge.';

COMMENT ON COLUMN public.inbound_processing_ledger.body_sha256 IS
  'SHA-256 hex digest of the inbound message body. The raw seller text is deliberately never persisted here.';

ALTER TABLE public.inbound_processing_ledger ENABLE ROW LEVEL SECURITY;
