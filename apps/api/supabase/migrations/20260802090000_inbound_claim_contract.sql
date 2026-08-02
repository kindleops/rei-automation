-- ─────────────────────────────────────────────────────────────────────────────
-- Inbound idempotency: make the durable ledger the ENFORCEMENT authority.
--
-- Before this migration the ledger was observability only — the decision
-- "has this inbound already been processed?" lived in
-- /tmp/real-estate-automation-runtime-state, which is per-instance and
-- ephemeral on Vercel: a provider retry landing on a different lambda saw
-- nothing and re-ran seller automation. The begin/record JS path was also a
-- SELECT→INSERT read-modify-write with an unprotected race window.
--
-- This migration adds the atomic claim contract:
--   * claim_inbound_processing(...)   — exactly-one-winner claim per
--     idempotency key, with leases, attempt counts and run-id fencing;
--   * complete_inbound_processing(...) — run-id-fenced terminal-disposition
--     write, so a worker whose lease expired (a zombie) can never overwrite
--     the disposition of the worker that reclaimed the row.
--
-- Claim outcomes (jsonb `outcome` field):
--   claimed_new         — first claim for this key; caller must process.
--   retry_claimed       — prior attempt failed retriably or its lease
--                         expired; caller must process (attempt_count += 1).
--   duplicate_completed — a prior attempt already completed; caller must NOT
--                         process; prior disposition is returned for the
--                         duplicate_ignored audit.
--   already_processing  — another worker holds an unexpired lease.
--   terminally_failed   — the key is terminally failed (or attempts
--                         exhausted); caller must NOT process.
--   invalid_claim       — unusable arguments; nothing was written.
--
-- Concurrency: competing claims serialize on INSERT .. ON CONFLICT plus
-- SELECT .. FOR UPDATE of the ledger row, so two concurrent webhook
-- deliveries of the same message can never both receive a processing claim.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.inbound_processing_ledger
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS duplicate_delivery_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_duplicate_at timestamptz;

COMMENT ON COLUMN public.inbound_processing_ledger.lease_expires_at IS
  'Processing lease deadline. A processing row whose lease has passed is reclaimable (retry_claimed); the reclaim rotates processing_run_id so the previous holder is fenced out of complete_inbound_processing.';

COMMENT ON COLUMN public.inbound_processing_ledger.duplicate_delivery_count IS
  'Number of claim attempts that arrived after the row reached a terminal state (completed or terminally failed). Each one is the durable audit of a duplicate_ignored delivery.';

-- SLA scan support: reclaimable rows are found by lease expiry, not wall age.
CREATE INDEX IF NOT EXISTS inbound_processing_ledger_lease_idx
  ON public.inbound_processing_ledger (status, lease_expires_at);

CREATE OR REPLACE FUNCTION public.claim_inbound_processing(
  p_idempotency_key text,
  p_provider_message_sid text DEFAULT NULL,
  p_thread_key text DEFAULT NULL,
  p_from_phone text DEFAULT NULL,
  p_to_phone text DEFAULT NULL,
  p_body_sha256 text DEFAULT NULL,
  p_body_length integer DEFAULT 0,
  p_received_at timestamptz DEFAULT NULL,
  p_processing_run_id uuid DEFAULT NULL,
  p_lease_seconds integer DEFAULT 600,
  p_max_attempts integer DEFAULT 5
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_key text;
  v_now timestamptz := now();
  v_lease_seconds integer;
  v_max_attempts integer;
  v_run_id uuid;
  v_received_at timestamptz;
  v_row public.inbound_processing_ledger%ROWTYPE;
  v_inserted_id uuid;
  v_attempt integer;
BEGIN
  v_key := trim(COALESCE(p_idempotency_key, ''));
  IF v_key = '' THEN
    RETURN jsonb_build_object(
      'ok', false, 'outcome', 'invalid_claim',
      'reason', 'idempotency_key_required');
  END IF;

  -- Defensive clamps: a hostile/buggy caller cannot mint an hour-zero lease
  -- (instant reclaim → double execution) or an unbounded one (permanent wedge).
  v_lease_seconds := LEAST(GREATEST(COALESCE(p_lease_seconds, 600), 30), 3600);
  v_max_attempts := LEAST(GREATEST(COALESCE(p_max_attempts, 5), 1), 20);
  v_run_id := COALESCE(p_processing_run_id, gen_random_uuid());
  v_received_at := COALESCE(p_received_at, v_now);

  -- Two-round loop: round 1 normally settles it; round 2 only runs in the
  -- rare interleaving where the row is purged/deleted between our conflict
  -- and our lock.
  FOR v_attempt IN 1..2 LOOP
    INSERT INTO public.inbound_processing_ledger (
      idempotency_key, provider_message_sid, thread_key,
      from_phone, to_phone, body_sha256, body_length,
      received_at, retain_until,
      status, attempt_count, processing_run_id,
      claimed_at, lease_expires_at
    ) VALUES (
      v_key, NULLIF(trim(COALESCE(p_provider_message_sid, '')), ''),
      NULLIF(trim(COALESCE(p_thread_key, '')), ''),
      NULLIF(trim(COALESCE(p_from_phone, '')), ''),
      NULLIF(trim(COALESCE(p_to_phone, '')), ''),
      NULLIF(trim(COALESCE(p_body_sha256, '')), ''),
      GREATEST(COALESCE(p_body_length, 0), 0),
      v_received_at, v_received_at + interval '30 days',
      'processing', 1, v_run_id,
      v_now, v_now + make_interval(secs => v_lease_seconds)
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO v_inserted_id;

    IF v_inserted_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok', true, 'outcome', 'claimed_new',
        'ledger_id', v_inserted_id,
        'processing_run_id', v_run_id,
        'attempt_count', 1,
        'lease_expires_at', v_now + make_interval(secs => v_lease_seconds));
    END IF;

    SELECT * INTO v_row
    FROM public.inbound_processing_ledger
    WHERE idempotency_key = v_key
    FOR UPDATE;

    IF FOUND THEN
      EXIT;
    END IF;
    -- Row vanished between conflict and lock (retention purge): retry insert.
  END LOOP;

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'outcome', 'invalid_claim',
      'reason', 'claim_row_unstable');
  END IF;

  IF v_row.status = 'completed' THEN
    -- Duplicate completed delivery: never a silent drop — bump the durable
    -- duplicate audit counter and hand back the prior disposition reference.
    UPDATE public.inbound_processing_ledger
       SET duplicate_delivery_count = duplicate_delivery_count + 1,
           last_duplicate_at = v_now,
           updated_at = v_now
     WHERE id = v_row.id;
    RETURN jsonb_build_object(
      'ok', true, 'outcome', 'duplicate_completed',
      'ledger_id', v_row.id,
      'prior_disposition', v_row.terminal_disposition,
      'prior_completed_at', v_row.completed_at,
      'prior_processing_run_id', v_row.processing_run_id,
      'attempt_count', v_row.attempt_count,
      'duplicate_delivery_count', v_row.duplicate_delivery_count + 1);
  END IF;

  IF v_row.status = 'failed' AND v_row.terminal_disposition = 'failed_terminal' THEN
    UPDATE public.inbound_processing_ledger
       SET duplicate_delivery_count = duplicate_delivery_count + 1,
           last_duplicate_at = v_now,
           updated_at = v_now
     WHERE id = v_row.id;
    RETURN jsonb_build_object(
      'ok', true, 'outcome', 'terminally_failed',
      'ledger_id', v_row.id,
      'prior_disposition', v_row.terminal_disposition,
      'error_message', v_row.error_message,
      'attempt_count', v_row.attempt_count,
      'duplicate_delivery_count', v_row.duplicate_delivery_count + 1);
  END IF;

  IF v_row.status = 'processing'
     AND v_row.lease_expires_at IS NOT NULL
     AND v_row.lease_expires_at > v_now THEN
    RETURN jsonb_build_object(
      'ok', true, 'outcome', 'already_processing',
      'ledger_id', v_row.id,
      'holder_processing_run_id', v_row.processing_run_id,
      'lease_expires_at', v_row.lease_expires_at,
      'attempt_count', v_row.attempt_count);
  END IF;

  -- Reclaimable: processing with an expired (or legacy NULL) lease, or a
  -- retriable failure. Attempt exhaustion flips terminal instead of looping
  -- forever.
  IF v_row.attempt_count >= v_max_attempts THEN
    UPDATE public.inbound_processing_ledger
       SET status = 'failed',
           terminal_disposition = 'failed_terminal',
           error_message = COALESCE(v_row.error_message, 'attempts_exhausted'),
           disposition_detail = COALESCE(v_row.disposition_detail, '{}'::jsonb)
             || jsonb_build_object(
                  'attempts_exhausted', true,
                  'max_attempts', v_max_attempts),
           completed_at = v_now,
           lease_expires_at = NULL,
           updated_at = v_now
     WHERE id = v_row.id;
    RETURN jsonb_build_object(
      'ok', true, 'outcome', 'terminally_failed',
      'ledger_id', v_row.id,
      'reason', 'attempts_exhausted',
      'prior_disposition', 'failed_terminal',
      'attempt_count', v_row.attempt_count);
  END IF;

  UPDATE public.inbound_processing_ledger
     SET status = 'processing',
         attempt_count = v_row.attempt_count + 1,
         processing_run_id = v_run_id,
         claimed_at = v_now,
         lease_expires_at = v_now + make_interval(secs => v_lease_seconds),
         terminal_disposition = NULL,
         error_message = NULL,
         completed_at = NULL,
         updated_at = v_now
   WHERE id = v_row.id;

  RETURN jsonb_build_object(
    'ok', true, 'outcome', 'retry_claimed',
    'ledger_id', v_row.id,
    'processing_run_id', v_run_id,
    'attempt_count', v_row.attempt_count + 1,
    'previous_status', v_row.status,
    'previous_disposition', v_row.terminal_disposition,
    'lease_expires_at', v_now + make_interval(secs => v_lease_seconds));
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_inbound_processing(
  p_idempotency_key text,
  p_processing_run_id uuid,
  p_disposition text,
  p_detail jsonb DEFAULT '{}'::jsonb,
  p_detected_intent text DEFAULT NULL,
  p_classifier_version text DEFAULT NULL,
  p_confidence numeric DEFAULT NULL,
  p_latency_ms integer DEFAULT NULL,
  p_error_message text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_key text;
  v_now timestamptz := now();
  v_status text;
  v_count integer;
  v_row public.inbound_processing_ledger%ROWTYPE;
BEGIN
  v_key := trim(COALESCE(p_idempotency_key, ''));
  IF v_key = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'idempotency_key_required');
  END IF;
  IF p_processing_run_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'processing_run_id_required');
  END IF;
  IF p_disposition IS NULL OR p_disposition NOT IN (
    'reply_sent', 'reply_deferred_compliance', 'suppressed_opt_out',
    'suppressed_wrong_number', 'suppressed_policy', 'human_review_required',
    'duplicate_ignored', 'no_reply_required', 'failed_retriable',
    'failed_terminal'
  ) THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'invalid_terminal_disposition',
      'disposition', p_disposition);
  END IF;

  v_status := CASE
    WHEN p_disposition IN ('failed_retriable', 'failed_terminal') THEN 'failed'
    ELSE 'completed'
  END;

  -- Run-id fence: only the current claim holder may write the disposition.
  UPDATE public.inbound_processing_ledger
     SET status = v_status,
         terminal_disposition = p_disposition,
         disposition_detail = COALESCE(p_detail, '{}'::jsonb),
         detected_intent = COALESCE(p_detected_intent, detected_intent),
         classifier_version = COALESCE(p_classifier_version, classifier_version),
         confidence = COALESCE(p_confidence, confidence),
         latency_ms = COALESCE(p_latency_ms, latency_ms),
         error_message = p_error_message,
         completed_at = v_now,
         lease_expires_at = NULL,
         updated_at = v_now
   WHERE idempotency_key = v_key
     AND processing_run_id = p_processing_run_id
     AND status = 'processing';
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count = 1 THEN
    RETURN jsonb_build_object(
      'ok', true, 'disposition', p_disposition, 'status', v_status);
  END IF;

  -- Zero rows: distinguish "row missing" from "fenced out" so the caller can
  -- alert precisely. This read is diagnostic only; the write above is the
  -- single atomic decision.
  SELECT * INTO v_row
  FROM public.inbound_processing_ledger
  WHERE idempotency_key = v_key;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ledger_row_missing');
  END IF;

  RETURN jsonb_build_object(
    'ok', false,
    'reason', 'claim_fenced',
    'current_status', v_row.status,
    'current_disposition', v_row.terminal_disposition,
    'current_processing_run_id', v_row.processing_run_id);
END;
$$;

-- Containment posture (matches launch-containment addendum): these functions
-- are service-role plumbing, not client API surface.
REVOKE ALL ON FUNCTION public.claim_inbound_processing(text, text, text, text, text, text, integer, timestamptz, uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_inbound_processing(text, text, text, text, text, text, integer, timestamptz, uuid, integer, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_inbound_processing(text, text, text, text, text, text, integer, timestamptz, uuid, integer, integer) TO service_role;

REVOKE ALL ON FUNCTION public.complete_inbound_processing(text, uuid, text, jsonb, text, text, numeric, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_inbound_processing(text, uuid, text, jsonb, text, text, numeric, integer, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_inbound_processing(text, uuid, text, jsonb, text, text, numeric, integer, text) TO service_role;

COMMENT ON FUNCTION public.claim_inbound_processing(text, text, text, text, text, text, integer, timestamptz, uuid, integer, integer) IS
  'Atomic inbound idempotency claim: exactly one winner per idempotency key. Outcomes: claimed_new, retry_claimed, duplicate_completed, already_processing, terminally_failed, invalid_claim. Leases + run-id fencing; duplicate deliveries are counted, never silently dropped.';

COMMENT ON FUNCTION public.complete_inbound_processing(text, uuid, text, jsonb, text, text, numeric, integer, text) IS
  'Run-id-fenced terminal-disposition write for the inbound claim contract. A worker whose lease expired (row reclaimed, run id rotated) receives claim_fenced instead of overwriting the new holder.';
