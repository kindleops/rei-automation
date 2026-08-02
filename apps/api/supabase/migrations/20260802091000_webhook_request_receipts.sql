-- ─────────────────────────────────────────────────────────────────────────────
-- Route-level webhook request receipts.
--
-- The inbound_processing_ledger records authenticated MESSAGE events only:
-- requests rejected at the route (invalid signature, malformed payload,
-- missing sender, oversized body, auth failure, parser exception, …)
-- terminate before the handler wrapper and were previously log-only. This
-- table is the separate request-receipt audit layer: one row per inbound
-- HTTP request OUTCOME, durable and queryable, without polluting the
-- message-event ledger with non-message noise.
--
-- PII posture (mirrors the ledger):
--   * never the raw request body — SHA-256 digest + length only;
--   * phone identifiers masked to last-4 plus a SHA-256 digest for
--     correlation; full numbers are never stored here;
--   * every row hard-deleted after retain_until (receipt + 30 days) by the
--     existing daily /api/internal/inbound/ledger-retention-purge cron.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.webhook_request_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Correlation spine: route-generated correlation id, plus optional links to
  -- the raw webhook_log row and the message ledger's idempotency key when the
  -- request survived far enough to have them.
  correlation_id text NOT NULL,
  webhook_log_id uuid,
  idempotency_key text,
  provider text NOT NULL DEFAULT 'textgrid',
  endpoint text NOT NULL,
  event_kind text,
  provider_message_sid text,
  from_phone_masked text,
  from_phone_sha256 text,
  to_phone_masked text,
  to_phone_sha256 text,
  body_sha256 text,
  body_length integer NOT NULL DEFAULT 0,
  -- Terminal outcome of the HTTP request at the route boundary.
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'rejected', 'duplicate')),
  rejection_reason text,
  signature_status text NOT NULL DEFAULT 'unknown'
    CHECK (signature_status IN (
      'valid', 'invalid', 'missing', 'skipped_mode_off',
      'skipped_log_only', 'not_applicable', 'unknown'
    )),
  http_status integer NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  retain_until timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A rejected receipt must say why; "rejected for no recorded reason" is the
  -- unobservable outcome this table exists to eliminate.
  CONSTRAINT webhook_receipt_rejection_requires_reason
    CHECK (outcome <> 'rejected' OR rejection_reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS webhook_request_receipts_received_idx
  ON public.webhook_request_receipts (received_at DESC);

CREATE INDEX IF NOT EXISTS webhook_request_receipts_outcome_idx
  ON public.webhook_request_receipts (outcome, rejection_reason, received_at DESC);

CREATE INDEX IF NOT EXISTS webhook_request_receipts_sid_idx
  ON public.webhook_request_receipts (provider_message_sid);

CREATE INDEX IF NOT EXISTS webhook_request_receipts_correlation_idx
  ON public.webhook_request_receipts (correlation_id);

CREATE INDEX IF NOT EXISTS webhook_request_receipts_retain_until_idx
  ON public.webhook_request_receipts (retain_until);

COMMENT ON TABLE public.webhook_request_receipts IS
  'One durable row per inbound webhook HTTP request outcome, including requests rejected before the core handler (invalid signature, malformed payload, oversized body, auth failure, parser exception, rate limit, duplicate delivery). PII minimization: hashed bodies, masked+hashed phones, no raw content. Rows hard-deleted after retain_until (receipt + 30 days) by the daily ledger-retention-purge cron.';

COMMENT ON COLUMN public.webhook_request_receipts.outcome IS
  'accepted = handed to the core handler; rejected = terminated at the route (rejection_reason set); duplicate = idempotency claim reported a prior terminal outcome for this delivery.';

ALTER TABLE public.webhook_request_receipts ENABLE ROW LEVEL SECURITY;
