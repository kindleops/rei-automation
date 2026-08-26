-- ─────────────────────────────────────────────────────────────────────────────
-- HISTORICAL WRONG-SCOPE SUPPRESSION REPAIR — sold→wrong_number bug
-- (closure pass 2026-08-26; certified detector + per-phone manual review)
--
-- Scope: EXACTLY three phones, individually evidence-verified. Each texted a
-- pure sold-property report (no wrong-number / not-owner / opt-out / hostile
-- evidence anywhere in their inbound history, no active hard-suppression
-- rows) and was wrongly stamped phone_contact_status='wrong_number' on
-- 2026-07-01 by the since-fixed sold→wrong_number classifier fold:
--   +13175908186  "Sold it last week for $80,000!"
--   +18312479998  "No It sold"
--   +19186192128  "Sold it 10 yrs ago"
-- Verified NOT candidates (stay suppressed): 63 legit disconnects, 6
-- no-matching-evidence (operator review), +12067475796 (explicit
-- "Don't contact me again." + two active 21610 rows).
--
-- Repair semantics (append provenance, never erase history):
--   phones: contact status returns to 'contactable'; wrong_number_at kept.
--   message_events: detected_intent wrong_number→sold_property where the
--     body is the sold report (provenance in metadata).
--   inbox_thread_state: disposition → 'sold' (pairing closed), evidence-free
--     is_suppressed cleared, bucket 'suppressed'→'cold', last_intent
--     'sold_property'; repair provenance in metadata.
-- The property pairing REMAINS closed (disposition sold); only the
-- person/phone becomes reachable again.
--
-- Execute AFTER the certified code deploy. Queue containment
-- (queue_processor_mode=off + emergency stop) means nothing can send as a
-- side effect of this repair.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. phones — restore contactability, keep the historical timestamp.
UPDATE public.phones
SET phone_contact_status = 'contactable'
WHERE canonical_e164 IN ('+13175908186','+18312479998','+19186192128')
  AND phone_contact_status = 'wrong_number';

-- 2. message_events — correct the historical intent (the terminal-intent
--    scan reads these), preserving the original value.
UPDATE public.message_events
SET detected_intent = 'sold_property',
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'detected_intent_original', detected_intent,
      'repair', 'sold_scope_repair_20260826')
WHERE direction = 'inbound'
  AND thread_key IN ('+13175908186','+18312479998','+19186192128')
  AND lower(coalesce(detected_intent, '')) IN ('wrong_number','former_owner_respondent');

-- 3. inbox_thread_state — pairing stays closed (sold), person reachable.
UPDATE public.inbox_thread_state
SET disposition = 'sold',
    is_suppressed = false,
    inbox_bucket = CASE WHEN inbox_bucket = 'suppressed' THEN 'cold' ELSE inbox_bucket END,
    last_intent = 'sold_property',
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'repair', 'sold_scope_repair_20260826',
      'repair_prior_disposition', disposition,
      'repair_prior_is_suppressed', is_suppressed),
    updated_at = now()
WHERE thread_key IN ('+13175908186','+18312479998','+19186192128');

-- Verification (run inside the txn before COMMIT):
--   * 3 phones contactable, wrong_number_at retained
--   * 0 remaining wrong_number/former_owner detected_intent rows on the 3 threads
--   * 3 thread states: disposition sold, is_suppressed false
SELECT
  (SELECT count(*) FROM public.phones
    WHERE canonical_e164 IN ('+13175908186','+18312479998','+19186192128')
      AND phone_contact_status = 'contactable' AND wrong_number_at IS NOT NULL) AS phones_repaired,
  (SELECT count(*) FROM public.message_events
    WHERE thread_key IN ('+13175908186','+18312479998','+19186192128')
      AND direction='inbound'
      AND lower(coalesce(detected_intent,'')) IN ('wrong_number','former_owner')) AS residual_terminal_intents,
  (SELECT count(*) FROM public.inbox_thread_state
    WHERE thread_key IN ('+13175908186','+18312479998','+19186192128')
      AND disposition = 'sold' AND is_suppressed = false) AS threads_repaired;

COMMIT;

-- STAGED (operator review, NOT executed by this script):
--   * 75 contradiction threads (is_suppressed + contactable) with NO
--     matching evidence in inbound history — candidate un-hiding after
--     per-thread review; they do NOT block sends today.
--   * 161 contradiction threads WITH opt-out evidence — candidate tuple
--     upgrade to contactability_status='opted_out' (send-time enforcement is
--     already covered for 179/292 via active sms_suppression_list rows).
--   * 3 threads suppressed with zero inbound history.
-- Detector queries preserved in the certification report.
