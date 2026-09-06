-- Scoped canary: permit an exact-row authorization for a NULL-campaign queue row.
--
-- WHY THIS IS A ONE-PREDICATE CHANGE
-- queue_atomic_claim_send_row already performs NULL-safe symmetric campaign
-- matching in BOTH directions:
--     IF v_auth.campaign_id IS DISTINCT FROM p_campaign_id THEN  -> deny
--     IF v_row.campaign_id  IS DISTINCT FROM p_campaign_id THEN  -> deny
-- IS DISTINCT FROM is already the nullable semantics we want, so a NULL
-- authorization can only ever match a NULL request and a NULL row, and a
-- campaign authorization can only ever match that same campaign. The ONLY
-- thing preventing an exact-row canary on an ordinary seller row was an
-- up-front rejection of a NULL p_campaign_id:
--
--   OLD: IF p_canary_run_id IS NULL OR p_authorization_token_hash IS NULL
--          OR p_campaign_id IS NULL THEN -> scoped_canary_authorization_missing
--   NEW: IF p_canary_run_id IS NULL OR p_authorization_token_hash IS NULL
--          THEN -> scoped_canary_authorization_missing
--
-- Nothing else changes. The run id and token remain mandatory; expiry,
-- one-time consumption, execution mode, lock ownership, the queue_row_ids
-- allowlist and runnable-status checks are all untouched, as is the entire
-- unrestricted claim path (including its queue_processor_mode='off' denial).
--
-- The function body is rewritten from pg_get_functiondef() with a single
-- textual substitution rather than retyped, so no other line can drift.

DO $migration$
DECLARE
  v_def      text;
  v_new_def  text;
  v_old_pred constant text :=
    'IF p_canary_run_id IS NULL OR p_authorization_token_hash IS NULL OR p_campaign_id IS NULL THEN';
  v_new_pred constant text :=
    'IF p_canary_run_id IS NULL OR p_authorization_token_hash IS NULL THEN';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'queue_atomic_claim_send_row';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'queue_atomic_claim_send_row not found';
  END IF;

  -- Drift guard: refuse to patch a body that is not the one this migration
  -- was written against.
  IF position(v_old_pred IN v_def) = 0 THEN
    IF position(v_new_pred IN v_def) > 0 THEN
      RAISE NOTICE 'already applied; nothing to do';
      RETURN;
    END IF;
    RAISE EXCEPTION 'expected scoped-canary predicate not found; refusing to patch';
  END IF;

  -- Exactly one occurrence, or the assumption is wrong.
  IF (length(v_def) - length(replace(v_def, v_old_pred, ''))) / length(v_old_pred) <> 1 THEN
    RAISE EXCEPTION 'expected exactly one occurrence of the scoped-canary predicate';
  END IF;

  v_new_def := replace(v_def, v_old_pred, v_new_pred);

  -- Both symmetric campaign guards must survive the rewrite.
  IF position('v_auth.campaign_id IS DISTINCT FROM p_campaign_id' IN v_new_def) = 0
     OR position('v_row.campaign_id IS DISTINCT FROM p_campaign_id' IN v_new_def) = 0 THEN
    RAISE EXCEPTION 'campaign symmetry guards missing after rewrite; aborting';
  END IF;

  -- The allowlist and the unrestricted processor denial must survive too.
  IF position('authorization_row_not_allowlisted' IN v_new_def) = 0
     OR position('v_processor = ''off''' IN v_new_def) = 0 THEN
    RAISE EXCEPTION 'safety checks missing after rewrite; aborting';
  END IF;

  EXECUTE v_new_def;
END
$migration$;
