-- Fix queue_verify_dispatch_authorization lock_token type comparison (text vs uuid).

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
  v_claim_token_text text;
BEGIN
  IF p_queue_row_id IS NULL OR p_claim_token IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_dispatch_authorization');
  END IF;

  v_claim_token_text := p_claim_token::text;
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

  IF COALESCE(v_row.lock_token::text, '') IS DISTINCT FROM v_claim_token_text
     OR COALESCE(v_row.metadata->>'claim_authorization_token', '') IS DISTINCT FROM v_claim_token_text THEN
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