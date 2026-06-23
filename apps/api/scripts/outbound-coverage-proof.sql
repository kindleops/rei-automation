-- outbound-coverage-proof.sql
-- Run this before and after fixes to measure outbound coverage health.
-- Safe: read-only, no mutations.

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 1: INVENTORY FUNNEL
-- ────────────────────────────────────────────────────────────────────────────

SELECT '=== INVENTORY FUNNEL ===' AS section;

SELECT
  116217                                                        AS db_total_properties,
  (SELECT COUNT(*) FROM properties)                            AS current_total_properties,
  (SELECT COUNT(*) FROM properties WHERE master_owner_id IS NOT NULL AND master_owner_id != '') AS properties_with_owner,
  (SELECT COUNT(*) FROM properties WHERE master_owner_id IS NULL OR master_owner_id = '')       AS properties_orphan_no_owner,
  (SELECT COUNT(*) FROM master_owners)                         AS total_master_owners,
  (SELECT COUNT(*) FROM phones)                                AS total_phones,
  (SELECT COUNT(*) FROM v_property_lead_command WHERE sms_eligible = true AND best_phone_e164 IS NOT NULL AND master_owner_id IS NOT NULL) AS plc_eligible_with_phone,
  (SELECT COUNT(DISTINCT best_phone_e164) FROM v_property_lead_command WHERE sms_eligible = true AND best_phone_e164 IS NOT NULL) AS plc_unique_phones,
  (SELECT COUNT(*) FROM v_outbound_discovery_fresh)            AS discovery_view_total,
  (SELECT COUNT(*) FROM v_outbound_discovery_fresh WHERE never_contacted = true)  AS discovery_never_contacted,
  (SELECT COUNT(*) FROM v_outbound_discovery_fresh WHERE never_contacted = false) AS discovery_previously_contacted;

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 2: CONTACT STATE HEALTH
-- ────────────────────────────────────────────────────────────────────────────

SELECT '=== CONTACT STATE HEALTH ===' AS section;

SELECT
  (SELECT COUNT(*) FROM contact_outreach_state)                AS outreach_state_total_rows,
  (SELECT COUNT(*) FROM contact_outreach_state WHERE last_sms_at IS NOT NULL) AS outreach_state_with_sms,
  (SELECT COUNT(*) FROM contact_outreach_state WHERE suppression_until > NOW()) AS currently_suppressed,
  (SELECT COUNT(DISTINCT to_phone_number) FROM message_events WHERE direction = 'outbound') AS unique_phones_in_events,
  (SELECT COUNT(DISTINCT master_owner_id) FROM message_events WHERE direction = 'outbound' AND master_owner_id IS NOT NULL) AS unique_owners_in_events,
  (SELECT COUNT(*) FROM message_events WHERE direction = 'outbound') AS total_outbound_events;

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 3: OUTREACH STATE GAP (contacts missing from state table)
-- ────────────────────────────────────────────────────────────────────────────

SELECT '=== OUTREACH STATE GAP ===' AS section;

SELECT
  COUNT(DISTINCT (me.master_owner_id, me.to_phone_number))                                  AS unique_owner_phone_pairs_contacted,
  COUNT(DISTINCT cos.id)                                                                      AS matched_outreach_state_rows,
  COUNT(DISTINCT (me.master_owner_id, me.to_phone_number)) FILTER (WHERE cos.id IS NULL)     AS missing_outreach_state_rows,
  ROUND(
    100.0 * COUNT(DISTINCT (me.master_owner_id, me.to_phone_number)) FILTER (WHERE cos.id IS NULL)
    / NULLIF(COUNT(DISTINCT (me.master_owner_id, me.to_phone_number)), 0),
    1
  )                                                                                            AS pct_missing
FROM message_events me
LEFT JOIN contact_outreach_state cos
  ON cos.podio_master_owner_id = me.master_owner_id
  AND cos.to_phone_number = me.to_phone_number
WHERE me.direction = 'outbound'
  AND me.master_owner_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 4: REPEAT CONTACT ABUSE (top recycled threads)
-- ────────────────────────────────────────────────────────────────────────────

SELECT '=== TOP RECYCLED THREADS (outbound touch count > 3) ===' AS section;

SELECT
  to_phone_number,
  master_owner_id,
  property_id,
  COUNT(*)            AS outbound_count,
  MIN(created_at)     AS first_contact,
  MAX(created_at)     AS last_contact,
  COUNT(DISTINCT DATE(created_at)) AS distinct_days_contacted
FROM message_events
WHERE direction = 'outbound'
GROUP BY to_phone_number, master_owner_id, property_id
HAVING COUNT(*) > 3
ORDER BY COUNT(*) DESC
LIMIT 20;

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 5: NULL-OWNER OUTBOUND (should be zero after fix)
-- ────────────────────────────────────────────────────────────────────────────

SELECT '=== NULL OWNER OUTBOUND EVENTS ===' AS section;

SELECT
  COUNT(*)            AS null_owner_outbound_events,
  COUNT(DISTINCT to_phone_number) AS unique_phones,
  MIN(created_at)     AS first,
  MAX(created_at)     AS last
FROM message_events
WHERE direction = 'outbound'
  AND (master_owner_id IS NULL OR property_id IS NULL);

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 6: SEND QUEUE STATUS BREAKDOWN
-- ────────────────────────────────────────────────────────────────────────────

SELECT '=== SEND QUEUE STATUS BREAKDOWN ===' AS section;

SELECT
  queue_status,
  COUNT(*)                            AS count,
  COUNT(DISTINCT to_phone_number)     AS unique_phones,
  COUNT(DISTINCT master_owner_id)     AS unique_owners,
  MIN(created_at)                     AS oldest,
  MAX(created_at)                     AS newest
FROM send_queue
GROUP BY queue_status
ORDER BY count DESC;

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 7: QUEUE DUPLICATE RISK (same owner/property/phone in active + recent terminal)
-- ────────────────────────────────────────────────────────────────────────────

SELECT '=== ACTIVE QUEUE ITEMS (pending/queued/scheduled) ===' AS section;

SELECT
  COUNT(*)                            AS active_count,
  COUNT(DISTINCT to_phone_number)     AS unique_phones,
  COUNT(DISTINCT master_owner_id)     AS unique_owners
FROM send_queue
WHERE queue_status IN ('queued', 'scheduled', 'pending', 'approved', 'ready', 'sending');

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 8: AVAILABLE FRESH INVENTORY (never contacted, eligible now)
-- ────────────────────────────────────────────────────────────────────────────

SELECT '=== AVAILABLE FRESH INVENTORY BY MARKET ===' AS section;

SELECT
  COALESCE(market, 'unknown')          AS market,
  COUNT(*)                              AS eligible_never_contacted,
  COUNT(*) FILTER (WHERE sms_eligible = true) AS sms_eligible_count
FROM v_outbound_discovery_fresh
WHERE never_contacted = true
GROUP BY market
ORDER BY eligible_never_contacted DESC
LIMIT 20;

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 9: COVERAGE SUMMARY
-- ────────────────────────────────────────────────────────────────────────────

SELECT '=== COVERAGE SUMMARY ===' AS section;

WITH totals AS (
  SELECT
    (SELECT COUNT(*) FROM properties) AS total_props,
    (SELECT COUNT(*) FROM master_owners) AS total_owners,
    (SELECT COUNT(DISTINCT property_id) FROM message_events WHERE direction = 'outbound' AND property_id IS NOT NULL) AS contacted_props,
    (SELECT COUNT(DISTINCT master_owner_id) FROM message_events WHERE direction = 'outbound' AND master_owner_id IS NOT NULL) AS contacted_owners,
    (SELECT COUNT(*) FROM v_outbound_discovery_fresh WHERE never_contacted = true) AS available_fresh
)
SELECT
  total_props,
  contacted_props,
  ROUND(100.0 * contacted_props / NULLIF(total_props, 0), 2) AS property_coverage_pct,
  total_owners,
  contacted_owners,
  ROUND(100.0 * contacted_owners / NULLIF(total_owners, 0), 2) AS owner_coverage_pct,
  available_fresh AS fresh_eligible_inventory
FROM totals;
