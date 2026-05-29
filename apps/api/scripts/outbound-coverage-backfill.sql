-- outbound-coverage-backfill.sql
-- Backfills contact_outreach_state from message_events for all contacted
-- owner-phone pairs that have no state row yet.
--
-- SAFE TO RUN: uses INSERT ... ON CONFLICT DO UPDATE, only writes/updates rows
-- where message_events has outbound contact evidence.
--
-- Effect: candidates that were already contacted will flip from
-- never_contacted=true to never_contacted=false in v_outbound_candidate_freshness,
-- preventing the feeder from recycling them.
--
-- Run this BEFORE turning the feeder back on.

BEGIN;

-- Step 1: Report rows that will be inserted (preview)
SELECT
  COUNT(DISTINCT (master_owner_id, to_phone_number)) AS pairs_to_backfill
FROM message_events
WHERE direction = 'outbound'
  AND master_owner_id IS NOT NULL
  AND to_phone_number IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM contact_outreach_state cos
    WHERE cos.podio_master_owner_id = message_events.master_owner_id
      AND cos.to_phone_number = message_events.to_phone_number
  );

-- Step 2: Upsert all contacted owner-phone pairs from message_events
INSERT INTO contact_outreach_state (
  podio_master_owner_id,
  to_phone_number,
  canonical_e164,
  channel,
  last_sms_at,
  last_outbound_at,
  first_outbound_at,
  last_touch_at,
  touch_count,
  suppression_until,
  suppression_reason,
  created_at,
  updated_at
)
SELECT
  me.master_owner_id                                                  AS podio_master_owner_id,
  me.to_phone_number,
  me.to_phone_number                                                  AS canonical_e164,
  'sms'                                                               AS channel,
  MAX(me.created_at)                                                  AS last_sms_at,
  MAX(me.created_at)                                                  AS last_outbound_at,
  MIN(me.created_at)                                                  AS first_outbound_at,
  MAX(me.created_at)                                                  AS last_touch_at,
  COUNT(*)::int                                                       AS touch_count,
  -- 45-day suppression from last contact
  MAX(me.created_at) + INTERVAL '45 days'                            AS suppression_until,
  'backfill_from_message_events'                                      AS suppression_reason,
  NOW()                                                               AS created_at,
  NOW()                                                               AS updated_at
FROM message_events me
WHERE me.direction = 'outbound'
  AND me.master_owner_id IS NOT NULL
  AND me.to_phone_number IS NOT NULL
GROUP BY me.master_owner_id, me.to_phone_number
ON CONFLICT (podio_master_owner_id, to_phone_number) DO UPDATE
  SET
    last_sms_at        = GREATEST(contact_outreach_state.last_sms_at, EXCLUDED.last_sms_at),
    last_outbound_at   = GREATEST(contact_outreach_state.last_outbound_at, EXCLUDED.last_outbound_at),
    first_outbound_at  = LEAST(
                           COALESCE(contact_outreach_state.first_outbound_at, EXCLUDED.first_outbound_at),
                           EXCLUDED.first_outbound_at
                         ),
    last_touch_at      = GREATEST(contact_outreach_state.last_touch_at, EXCLUDED.last_touch_at),
    touch_count        = GREATEST(contact_outreach_state.touch_count, EXCLUDED.touch_count),
    suppression_until  = GREATEST(
                           COALESCE(contact_outreach_state.suppression_until, EXCLUDED.suppression_until),
                           EXCLUDED.suppression_until
                         ),
    updated_at         = NOW()
  WHERE contact_outreach_state.last_sms_at IS NULL
     OR contact_outreach_state.last_sms_at < EXCLUDED.last_sms_at;

-- Step 3: Confirm results
SELECT
  COUNT(*)                                                          AS total_outreach_state_rows,
  COUNT(*) FILTER (WHERE last_sms_at IS NOT NULL)                   AS with_last_sms_at,
  COUNT(*) FILTER (WHERE suppression_until > NOW())                 AS currently_suppressed,
  COUNT(*) FILTER (WHERE suppression_reason = 'backfill_from_message_events') AS backfilled_rows
FROM contact_outreach_state;

-- Step 4: Verify the discovery view now reflects correct never_contacted counts
SELECT
  COUNT(*)                                             AS total_in_discovery_view,
  COUNT(*) FILTER (WHERE never_contacted = true)       AS never_contacted,
  COUNT(*) FILTER (WHERE never_contacted = false)      AS previously_contacted
FROM v_outbound_discovery_fresh;

COMMIT;
