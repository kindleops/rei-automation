-- Severity-1 containment: database-atomic send_queue claim with fail-closed brakes.
-- Authorization decisions occur inside the claim transaction, not in application caches.

CREATE TABLE IF NOT EXISTS public.queue_claim_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_row_id uuid NOT NULL,
  claim_mode text NOT NULL,
  processing_run_id uuid,
  canary_run_id text,
  ok boolean NOT NULL DEFAULT false,
  block_reason text,
  queue_execution_mode text,
  emergency_stop_active boolean,
  processor_mode text,
  global_lock_owner text,
  claim_token uuid,
  audit_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS queue_claim_audit_row_idx
  ON public.queue_claim_audit (queue_row_id, created_at DESC);

CREATE INDEX IF NOT EXISTS queue_claim_audit_run_idx
  ON public.queue_claim_audit (processing_run_id)
  WHERE processing_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.queue_scheduled_for_mutation_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_row_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  previous_scheduled_for jsonb NOT NULL DEFAULT '{}'::jsonb,
  new_scheduled_for timestamptz,
  operator_reason text,
  ok boolean NOT NULL DEFAULT false,
  block_reason text,
  audit_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.queue_system_control_text(p_key text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(trim(value), '')
  FROM public.system_control
  WHERE key = p_key
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.queue_emergency_stop_active()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN public.queue_system_control_text('queue_emergency_stop_at') IS NULL THEN false
    WHEN lower(public.queue_system_control_text('queue_emergency_stop_at')) IN (
      '0', 'false', 'off', 'none', 'null', 'cleared', 'clear'
    ) THEN false
    ELSE true
  END;
$$;

CREATE OR REPLACE FUNCTION public.queue_execution_mode_normalized()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE lower(COALESCE(public.queue_system_control_text('queue_execution_mode'), 'stopped'))
    WHEN 'normal' THEN 'normal'
    WHEN 'scoped_canary_only' THEN 'scoped_canary_only'
    ELSE 'stopped'
  END;
$$;

CREATE OR REPLACE FUNCTION public.queue_processor_mode_normalized()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE lower(COALESCE(public.queue_system_control_text('queue_processor_mode'), 'off'))
    WHEN 'live' THEN 'live'
    WHEN 'safe' THEN 'safe'
    ELSE 'off'
  END;
$$;

CREATE OR REPLACE FUNCTION public.queue_write_claim_audit(
  p_queue_row_id uuid,
  p_claim_mode text,
  p_processing_run_id uuid,
  p_canary_run_id text,
  p_ok boolean,
  p_block_reason text,
  p_claim_token uuid,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.queue_claim_audit (
    queue_row_id,
    claim_mode,
    processing_run_id,
    canary_run_id,
    ok,
    block_reason,
    queue_execution_mode,
    emergency_stop_active,
    processor_mode,
    global_lock_owner,
    claim_token,
    audit_payload
  ) VALUES (
    p_queue_row_id,
    p_claim_mode,
    p_processing_run_id,
    p_canary_run_id,
    p_ok,
    p_block_reason,
    public.queue_execution_mode_normalized(),
    public.queue_emergency_stop_active(),
    public.queue_processor_mode_normalized(),
    (SELECT owner_type FROM public.queue_global_execution_lock WHERE id = 1),
    p_claim_token,
    COALESCE(p_payload, '{}'::jsonb)
  );
END;
$$;

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

  PERFORM public.queue_write_claim_audit(
    p_queue_row_id,
    v_claim_mode,
    v_processing_run_id,
    p_canary_run_id,
    true,
    NULL,
    v_claim_token,
    jsonb_build_object('queue_status', v_row.queue_status)
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
    'row', to_jsonb(v_row)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.queue_verify_dispatch_authorization(
  p_queue_row_id uuid,
  p_claim_token uuid
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_mode text;
  v_emergency boolean;
  v_processor text;
  v_row public.send_queue%ROWTYPE;
  v_claim_mode text;
  v_block_reason text;
BEGIN
  IF p_queue_row_id IS NULL OR p_claim_token IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_dispatch_authorization');
  END IF;

  v_mode := public.queue_execution_mode_normalized();
  v_emergency := public.queue_emergency_stop_active();
  v_processor := public.queue_processor_mode_normalized();

  SELECT * INTO v_row
  FROM public.send_queue
  WHERE id = p_queue_row_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'queue_row_not_found');
  END IF;

  v_claim_mode := lower(COALESCE(v_row.metadata->>'claim_mode', 'normal'));

  IF v_row.lock_token IS DISTINCT FROM p_claim_token
     OR COALESCE(v_row.metadata->>'claim_authorization_token', '') <> p_claim_token::text THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'claim_token_mismatch');
  END IF;

  IF lower(COALESCE(v_row.queue_status, '')) <> 'processing' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'queue_row_not_processing');
  END IF;

  IF v_claim_mode = 'scoped_canary' THEN
    IF v_mode <> 'scoped_canary_only' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'queue_execution_mode_not_scoped_canary_only');
    END IF;
  ELSE
    IF v_mode <> 'normal' THEN
      v_block_reason := CASE v_mode
        WHEN 'stopped' THEN 'queue_execution_mode_stopped'
        WHEN 'scoped_canary_only' THEN 'queue_execution_mode_scoped_canary_only'
        ELSE 'queue_execution_mode_blocked'
      END;
      RETURN jsonb_build_object('ok', false, 'reason', v_block_reason);
    END IF;
    IF v_emergency THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'queue_emergency_stop_active');
    END IF;
    IF v_processor = 'off' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'queue_processor_paused');
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'reason', 'dispatch_authorized', 'claim_mode', v_claim_mode);
END;
$$;

CREATE OR REPLACE FUNCTION public.queue_guarded_mutate_scheduled_for(
  p_row_ids uuid[],
  p_scheduled_for timestamptz,
  p_operator_reason text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_mode text;
  v_lock_owner text;
  v_row public.send_queue%ROWTYPE;
  v_previous jsonb := '{}'::jsonb;
  v_updated_ids uuid[] := ARRAY[]::uuid[];
  v_id uuid;
  v_block_reason text;
BEGIN
  IF p_row_ids IS NULL OR array_length(p_row_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'row_ids_required');
  END IF;

  v_mode := public.queue_execution_mode_normalized();
  IF v_mode <> 'stopped' THEN
    v_block_reason := 'execution_mode_must_be_stopped';
    INSERT INTO public.queue_scheduled_for_mutation_audit (
      queue_row_ids, previous_scheduled_for, new_scheduled_for, operator_reason, ok, block_reason, audit_payload
    ) VALUES (
      to_jsonb(p_row_ids), '{}'::jsonb, p_scheduled_for, p_operator_reason, false, v_block_reason, COALESCE(p_metadata, '{}'::jsonb)
    );
    RETURN jsonb_build_object('ok', false, 'reason', v_block_reason);
  END IF;

  SELECT owner_type INTO v_lock_owner FROM public.queue_global_execution_lock WHERE id = 1;
  IF v_lock_owner IS NOT NULL THEN
    v_block_reason := 'global_execution_lock_active';
    INSERT INTO public.queue_scheduled_for_mutation_audit (
      queue_row_ids, previous_scheduled_for, new_scheduled_for, operator_reason, ok, block_reason, audit_payload
    ) VALUES (
      to_jsonb(p_row_ids), '{}'::jsonb, p_scheduled_for, p_operator_reason, false, v_block_reason, COALESCE(p_metadata, '{}'::jsonb)
    );
    RETURN jsonb_build_object('ok', false, 'reason', v_block_reason);
  END IF;

  FOREACH v_id IN ARRAY p_row_ids LOOP
    SELECT * INTO v_row FROM public.send_queue WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      v_block_reason := 'queue_row_not_found';
      INSERT INTO public.queue_scheduled_for_mutation_audit (
        queue_row_ids, previous_scheduled_for, new_scheduled_for, operator_reason, ok, block_reason, audit_payload
      ) VALUES (
        to_jsonb(p_row_ids), v_previous, p_scheduled_for, p_operator_reason, false, v_block_reason,
        COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('missing_row_id', v_id)
      );
      RETURN jsonb_build_object('ok', false, 'reason', v_block_reason, 'queue_row_id', v_id);
    END IF;

    IF lower(COALESCE(v_row.queue_status, '')) IN ('processing', 'sent', 'delivered')
       OR v_row.lock_token IS NOT NULL
       OR COALESCE(v_row.is_locked, false) = true THEN
      v_block_reason := 'queue_row_not_mutable';
      INSERT INTO public.queue_scheduled_for_mutation_audit (
        queue_row_ids, previous_scheduled_for, new_scheduled_for, operator_reason, ok, block_reason, audit_payload
      ) VALUES (
        to_jsonb(p_row_ids), v_previous, p_scheduled_for, p_operator_reason, false, v_block_reason,
        COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('blocked_row_id', v_id, 'queue_status', v_row.queue_status)
      );
      RETURN jsonb_build_object('ok', false, 'reason', v_block_reason, 'queue_row_id', v_id);
    END IF;

    v_previous := v_previous || jsonb_build_object(v_id::text, COALESCE(v_row.scheduled_for, v_row.scheduled_for_utc));

    UPDATE public.send_queue
    SET
      scheduled_for = p_scheduled_for,
      scheduled_for_utc = p_scheduled_for,
      scheduled_for_local = p_scheduled_for,
      updated_at = now(),
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'scheduled_for_mutated_at', now(),
        'scheduled_for_mutation_reason', p_operator_reason
      )
    WHERE id = v_id;

    v_updated_ids := array_append(v_updated_ids, v_id);
  END LOOP;

  INSERT INTO public.queue_scheduled_for_mutation_audit (
    queue_row_ids, previous_scheduled_for, new_scheduled_for, operator_reason, ok, block_reason, audit_payload
  ) VALUES (
    to_jsonb(v_updated_ids), v_previous, p_scheduled_for, p_operator_reason, true, NULL,
    COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('updated_count', array_length(v_updated_ids, 1))
  );

  RETURN jsonb_build_object(
    'ok', true,
    'updated_ids', to_jsonb(v_updated_ids),
    'scheduled_for', p_scheduled_for
  );
END;
$$;