-- ─────────────────────────────────────────────────────────────────────────────
-- Scoped-canary authorization deadlock fix.
--
-- DEFECT (observed in production 2026-07-31T22:04:29Z):
--   The route consumed the canary authorization BEFORE dispatch
--   (queue-run-request.js), then runScopedCampaignCanary reached
--   queue_atomic_claim_send_row, which rejected that very authorization
--   because consumed_at was already non-null:
--     excluded=[{"reason":"authorization_already_consumed"}], dispatched=[],
--     sent_count=0, and the queue row was left unlocked and unsent.
--   Every scoped canary execution was therefore impossible.
--
-- FIX (this migration + removal of the route-level pre-consumption):
--   The authorization is consumed exactly once, inside the same atomic
--   statement that successfully claims an authorized row. The authorization
--   row is already held FOR UPDATE by this function before any claim is
--   attempted, so competing executions serialize on it: the winner claims and
--   consumes, the loser observes consumed_at and is denied.
--
--   * validate_only / dry_run never reach this function, so they never consume.
--   * A failed preclaim returns before the claim UPDATE, so no row is claimed
--     and the authorization is left unconsumed and reusable.
--   * A multi-row manifest (SCOPED_CANARY_MAX_ROWS = 5) is consumed only once
--     its whole manifest has been claimed; claimed_row_ids tracks progress so
--     rows 2..N are not locked out by row 1's claim.
--   * An authorization that has claimed its full manifest can never be reused.
--
-- Only the scoped-canary branch changes. The unrestricted claim path, the
-- execution-mode gates, the emergency stop, the global execution lock, and
-- every existing denial reason are untouched.
-- ─────────────────────────────────────────────────────────────────────────────

-- Progress ledger for partially-claimed manifests. Additive; existing rows
-- default to an empty array, which is exactly "nothing claimed yet".
ALTER TABLE public.queue_canary_authorizations
  ADD COLUMN IF NOT EXISTS claimed_row_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE OR REPLACE FUNCTION public.queue_atomic_claim_send_row(
  p_queue_row_id uuid,
  p_claim_mode text,
  p_processing_run_id uuid DEFAULT NULL,
  p_canary_run_id text DEFAULT NULL,
  p_authorization_token_hash text DEFAULT NULL,
  p_campaign_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_mode text;
  v_emergency boolean;
  v_processor text;
  v_lock_owner text;
  v_lock_canary text;
  v_row public.send_queue%ROWTYPE;
  v_claim_token uuid;
  v_claimed_at timestamptz := now();
  v_auth public.queue_canary_authorizations%ROWTYPE;
  v_allowed_ids text[];
  v_block_reason text;
  v_processing_run_id uuid;
  v_claim_mode text;
  v_claimed_ids text[];
  v_manifest_count integer;
  v_auth_consumed_at timestamptz;
BEGIN
  v_claim_mode := lower(trim(COALESCE(p_claim_mode, 'normal')));
  v_processing_run_id := COALESCE(p_processing_run_id, gen_random_uuid());
  v_mode := public.queue_execution_mode_normalized();
  v_emergency := public.queue_emergency_stop_active();
  v_processor := public.queue_processor_mode_normalized();

  SELECT owner_type, canary_run_id
    INTO v_lock_owner, v_lock_canary
  FROM public.queue_global_execution_lock
  WHERE id = 1;

  IF p_queue_row_id IS NULL THEN
    v_block_reason := 'missing_queue_row_id';
    PERFORM public.queue_write_claim_audit(p_queue_row_id, v_claim_mode, v_processing_run_id, p_canary_run_id, false, v_block_reason, NULL);
    RETURN jsonb_build_object('ok', false, 'claimed', false, 'reason', v_block_reason);
  END IF;

  SELECT * INTO v_row
  FROM public.send_queue
  WHERE id = p_queue_row_id
  FOR UPDATE;

  IF NOT FOUND THEN
    v_block_reason := 'queue_row_not_found';
    PERFORM public.queue_write_claim_audit(p_queue_row_id, v_claim_mode, v_processing_run_id, p_canary_run_id, false, v_block_reason, NULL);
    RETURN jsonb_build_object('ok', false, 'claimed', false, 'reason', v_block_reason);
  END IF;

  IF COALESCE(v_row.metadata->>'production_incident', 'false') = 'true'
     OR COALESCE(v_row.metadata->>'suppress_automatic_follow_up', 'false') = 'true' THEN
    v_block_reason := 'incident_row_suppressed';
    PERFORM public.queue_write_claim_audit(p_queue_row_id, v_claim_mode, v_processing_run_id, p_canary_run_id, false, v_block_reason, NULL);
    RETURN jsonb_build_object('ok', false, 'claimed', false, 'reason', v_block_reason, 'queue_row_id', p_queue_row_id);
  END IF;

  IF lower(COALESCE(v_row.queue_status, '')) IN (
    'sent', 'delivered', 'processing', 'cancelled', 'canceled', 'failed', 'expired',
    'duplicate_blocked', 'suppressed', 'blocked'
  ) OR v_row.lock_token IS NOT NULL OR COALESCE(v_row.is_locked, false) = true THEN
    v_block_reason := 'queue_row_not_claimable';
    PERFORM public.queue_write_claim_audit(p_queue_row_id, v_claim_mode, v_processing_run_id, p_canary_run_id, false, v_block_reason, NULL);
    RETURN jsonb_build_object('ok', false, 'claimed', false, 'reason', v_block_reason, 'queue_row_id', p_queue_row_id);
  END IF;

  IF v_claim_mode = 'scoped_canary' THEN
    IF v_mode <> 'scoped_canary_only' THEN
      v_block_reason := 'queue_execution_mode_not_scoped_canary_only';
      PERFORM public.queue_write_claim_audit(p_queue_row_id, v_claim_mode, v_processing_run_id, p_canary_run_id, false, v_block_reason, NULL);
      RETURN jsonb_build_object('ok', false, 'claimed', false, 'reason', v_block_reason);
    END IF;
    IF v_lock_owner IS DISTINCT FROM 'scoped_canary' OR v_lock_canary IS DISTINCT FROM p_canary_run_id THEN
      v_block_reason := 'scoped_canary_execution_lock_mismatch';
      PERFORM public.queue_write_claim_audit(p_queue_row_id, v_claim_mode, v_processing_run_id, p_canary_run_id, false, v_block_reason, NULL);
      RETURN jsonb_build_object('ok', false, 'claimed', false, 'reason', v_block_reason);
    END IF;
    IF p_canary_run_id IS NULL OR p_authorization_token_hash IS NULL OR p_campaign_id IS NULL THEN
      v_block_reason := 'scoped_canary_authorization_missing';
      PERFORM public.queue_write_claim_audit(p_queue_row_id, v_claim_mode, v_processing_run_id, p_canary_run_id, false, v_block_reason, NULL);
      RETURN jsonb_build_object('ok', false, 'claimed', false, 'reason', v_block_reason);
    END IF;
    -- FOR UPDATE: competing executions of the same authorization serialize
    -- here and stay serialized until this transaction commits or rolls back.
    SELECT * INTO v_auth
    FROM public.queue_canary_authorizations
    WHERE canary_run_id = p_canary_run_id
    FOR UPDATE;
    IF NOT FOUND THEN
      v_block_reason := 'authorization_not_found';
      PERFORM public.queue_write_claim_audit(p_queue_row_id, v_claim_mode, v_processing_run_id, p_canary_run_id, false, v_block_reason, NULL);
      RETURN jsonb_build_object('ok', false, 'claimed', false, 'reason', v_block_reason);
    END IF;
    IF v_auth.authorization_token_hash <> p_authorization_token_hash THEN
      v_block_reason := 'authorization_token_invalid';
      PERFORM public.queue_write_claim_audit(p_queue_row_id, v_claim_mode, v_processing_run_id, p_canary_run_id, false, v_block_reason, NULL);
      RETURN jsonb_build_object('ok', false, 'claimed', false, 'reason', v_block_reason);
    END IF;
    IF v_auth.consumed_at IS NOT NULL THEN
      v_block_reason := 'authorization_already_consumed';
      PERFORM public.queue_write_claim_audit(p_queue_row_id, v_claim_mode, v_processing_run_id, p_canary_run_id, false, v_block_reason, NULL);
      RETURN jsonb_build_object('ok', false, 'claimed', false, 'reason', v_block_reason);
    END IF;
    IF v_auth.expires_at <= now() THEN
      v_block_reason := 'authorization_expired';
      PERFORM public.queue_write_claim_audit(p_queue_row_id, v_claim_mode, v_processing_run_id, p_canary_run_id, false, v_block_reason, NULL);
      RETURN jsonb_build_object('ok', false, 'claimed', false, 'reason', v_block_reason);
    END IF;
    IF v_auth.campaign_id IS DISTINCT FROM p_campaign_id THEN
      v_block_reason := 'authorization_campaign_mismatch';
      PERFORM public.queue_write_claim_audit(p_queue_row_id, v_claim_mode, v_processing_run_id, p_canary_run_id, false, v_block_reason, NULL);
      RETURN jsonb_build_object('ok', false, 'claimed', false, 'reason', v_block_reason);
    END IF;
    SELECT array_agg(value::text ORDER BY value::text)
      INTO v_allowed_ids
    FROM jsonb_array_elements_text(v_auth.queue_row_ids);
    IF v_allowed_ids IS NULL OR NOT (p_queue_row_id::text = ANY (v_allowed_ids)) THEN
      v_block_reason := 'authorization_row_not_allowlisted';
      PERFORM public.queue_write_claim_audit(p_queue_row_id, v_claim_mode, v_processing_run_id, p_canary_run_id, false, v_block_reason, NULL);
      RETURN jsonb_build_object('ok', false, 'claimed', false, 'reason', v_block_reason);
    END IF;
    -- A row already claimed under this authorization cannot be claimed again,
    -- even while the manifest as a whole is still open.
    SELECT COALESCE(array_agg(value::text ORDER BY value::text), ARRAY[]::text[])
      INTO v_claimed_ids
    FROM jsonb_array_elements_text(COALESCE(v_auth.claimed_row_ids, '[]'::jsonb));
    IF p_queue_row_id::text = ANY (v_claimed_ids) THEN
      v_block_reason := 'authorization_row_already_claimed';
      PERFORM public.queue_write_claim_audit(p_queue_row_id, v_claim_mode, v_processing_run_id, p_canary_run_id, false, v_block_reason, NULL);
      RETURN jsonb_build_object('ok', false, 'claimed', false, 'reason', v_block_reason);
    END IF;
    IF v_row.campaign_id IS DISTINCT FROM p_campaign_id THEN
      v_block_reason := 'scoped_canary_wrong_campaign_row';
      PERFORM public.queue_write_claim_audit(p_queue_row_id, v_claim_mode, v_processing_run_id, p_canary_run_id, false, v_block_reason, NULL);
      RETURN jsonb_build_object('ok', false, 'claimed', false, 'reason', v_block_reason);
    END IF;
  ELSE
    -- Normal unrestricted claim path: fail closed unless explicitly normal and brakes permit.
    IF v_mode <> 'normal' THEN
      v_block_reason := CASE v_mode
        WHEN 'stopped' THEN 'queue_execution_mode_stopped'
        WHEN 'scoped_canary_only' THEN 'queue_execution_mode_scoped_canary_only'
        ELSE 'queue_execution_mode_blocked'
      END;
      PERFORM public.queue_write_claim_audit(p_queue_row_id, v_claim_mode, v_processing_run_id, p_canary_run_id, false, v_block_reason, NULL);
      RETURN jsonb_build_object('ok', false, 'claimed', false, 'reason', v_block_reason, 'queue_execution_mode', v_mode);
    END IF;
    IF v_emergency THEN
      v_block_reason := 'queue_emergency_stop_active';
      PERFORM public.queue_write_claim_audit(p_queue_row_id, v_claim_mode, v_processing_run_id, p_canary_run_id, false, v_block_reason, NULL);
      RETURN jsonb_build_object('ok', false, 'claimed', false, 'reason', v_block_reason);
    END IF;
    IF v_processor = 'off' THEN
      v_block_reason := 'queue_processor_paused';
      PERFORM public.queue_write_claim_audit(p_queue_row_id, v_claim_mode, v_processing_run_id, p_canary_run_id, false, v_block_reason, NULL);
      RETURN jsonb_build_object('ok', false, 'claimed', false, 'reason', v_block_reason);
    END IF;
    IF v_lock_owner IS NOT NULL AND v_lock_owner <> 'unrestricted' THEN
      v_block_reason := 'global_execution_lock_held';
      PERFORM public.queue_write_claim_audit(p_queue_row_id, v_claim_mode, v_processing_run_id, p_canary_run_id, false, v_block_reason, NULL);
      RETURN jsonb_build_object('ok', false, 'claimed', false, 'reason', v_block_reason);
    END IF;
  END IF;

  v_claim_token := gen_random_uuid();

  UPDATE public.send_queue
  SET
    queue_status = 'processing',
    is_locked = true,
    locked_at = v_claimed_at,
    lock_token = v_claim_token,
    updated_at = v_claimed_at,
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'processing_run_id', v_processing_run_id::text,
      'run_started_at', v_claimed_at,
      'processing_started_at', v_claimed_at,
      'processing_worker_id', v_processing_run_id::text,
      'processing_timeout_at', (v_claimed_at + interval '10 minutes')::text,
      'claimed_at', COALESCE(metadata->>'claimed_at', v_claimed_at::text),
      'claimed_by', CASE WHEN v_claim_mode = 'scoped_canary' THEN 'scoped_canary' ELSE 'queue_runner' END,
      'claim_authorization_token', v_claim_token::text,
      'claim_mode', v_claim_mode,
      'scoped_canary', v_claim_mode = 'scoped_canary',
      'canary_run_id', p_canary_run_id
    )
  WHERE id = p_queue_row_id
    AND lock_token IS NULL
    AND lower(queue_status) IN ('queued', 'scheduled', 'pending', 'approved', 'ready')
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    v_block_reason := 'queue_item_claim_conflict';
    PERFORM public.queue_write_claim_audit(p_queue_row_id, v_claim_mode, v_processing_run_id, p_canary_run_id, false, v_block_reason, NULL);
    RETURN jsonb_build_object('ok', false, 'claimed', false, 'reason', v_block_reason, 'queue_row_id', p_queue_row_id);
  END IF;

  -- The claim succeeded. Consume the authorization in this same transaction so
  -- that claiming and consuming are one atomic act: nothing can observe a
  -- claimed row whose authorization is still spendable, and nothing can spend
  -- an authorization that did not claim.
  IF v_claim_mode = 'scoped_canary' THEN
    v_claimed_ids := v_claimed_ids || p_queue_row_id::text;
    v_manifest_count := COALESCE(array_length(v_allowed_ids, 1), 0);

    IF COALESCE(array_length(v_claimed_ids, 1), 0) >= v_manifest_count THEN
      v_auth_consumed_at := v_claimed_at;
    ELSE
      v_auth_consumed_at := NULL;
    END IF;

    UPDATE public.queue_canary_authorizations
    SET
      claimed_row_ids = to_jsonb(v_claimed_ids),
      consumed_at = v_auth_consumed_at
    WHERE id = v_auth.id;
  END IF;

  PERFORM public.queue_write_claim_audit(
    p_queue_row_id,
    v_claim_mode,
    v_processing_run_id,
    p_canary_run_id,
    true,
    NULL,
    v_claim_token,
    jsonb_build_object(
      'queue_status', v_row.queue_status,
      'authorization_consumed_at', v_auth_consumed_at
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'claimed', true,
    'reason', 'claimed',
    'queue_row_id', p_queue_row_id,
    'claim_token', v_claim_token,
    'lock_token', v_claim_token,
    'claimed_at', v_claimed_at,
    'processing_run_id', v_processing_run_id,
    'authorization_consumed_at', v_auth_consumed_at,
    'row', to_jsonb(v_row)
  );
END;
$$;
