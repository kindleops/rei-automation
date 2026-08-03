-- ─────────────────────────────────────────────────────────────────────────────
-- Internal-proof stamp: atomic server-side jsonb merge for the runbook's
-- stamp-reply step.
--
-- RACE THIS CLOSES (scripts/ops/internal-proof-runbook.mjs, previous
-- stamp-reply implementation): the step read the reply row's metadata,
-- merged the stamp keys in JS ("metadata: { ...(reply.metadata || {}),
-- internal_canary: true, ... }"), and wrote the WHOLE object back guarded
-- only by ".eq('queue_status', observed_status)". Any concurrent writer that
-- mutated send_queue.metadata WITHOUT changing queue_status (delivery
-- reconcile's textGridFailureMetadata merge, the inbound automation queue
-- patch, the contact_window_bypass audit stamp) was silently clobbered by
-- the stale snapshot. PostgREST cannot express "metadata = metadata || $1"
-- — every update sends a whole replacement value — so the merge must happen
-- server-side in one atomic UPDATE.
--
-- DELIBERATELY NOT a general metadata writer:
--   * targets exactly one send_queue row by primary key;
--   * requires the caller's observed queue_status to still hold (CAS);
--   * requires the campaign state the caller observed (NULL means the row
--     must still be campaign-less; the pinned campaign itself is accepted so
--     a re-run of an already-stamped row stays idempotent);
--   * accepts ONLY the five internal-proof stamp contract keys — any other
--     key in p_stamp rejects the whole call with stamp_key_not_allowed and
--     writes nothing;
--   * records the internal-proof session and processing run inside the stamp.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.internal_proof_stamp_queue_row(
  p_queue_row_id uuid,
  p_expected_status text,
  p_expected_campaign_id uuid,
  p_campaign_id uuid,
  p_stamp jsonb DEFAULT '{}'::jsonb,
  p_proof_session_id text DEFAULT NULL,
  p_processing_run_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  -- The full internal-proof stamp contract. Hard-coded on purpose: widening
  -- this list is a migration-reviewed change, never a caller decision.
  v_allowed_keys constant text[] := ARRAY[
    'internal_canary',
    'campaign_id_stamped_for_internal_proof',
    'campaign_stamped_at',
    'internal_proof_session_id',
    'internal_proof_processing_run_id'
  ];
  v_disallowed text[];
  v_stamp jsonb;
  v_expected_status text;
  v_count integer;
  v_row_id uuid;
  v_row_status text;
  v_row_campaign uuid;
  v_row_metadata jsonb;
  v_cur_status text;
  v_cur_campaign uuid;
BEGIN
  v_expected_status := NULLIF(trim(COALESCE(p_expected_status, '')), '');
  IF p_queue_row_id IS NULL OR p_campaign_id IS NULL OR v_expected_status IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_arguments');
  END IF;

  v_disallowed := ARRAY(
    SELECT key
    FROM jsonb_object_keys(COALESCE(p_stamp, '{}'::jsonb)) AS keys(key)
    WHERE key <> ALL (v_allowed_keys)
  );
  IF COALESCE(array_length(v_disallowed, 1), 0) > 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'stamp_key_not_allowed',
      'disallowed_keys', to_jsonb(v_disallowed));
  END IF;

  v_stamp := COALESCE(p_stamp, '{}'::jsonb);
  IF NULLIF(trim(COALESCE(p_proof_session_id, '')), '') IS NOT NULL THEN
    v_stamp := v_stamp
      || jsonb_build_object('internal_proof_session_id', trim(p_proof_session_id));
  END IF;
  IF NULLIF(trim(COALESCE(p_processing_run_id, '')), '') IS NOT NULL THEN
    v_stamp := v_stamp
      || jsonb_build_object('internal_proof_processing_run_id', trim(p_processing_run_id));
  END IF;
  IF v_stamp = '{}'::jsonb THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty_stamp');
  END IF;

  -- One atomic statement: CAS on the observed queue_status + campaign state,
  -- server-side jsonb merge that leaves every unrelated metadata key alone.
  UPDATE public.send_queue
     SET campaign_id = p_campaign_id,
         metadata = COALESCE(metadata, '{}'::jsonb) || v_stamp
   WHERE id = p_queue_row_id
     AND queue_status = v_expected_status
     AND (
       (p_expected_campaign_id IS NULL AND campaign_id IS NULL)
       OR campaign_id = p_expected_campaign_id
       OR campaign_id = p_campaign_id
     )
  RETURNING id, queue_status, campaign_id, metadata
    INTO v_row_id, v_row_status, v_row_campaign, v_row_metadata;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count > 1 THEN
    -- Impossible for a primary-key predicate; if it ever fires the schema
    -- changed underneath this function and nothing about the write can be
    -- trusted.
    RAISE EXCEPTION
      'internal_proof_stamp_queue_row matched % rows for primary-key target %',
      v_count, p_queue_row_id;
  END IF;

  IF v_count = 1 THEN
    RETURN jsonb_build_object(
      'ok', true,
      'row', jsonb_build_object(
        'id', v_row_id,
        'queue_status', v_row_status,
        'campaign_id', v_row_campaign,
        'metadata', v_row_metadata));
  END IF;

  -- Zero rows: diagnostic read so the operator sees WHY (row gone vs
  -- transitioned vs foreign campaign). The read is informational only — the
  -- atomic UPDATE above is the single decision point.
  SELECT queue_status, campaign_id
    INTO v_cur_status, v_cur_campaign
  FROM public.send_queue
  WHERE id = p_queue_row_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'row_not_found');
  END IF;

  RETURN jsonb_build_object(
    'ok', false,
    'reason', 'row_not_in_expected_state',
    'current_status', v_cur_status,
    'current_campaign_id', v_cur_campaign);
END;
$$;

-- Containment posture (matches the inbound claim contract): service-role
-- plumbing only, never client API surface.
REVOKE ALL ON FUNCTION public.internal_proof_stamp_queue_row(uuid, text, uuid, uuid, jsonb, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.internal_proof_stamp_queue_row(uuid, text, uuid, uuid, jsonb, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.internal_proof_stamp_queue_row(uuid, text, uuid, uuid, jsonb, text, text) TO service_role;

COMMENT ON FUNCTION public.internal_proof_stamp_queue_row(uuid, text, uuid, uuid, jsonb, text, text) IS
  'Atomic internal-proof stamp for one exact send_queue row: CAS on observed queue_status + campaign state, server-side jsonb merge restricted to the five internal-proof stamp contract keys. Closes the runbook stamp-reply read-modify-write race; not reusable as a general metadata writer.';
