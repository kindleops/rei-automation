-- ─── PROPOSED_activate.sql ──────────────────────────────────────────────────────────────────
-- PROPOSED. NOT EXECUTED. A SEPARATE production write with its OWN authorization. Approving the
-- wording did not authorize activation (owner, 2026-10-23).
--
-- Turns ON the one row PROPOSED_insert.sql wrote (lc-s2-consider-com-en-01). Nothing else changes.
--
-- Preconditions (each one RAISEs):
--   A. the row exists, is inactive, was written by PROPOSED_insert.sql, and its body uses only the
--      verified tokens (seller_first_name, sender_name, property_address). No {{first_name}} and no
--      {{company_name}}.
--   B. the queue processor runs the template-scope hotfix build, NOT 6ff4a24a. On 6ff4a24a a
--      commercial "Yes" whose property id was lost upstream never reaches the asset rule, and the
--      legacy scope filter vetoes commercial rows (the 2026-10-22 defect). The owner types the
--      deployed candidate SHA from DEPLOY.md into v_expected_build_sha. It must equal
--      system_control.queue_processor_last_build_sha.
--   C. ranking exposure. When a reply's property cannot be recovered at all (no id on the inbound,
--      its message_events row, the thread context or any delivered outbound) AND the context
--      carries no scope label, the legacy filter admits every row. The highest-ranked row then wins:
--      success_rate, then usage_count, then updated_at. This row has neither metric, so it ranks
--      below any residential-admitting S2 row that has one. If no such row has a metric, this row
--      (newest updated_at) would rank FIRST on those unknown-property threads. A known residential
--      property never gets it: the asset rule refuses it, which the tests prove. The file refuses
--      in that case unless the owner sets v_accept_unknown_property_ranking := true.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $activate$
DECLARE
  -- ── OWNER INPUT ─────────────────────────────────────────────────────────────────────────
  v_expected_build_sha               text    := NULL;   -- the candidate SHA from DEPLOY.md
  v_accept_unknown_property_ranking  boolean := false;  -- see precondition C
  -- ────────────────────────────────────────────────────────────────────────────────────────
  c_template_id  constant text := 'lc-s2-consider-com-en-01';
  c_prod_before  constant text := '6ff4a24ade134039828990829ace6faa07c8905b';
  c_known_tokens constant text[] := ARRAY['seller_first_name','sender_name','property_address'];
  v_row          public.sms_templates%ROWTYPE;
  v_n            int;
  v_tokens       text[];
  v_build        text;
  v_with_metric  int;
BEGIN
  -- A. the row
  SELECT count(*) INTO v_n FROM public.sms_templates WHERE template_id = c_template_id;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'commercial_s2_activate: REFUSED: expected exactly 1 row %, found %', c_template_id, v_n;
  END IF;
  SELECT * INTO v_row FROM public.sms_templates WHERE template_id = c_template_id;
  IF v_row.is_active THEN
    RAISE NOTICE 'commercial_s2_activate: % is already active; nothing to do', c_template_id;
    RETURN;
  END IF;
  IF COALESCE(v_row.metadata->>'authored_by', '') <> 'commercial_s2_template_20261023' THEN
    RAISE EXCEPTION 'commercial_s2_activate: REFUSED: % was not written by PROPOSED_insert.sql', c_template_id;
  END IF;
  SELECT array_agg(DISTINCT m[1]) INTO v_tokens FROM regexp_matches(v_row.template_body, '\{\{\s*([a-zA-Z0-9_]+)\s*\}\}', 'g') AS m;
  IF NOT COALESCE(v_tokens <@ c_known_tokens, false) THEN
    RAISE EXCEPTION 'commercial_s2_activate: REFUSED: body tokens % are not all verified renderer variables', v_tokens;
  END IF;
  IF lower(v_row.use_case) <> 'consider_selling' OR v_row.stage_code <> 'S2' OR v_row.language <> 'English'
     OR v_row.property_type_scope <> 'Commercial (Other)' OR lower(COALESCE(v_row.reply_mode, '')) <> 'auto_reply' THEN
    RAISE EXCEPTION 'commercial_s2_activate: REFUSED: % no longer has the proposed use_case / stage / language / scope / reply_mode', c_template_id;
  END IF;

  -- B. the deployed build
  SELECT value INTO v_build FROM public.system_control WHERE key = 'queue_processor_last_build_sha';
  IF v_expected_build_sha IS NULL OR btrim(v_expected_build_sha) = '' THEN
    RAISE EXCEPTION 'commercial_s2_activate: REFUSED: set v_expected_build_sha to the deployed candidate SHA (DEPLOY.md)';
  END IF;
  IF v_build IS NULL OR v_build = c_prod_before OR v_build <> btrim(v_expected_build_sha) THEN
    RAISE EXCEPTION 'commercial_s2_activate: REFUSED: queue processor build is % (expected %); the hotfix is not running',
      COALESCE(v_build, 'unknown'), v_expected_build_sha;
  END IF;

  -- C. ranking exposure on unknown-property threads
  SELECT count(*) INTO v_with_metric
    FROM public.sms_templates
   WHERE lower(use_case) = 'consider_selling' AND language = 'English' AND stage_code = 'S2'
     AND is_active AND safe_for_auto_reply
     AND (reply_mode IS NULL OR lower(reply_mode) IN ('', 'auto', 'auto_reply'))
     AND lower(COALESCE(property_type_scope, '')) !~ '(commercial|office|industrial|warehouse|hotel|motel|retail|strip|storage|land|vacant)'
     AND (success_rate IS NOT NULL OR usage_count IS NOT NULL);
  IF v_with_metric = 0 AND NOT v_accept_unknown_property_ranking THEN
    RAISE EXCEPTION USING
      MESSAGE = 'commercial_s2_activate: REFUSED: no residential-admitting S2 row carries success_rate / usage_count',
      DETAIL  = 'On a thread with no recoverable property and no scope label this row would rank first (newest updated_at).',
      HINT    = 'Owner: accept that exposure by setting v_accept_unknown_property_ranking := true, or wait for S2 metrics.';
  END IF;

  UPDATE public.sms_templates
     SET is_active = true,
         updated_at = now(),
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'activated_at', now(),
           'activated_by', 'PROPOSED_activate.sql (owner-authorized)',
           'activated_on_build', v_build,
           'unknown_property_ranking_accepted', v_accept_unknown_property_ranking)
   WHERE template_id = c_template_id AND is_active = false;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'commercial_s2_activate: REFUSED: activation touched % rows, expected 1', v_n;
  END IF;
  RAISE NOTICE 'commercial_s2_activate: % is ACTIVE on build %', c_template_id, v_build;
END
$activate$;

COMMIT;

-- POSTCHECK (read-only):
--   SELECT template_id, is_active, safe_for_auto_reply, metadata->>'activated_on_build' FROM public.sms_templates
--    WHERE template_id = 'lc-s2-consider-com-en-01';
-- Watch (read-only): replies that selected it, and the property group they were judged on:
--   SELECT id, queue_status, property_id, created_at, left(message_body, 120) FROM public.send_queue
--    WHERE COALESCE(selected_template_id, template_id) = 'lc-s2-consider-com-en-01' ORDER BY created_at DESC LIMIT 50;
