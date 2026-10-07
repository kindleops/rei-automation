-- PROPOSED (not applied) — restore 30-day "not interested" nurture follow-ups
-- that the stored automation rule stage.not_interested_cold cancelled.
--
-- Owner rule (2026-09-30): "A not interested is a 30 day follow up."
-- Defect: the prod automation_rules row (seeded 2026-06-03) has
--   cancel_pending_queue {"reason":"not_interested"} without
--   keep_nurture_follow_ups, and stored actions replace the code default, so
--   ~5s after the seller flow scheduled the nurture the rule cancelled it
--   (queue_status cancelled, guard/failed_reason 'not_interested',
--   safety_status/guard_status 'blocked'). Code fix: shouldKeepNurtureFollowUps
--   in apps/api/src/lib/domain/automation/automation-actions.js.
--
-- Verdicts per cancelled row (created >= 2026-09-01):
--   BLOCKED_SUPPRESSED   active sms_suppression_list / automation_suppressions row
--                        (opt-out, DNC, wrong number, manual), thread is_suppressed,
--                        or any inbound opt-out message from the phone
--   BLOCKED_WRONG_NUMBER thread stage/disposition/contactability says wrong number / not owner
--   REVIEW_REPLIED_LATER seller sent an inbound after the nurture was scheduled
--   SKIP_SUPERSEDED      a newer nurture row (live or sent) exists for the thread,
--                        or a live row already holds the same dedupe_key
--   RESTORE              everything else
--
-- RESTORE keeps the original due date when it is still in the future; otherwise
-- now-or-next 17:00–20:00 UTC slot (8am–9pm recipient-local for every US zone)
-- plus up to 120 min of jitter. The queue processor still applies its own
-- send-window / contactability guards at send time.
--
-- Usage: run PART 1 (read-only dry run). PART 2 is the apply transaction; it
-- requires the owner and is NOT run by the agent.

-- ═════════════════════════ PART 1 — DRY RUN (read-only) ═════════════════════
WITH cancelled AS (
  SELECT q.*
  FROM send_queue q
  WHERE q.created_at >= '2026-09-01'
    AND q.type = 'followup'
    AND q.use_case_template LIKE 'nurture_%'
    AND q.queue_status = 'cancelled'
    AND q.guard_reason = 'not_interested'
    AND q.sent_at IS NULL
    AND q.provider_message_id IS NULL
),
classified AS (
  SELECT c.id, c.thread_key, c.scheduled_for_utc, c.created_at,
    CASE
      WHEN EXISTS (SELECT 1 FROM sms_suppression_list s
                   WHERE (s.phone_e164 = c.to_phone_number OR s.phone_number = c.to_phone_number)
                     AND s.is_active IS DISTINCT FROM false)
        OR EXISTS (SELECT 1 FROM automation_suppressions a
                   WHERE a.phone_e164 = c.to_phone_number
                     AND lower(coalesce(a.status, 'active')) = 'active'
                     AND (a.expires_at IS NULL OR a.expires_at > now()))
        OR EXISTS (SELECT 1 FROM inbox_thread_state t
                   WHERE t.thread_key = c.thread_key AND t.is_suppressed IS TRUE)
        OR EXISTS (SELECT 1 FROM message_events m
                   WHERE m.direction = 'inbound' AND m.from_phone_number = c.to_phone_number
                     AND (m.is_opt_out IS TRUE
                          OR lower(coalesce(m.detected_intent, '')) IN ('opt_out', 'stop', 'dnc', 'do_not_contact', 'stop_texting')))
        THEN 'BLOCKED_SUPPRESSED'
      WHEN EXISTS (SELECT 1 FROM inbox_thread_state t
                   WHERE t.thread_key = c.thread_key
                     AND (lower(coalesce(t.stage, '')) IN ('wrong_number', 'not_owner')
                          OR lower(coalesce(t.disposition, '')) IN ('wrong_number', 'not_owner', 'bad_contact', 'suppressed', 'opt_out', 'dnc')
                          OR lower(coalesce(t.contactability_status, '')) IN ('wrong_number', 'invalid_number', 'opted_out', 'dnc', 'do_not_contact', 'suppressed')))
        THEN 'BLOCKED_WRONG_NUMBER'
      WHEN EXISTS (SELECT 1 FROM message_events m
                   WHERE m.direction = 'inbound' AND m.from_phone_number = c.to_phone_number
                     AND coalesce(m.received_at, m.created_at) > c.created_at
                     -- the triggering reply's message_events row lands ~4s AFTER the
                     -- queue row (deferred_message_resolution); it is not a later reply
                     AND m.id::text IS DISTINCT FROM c.metadata->>'inbound_message_event_id')
        THEN 'REVIEW_REPLIED_LATER'
      WHEN EXISTS (SELECT 1 FROM send_queue n
                   WHERE n.id <> c.id AND n.thread_key = c.thread_key
                     AND n.type = 'followup' AND n.use_case_template LIKE 'nurture_%'
                     AND n.created_at > c.created_at
                     AND (n.sent_at IS NOT NULL OR n.queue_status IN
                          ('queued','ready','runnable','scheduled','pending','paused','paused_after_hours','processing','approved','approval','held','sending','sent','delivered')))
        OR EXISTS (SELECT 1 FROM send_queue d
                   WHERE d.id <> c.id AND d.dedupe_key = c.dedupe_key AND d.sent_at IS NULL
                     AND d.queue_status IN ('queued','ready','runnable','scheduled','pending','paused','paused_after_hours','processing','approved','approval','held','sending'))
        THEN 'SKIP_SUPERSEDED'
      ELSE 'RESTORE'
    END AS verdict
  FROM cancelled c
)
SELECT verdict,
       count(*)                                              AS rows,
       count(*) FILTER (WHERE scheduled_for_utc > now())     AS keep_original_due,
       count(*) FILTER (WHERE scheduled_for_utc <= now())    AS reslot_now_window,
       min(scheduled_for_utc)::date                          AS earliest_due,
       max(scheduled_for_utc)::date                          AS latest_due
FROM classified
GROUP BY verdict
ORDER BY verdict;

-- ═════════════════════════ PART 2 — APPLY (owner only, NOT run) ═════════════
-- Single transaction; re-runs the classification inside the UPDATE so it is
-- idempotent (a restored row is no longer 'cancelled' and is not touched again).
-- Apply only AFTER the code fix is deployed, or the stored rule re-cancels on
-- the seller's next not-interested reply (not these rows: they only re-enter
-- the sweep on a new inbound).
/*  -- remove this line and the closing marker to apply
BEGIN;
SET LOCAL statement_timeout = '30s';
WITH cancelled AS (
  SELECT q.*
  FROM send_queue q
  WHERE q.created_at >= '2026-09-01'
    AND q.type = 'followup'
    AND q.use_case_template LIKE 'nurture_%'
    AND q.queue_status = 'cancelled'
    AND q.guard_reason = 'not_interested'
    AND q.sent_at IS NULL
    AND q.provider_message_id IS NULL
),
classified AS (
  SELECT c.id, c.thread_key, c.scheduled_for_utc, c.created_at,
    CASE
      WHEN EXISTS (SELECT 1 FROM sms_suppression_list s
                   WHERE (s.phone_e164 = c.to_phone_number OR s.phone_number = c.to_phone_number)
                     AND s.is_active IS DISTINCT FROM false)
        OR EXISTS (SELECT 1 FROM automation_suppressions a
                   WHERE a.phone_e164 = c.to_phone_number
                     AND lower(coalesce(a.status, 'active')) = 'active'
                     AND (a.expires_at IS NULL OR a.expires_at > now()))
        OR EXISTS (SELECT 1 FROM inbox_thread_state t
                   WHERE t.thread_key = c.thread_key AND t.is_suppressed IS TRUE)
        OR EXISTS (SELECT 1 FROM message_events m
                   WHERE m.direction = 'inbound' AND m.from_phone_number = c.to_phone_number
                     AND (m.is_opt_out IS TRUE
                          OR lower(coalesce(m.detected_intent, '')) IN ('opt_out', 'stop', 'dnc', 'do_not_contact', 'stop_texting')))
        THEN 'BLOCKED_SUPPRESSED'
      WHEN EXISTS (SELECT 1 FROM inbox_thread_state t
                   WHERE t.thread_key = c.thread_key
                     AND (lower(coalesce(t.stage, '')) IN ('wrong_number', 'not_owner')
                          OR lower(coalesce(t.disposition, '')) IN ('wrong_number', 'not_owner', 'bad_contact', 'suppressed', 'opt_out', 'dnc')
                          OR lower(coalesce(t.contactability_status, '')) IN ('wrong_number', 'invalid_number', 'opted_out', 'dnc', 'do_not_contact', 'suppressed')))
        THEN 'BLOCKED_WRONG_NUMBER'
      WHEN EXISTS (SELECT 1 FROM message_events m
                   WHERE m.direction = 'inbound' AND m.from_phone_number = c.to_phone_number
                     AND coalesce(m.received_at, m.created_at) > c.created_at
                     -- the triggering reply's message_events row lands ~4s AFTER the
                     -- queue row (deferred_message_resolution); it is not a later reply
                     AND m.id::text IS DISTINCT FROM c.metadata->>'inbound_message_event_id')
        THEN 'REVIEW_REPLIED_LATER'
      WHEN EXISTS (SELECT 1 FROM send_queue n
                   WHERE n.id <> c.id AND n.thread_key = c.thread_key
                     AND n.type = 'followup' AND n.use_case_template LIKE 'nurture_%'
                     AND n.created_at > c.created_at
                     AND (n.sent_at IS NOT NULL OR n.queue_status IN
                          ('queued','ready','runnable','scheduled','pending','paused','paused_after_hours','processing','approved','approval','held','sending','sent','delivered')))
        OR EXISTS (SELECT 1 FROM send_queue d
                   WHERE d.id <> c.id AND d.dedupe_key = c.dedupe_key AND d.sent_at IS NULL
                     AND d.queue_status IN ('queued','ready','runnable','scheduled','pending','paused','paused_after_hours','processing','approved','approval','held','sending'))
        THEN 'SKIP_SUPERSEDED'
      ELSE 'RESTORE'
    END AS verdict
  FROM cancelled c
),
slot AS (
  SELECT CASE
           WHEN now() < date_trunc('day', now()) + interval '17 hours'
             THEN date_trunc('day', now()) + interval '17 hours'
           WHEN now() < date_trunc('day', now()) + interval '18 hours'
             THEN now() + interval '5 minutes'
           ELSE date_trunc('day', now()) + interval '1 day 17 hours'
         END AS base
),
restore AS (
  SELECT c.id,
         CASE WHEN c.scheduled_for_utc > now() + interval '5 minutes' THEN c.scheduled_for_utc
              ELSE (SELECT base FROM slot) + (random() * interval '120 minutes') END AS due
  FROM classified c
  WHERE c.verdict = 'RESTORE'
)
UPDATE send_queue q
SET queue_status        = 'scheduled',
    guard_status        = NULL,
    guard_reason        = NULL,
    failed_reason       = NULL,
    safety_status       = 'pending',
    scheduled_for_utc   = r.due,
    scheduled_for       = r.due,
    scheduled_for_local = r.due,
    metadata = coalesce(q.metadata, '{}'::jsonb) || jsonb_build_object(
      'restored_from_cancel', jsonb_build_object(
        'at', now(),
        'by', 'repair_not_interested_nurture_20261007',
        'previous_guard_reason', q.guard_reason,
        'previous_scheduled_for_utc', q.scheduled_for_utc)),
    updated_at = now()
FROM restore r
WHERE q.id = r.id
  AND q.queue_status = 'cancelled'
  AND q.guard_reason = 'not_interested';
-- expect UPDATE = RESTORE count from PART 1 (31 on 2026-10-07); otherwise ROLLBACK.
COMMIT;
*/
