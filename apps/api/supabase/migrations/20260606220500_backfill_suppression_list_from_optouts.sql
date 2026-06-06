-- ============================================================================
-- BACKFILL sms_suppression_list FROM EXISTING OPT-OUTS  (P0 §E)
-- ============================================================================
-- Going forward, every inbound STOP writes sms_suppression_list (the canonical
-- suppression source the outbound compliance hard-stop reads). But contacts who
-- opted out BEFORE this change are shown "Suppressed" in the inbox (via their
-- opt_out flag) yet are NOT on the enforcement list, so the sender would not
-- block them. This backfill closes that compliance gap.
--
-- Idempotent: only inserts numbers not already actively suppressed.
-- Scope: genuine opt-outs only (opt_out flag / is_suppressed / detected opt_out).
-- Wrong-number / not_interested are intentionally excluded (different handling).
-- ============================================================================

INSERT INTO public.sms_suppression_list
  (phone_number, phone_e164, suppression_reason, reason, suppression_type, source, is_active, suppressed_at)
SELECT DISTINCT
  t.canonical_e164,
  t.canonical_e164,
  'inbound_opt_out_backfill',
  'inbound_opt_out_backfill',
  'opt_out',
  'p0_backfill_20260606',
  true,
  now()
FROM public.v_inbox_threads_live_v2 t
WHERE COALESCE(t.canonical_e164, '') <> ''
  AND (
        COALESCE(t.opt_out, false)
        OR COALESCE(t.is_suppressed, false)
        OR lower(COALESCE(t.detected_intent, t.reply_intent, '')) = 'opt_out'
      )
  AND NOT EXISTS (
        SELECT 1 FROM public.sms_suppression_list s
        WHERE s.is_active = true
          AND (s.phone_e164 = t.canonical_e164 OR s.phone_number = t.canonical_e164)
      );
