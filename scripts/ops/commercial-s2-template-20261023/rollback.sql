-- ─── rollback.sql ───────────────────────────────────────────────────────────────────────────
-- PROPOSED. NOT EXECUTED. Separately authorized. Undoes PROPOSED_insert.sql / PROPOSED_activate.sql
-- for the one row lc-s2-consider-com-en-01, and nothing else.
--
--   1. Always: deactivate it (is_active = false). From then on no reply selects it. The send-time
--      guard still judges any row already queued with it.
--   2. Delete it ONLY if no send_queue row references it. If any row references it, it is kept
--      (inactive): War Room / Analytics join send_queue.template_id to sms_templates.template_id, and
--      deleting a referenced row would break that attribution.
-- Idempotent: running it twice is a no-op the second time.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $rollback$
DECLARE
  c_template_id constant text := 'lc-s2-consider-com-en-01';
  v_n    int;
  v_refs int;
BEGIN
  SELECT count(*) INTO v_n FROM public.sms_templates
   WHERE template_id = c_template_id AND COALESCE(metadata->>'authored_by', '') = 'commercial_s2_template_20261023';
  IF v_n = 0 THEN
    RAISE NOTICE 'commercial_s2_rollback: no row % written by PROPOSED_insert.sql; nothing to do', c_template_id;
    RETURN;
  END IF;

  UPDATE public.sms_templates
     SET is_active = false,
         updated_at = now(),
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('rolled_back_at', now())
   WHERE template_id = c_template_id AND COALESCE(metadata->>'authored_by', '') = 'commercial_s2_template_20261023'
     AND is_active;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'commercial_s2_rollback: deactivated % row(s)', v_n;

  SELECT count(*) INTO v_refs FROM public.send_queue
   WHERE selected_template_id = c_template_id OR template_id = c_template_id;
  IF v_refs = 0 THEN
    DELETE FROM public.sms_templates
     WHERE template_id = c_template_id AND COALESCE(metadata->>'authored_by', '') = 'commercial_s2_template_20261023';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'commercial_s2_rollback: deleted % unreferenced row(s)', v_n;
  ELSE
    RAISE NOTICE 'commercial_s2_rollback: % send_queue row(s) reference %; kept INACTIVE for attribution', v_refs, c_template_id;
  END IF;
END
$rollback$;

COMMIT;
