-- outbound-contact-state-reconcile.sql
-- Reconciles contact_outreach_state against message_events.
-- UPDATES existing rows (not just inserts missing ones).
-- Safe to re-run: idempotent via ON CONFLICT DO UPDATE.
--
-- What it does:
--   1. Diagnostic snapshot BEFORE (so you can compare)
--   2. Separate report of null-owner events and high-touch phones
--   3. UPSERT with correct first_outbound_at / last_outbound_at / touch_count / suppression_until
--   4. Diagnostic snapshot AFTER
--
-- Internal test phones are listed and excluded from real-seller metrics.
-- Suppression: 45 days from last outbound contact.
-- Touch cap advisory: phones with >= 5 touches will need manual review.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 0. INTERNAL/TEST PHONE EXCLUSION LIST
--    Update this list to match src/lib/config/internal-phones.js
-- ────────────────────────────────────────────────────────────────────────────

CREATE TEMP TABLE IF NOT EXISTS internal_test_phones (phone text PRIMARY KEY);
INSERT INTO internal_test_phones (phone)
VALUES ('+16127433952')   -- Ryan's internal test number
ON CONFLICT DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. PRE-RECONCILE DIAGNOSTICS
-- ────────────────────────────────────────────────────────────────────────────

SELECT '=== PRE-RECONCILE: contact_outreach_state ===' AS section;

SELECT
  COUNT(*)                                                          AS total_rows,
  COUNT(*) FILTER (WHERE last_sms_at IS NOT NULL)                   AS with_last_sms_at,
  COUNT(*) FILTER (WHERE touch_count > 0)                           AS with_touch_count,
  COUNT(*) FILTER (WHERE suppression_until > NOW())                 AS currently_suppressed,
  MAX(touch_count)                                                  AS max_touch_count,
  AVG(touch_count)                                                  AS avg_touch_count
FROM contact_outreach_state;

SELECT '=== PRE-RECONCILE: message_events outbound ===' AS section;

SELECT
  COUNT(*)                                                          AS total_outbound_events,
  COUNT(DISTINCT to_phone_number)                                   AS unique_phones,
  COUNT(*) FILTER (WHERE master_owner_id IS NOT NULL)               AS events_with_owner,
  COUNT(*) FILTER (WHERE master_owner_id IS NULL)                   AS events_null_owner,
  COUNT(DISTINCT to_phone_number)
    FILTER (WHERE to_phone_number NOT IN (SELECT phone FROM internal_test_phones))
                                                                    AS real_seller_unique_phones,
  COUNT(DISTINCT to_phone_number)
    FILTER (WHERE to_phone_number IN (SELECT phone FROM internal_test_phones))
                                                                    AS internal_test_unique_phones
FROM message_events
WHERE direction = 'outbound';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. NULL-OWNER OUTBOUND EVENTS (should be zero in production)
-- ────────────────────────────────────────────────────────────────────────────

SELECT '=== NULL-OWNER OUTBOUND EVENTS ===' AS section;

SELECT
  to_phone_number,
  COUNT(*)            AS event_count,
  MIN(created_at)     AS first_at,
  MAX(created_at)     AS last_at,
  BOOL_OR(to_phone_number IN (SELECT phone FROM internal_test_phones)) AS is_internal_test
FROM message_events
WHERE direction = 'outbound'
  AND master_owner_id IS NULL
GROUP BY to_phone_number
ORDER BY event_count DESC
LIMIT 20;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. HIGH-TOUCH REAL SELLER PHONES (>= 5 touches, excludes internal)
-- ────────────────────────────────────────────────────────────────────────────

SELECT '=== HIGH-TOUCH REAL SELLER PHONES (>= 5 outbound events) ===' AS section;

SELECT
  to_phone_number,
  master_owner_id,
  property_id,
  COUNT(*)            AS outbound_count,
  MIN(created_at)     AS first_contact,
  MAX(created_at)     AS last_contact,
  COUNT(DISTINCT DATE(created_at)) AS distinct_days
FROM message_events
WHERE direction = 'outbound'
  AND master_owner_id IS NOT NULL
  AND to_phone_number NOT IN (SELECT phone FROM internal_test_phones)
GROUP BY to_phone_number, master_owner_id, property_id
HAVING COUNT(*) >= 5
ORDER BY outbound_count DESC
LIMIT 20;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. OWNER-PHONE PAIRS GAP REPORT
-- ────────────────────────────────────────────────────────────────────────────

SELECT '=== OWNER-PHONE PAIRS GAP (missing from contact_outreach_state) ===' AS section;

SELECT
  COUNT(DISTINCT (me.master_owner_id, me.to_phone_number))          AS contacted_pairs,
  COUNT(DISTINCT cos.id)                                             AS existing_state_rows,
  COUNT(DISTINCT (me.master_owner_id, me.to_phone_number))
    FILTER (WHERE cos.id IS NULL)                                    AS missing_rows,
  ROUND(
    100.0 * COUNT(DISTINCT (me.master_owner_id, me.to_phone_number)) FILTER (WHERE cos.id IS NULL)
    / NULLIF(COUNT(DISTINCT (me.master_owner_id, me.to_phone_number)), 0),
    1
  )                                                                   AS pct_missing
FROM message_events me
LEFT JOIN contact_outreach_state cos
  ON cos.podio_master_owner_id = me.master_owner_id
  AND cos.to_phone_number = me.to_phone_number
WHERE me.direction = 'outbound'
  AND me.master_owner_id IS NOT NULL
  AND me.to_phone_number NOT IN (SELECT phone FROM internal_test_phones);

-- ────────────────────────────────────────────────────────────────────────────
-- 5. RECONCILE: UPSERT ALL OWNER-PHONE PAIRS FROM message_events
--    Updates existing rows AND inserts missing rows.
--    Excludes internal/test phones.
--    Uses GREATEST/LEAST to never move timestamps backwards.
-- ────────────────────────────────────────────────────────────────────────────

SELECT '=== RUNNING RECONCILE UPSERT ===' AS section;

WITH aggregated AS (
  SELECT
    master_owner_id                                                  AS podio_master_owner_id,
    to_phone_number,
    COUNT(*)::int                                                    AS touch_count_from_events,
    MIN(created_at)                                                  AS first_outbound_at_from_events,
    MAX(created_at)                                                  AS last_outbound_at_from_events,
    -- 45 days from last contact
    MAX(created_at) + INTERVAL '45 days'                             AS suppression_until_from_events
  FROM message_events
  WHERE direction = 'outbound'
    AND master_owner_id IS NOT NULL
    AND to_phone_number IS NOT NULL
    AND to_phone_number NOT IN (SELECT phone FROM internal_test_phones)
  GROUP BY master_owner_id, to_phone_number
)
INSERT INTO contact_outreach_state (
  podio_master_owner_id,
  to_phone_number,
  canonical_e164,
  channel,
  first_outbound_at,
  last_outbound_at,
  last_sms_at,
  last_touch_at,
  touch_count,
  suppression_until,
  suppression_reason,
  created_at,
  updated_at
)
SELECT
  a.podio_master_owner_id,
  a.to_phone_number,
  a.to_phone_number                                                  AS canonical_e164,
  'sms'                                                              AS channel,
  a.first_outbound_at_from_events                                    AS first_outbound_at,
  a.last_outbound_at_from_events                                     AS last_outbound_at,
  a.last_outbound_at_from_events                                     AS last_sms_at,
  a.last_outbound_at_from_events                                     AS last_touch_at,
  a.touch_count_from_events                                          AS touch_count,
  a.suppression_until_from_events                                    AS suppression_until,
  'reconciled_from_message_events'                                   AS suppression_reason,
  NOW()                                                              AS created_at,
  NOW()                                                              AS updated_at
FROM aggregated a
ON CONFLICT (podio_master_owner_id, to_phone_number) DO UPDATE
  SET
    -- Only move first_outbound_at backwards (keep earliest known contact).
    first_outbound_at    = LEAST(
                             COALESCE(contact_outreach_state.first_outbound_at, EXCLUDED.first_outbound_at),
                             EXCLUDED.first_outbound_at
                           ),
    -- Always advance last_outbound_at / last_sms_at / last_touch_at.
    last_outbound_at     = GREATEST(
                             COALESCE(contact_outreach_state.last_outbound_at, EXCLUDED.last_outbound_at),
                             EXCLUDED.last_outbound_at
                           ),
    last_sms_at          = GREATEST(
                             COALESCE(contact_outreach_state.last_sms_at, EXCLUDED.last_sms_at),
                             EXCLUDED.last_sms_at
                           ),
    last_touch_at        = GREATEST(
                             COALESCE(contact_outreach_state.last_touch_at, EXCLUDED.last_touch_at),
                             EXCLUDED.last_touch_at
                           ),
    -- Set touch_count to the maximum known (message_events is authoritative for history).
    touch_count          = GREATEST(
                             COALESCE(contact_outreach_state.touch_count, 0),
                             EXCLUDED.touch_count
                           ),
    -- Advance suppression_until if the reconciled value is further in the future.
    suppression_until    = GREATEST(
                             COALESCE(contact_outreach_state.suppression_until, EXCLUDED.suppression_until),
                             EXCLUDED.suppression_until
                           ),
    suppression_reason   = CASE
                             WHEN contact_outreach_state.suppression_reason = 'reconciled_from_message_events'
                               THEN 'reconciled_from_message_events'
                             ELSE COALESCE(contact_outreach_state.suppression_reason, 'reconciled_from_message_events')
                           END,
    updated_at           = NOW();

-- ────────────────────────────────────────────────────────────────────────────
-- 6. POST-RECONCILE DIAGNOSTICS
-- ────────────────────────────────────────────────────────────────────────────

SELECT '=== POST-RECONCILE: contact_outreach_state ===' AS section;

SELECT
  COUNT(*)                                                          AS total_rows,
  COUNT(*) FILTER (WHERE last_sms_at IS NOT NULL)                   AS with_last_sms_at,
  COUNT(*) FILTER (WHERE touch_count > 0)                           AS with_touch_count,
  COUNT(*) FILTER (WHERE suppression_until > NOW())                 AS currently_suppressed,
  COUNT(*) FILTER (WHERE touch_count >= 5)                          AS touch_cap_candidates,
  MAX(touch_count)                                                  AS max_touch_count,
  ROUND(AVG(touch_count), 2)                                        AS avg_touch_count,
  COUNT(*) FILTER (WHERE suppression_reason = 'reconciled_from_message_events') AS reconciled_rows
FROM contact_outreach_state;

SELECT '=== POST-RECONCILE: discovery view never_contacted ===' AS section;

SELECT
  COUNT(*)                                             AS total_in_discovery_view,
  COUNT(*) FILTER (WHERE never_contacted = true)       AS never_contacted,
  COUNT(*) FILTER (WHERE never_contacted = false)      AS previously_contacted,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE never_contacted = false)
    / NULLIF(COUNT(*), 0),
    1
  )                                                    AS pct_previously_contacted
FROM v_outbound_discovery_fresh;

SELECT '=== POST-RECONCILE: owner-phone pairs still missing from state ===' AS section;

SELECT
  COUNT(DISTINCT (me.master_owner_id, me.to_phone_number))
    FILTER (WHERE cos.id IS NULL)                                    AS still_missing_rows
FROM message_events me
LEFT JOIN contact_outreach_state cos
  ON cos.podio_master_owner_id = me.master_owner_id
  AND cos.to_phone_number = me.to_phone_number
WHERE me.direction = 'outbound'
  AND me.master_owner_id IS NOT NULL
  AND me.to_phone_number NOT IN (SELECT phone FROM internal_test_phones);

COMMIT;

-- ────────────────────────────────────────────────────────────────────────────
-- 7. COVERAGE SUMMARY (run after COMMIT)
-- ────────────────────────────────────────────────────────────────────────────

SELECT '=== FINAL COVERAGE SUMMARY ===' AS section;

WITH totals AS (
  SELECT
    (SELECT COUNT(*) FROM properties) AS total_props,
    (SELECT COUNT(*) FROM master_owners) AS total_owners,
    (SELECT COUNT(DISTINCT property_id) FROM message_events
      WHERE direction = 'outbound'
        AND property_id IS NOT NULL
        AND to_phone_number NOT IN (SELECT phone FROM internal_test_phones)) AS real_contacted_props,
    (SELECT COUNT(DISTINCT master_owner_id) FROM message_events
      WHERE direction = 'outbound'
        AND master_owner_id IS NOT NULL
        AND to_phone_number NOT IN (SELECT phone FROM internal_test_phones)) AS real_contacted_owners,
    (SELECT COUNT(*) FROM v_outbound_discovery_fresh WHERE never_contacted = true) AS fresh_eligible
)
SELECT
  total_props,
  real_contacted_props,
  ROUND(100.0 * real_contacted_props / NULLIF(total_props, 0), 2)  AS property_coverage_pct,
  total_owners,
  real_contacted_owners,
  ROUND(100.0 * real_contacted_owners / NULLIF(total_owners, 0), 2) AS owner_coverage_pct,
  fresh_eligible
FROM totals;
