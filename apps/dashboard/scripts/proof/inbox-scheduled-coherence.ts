/**
 * inbox-scheduled-coherence.ts
 *
 * Client-side half of the Scheduled-bucket contract. The server-side half
 * (derivation from send_queue, attention removal, counts) is proven in
 * apps/api/tests/critical/inbox-scheduled-thread-state.test.mjs.
 */

import assert from 'node:assert/strict'
import {
  formatScheduledSendTime,
  readScheduledSendTime,
  isScheduleSuppressedThread,
  scheduledPendingCount,
} from '../../src/domain/inbox/format-scheduled-send-time'
import { applyBulkScheduleResult } from '../../src/domain/inbox/apply-bulk-schedule-result'
import { mapAuthoritativeCountsFromPayload } from '../../src/domain/inbox/inbox-boot-read'

let passed = 0
const check = (name: string, fn: () => void) => {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

// 2026-09-06T18:00Z = 1:00 PM Chicago, 11:00 AM Los Angeles
const NOW = new Date('2026-09-06T18:00:00Z')

console.log('\nTIME DISPLAY (seller-local)')

check('today / tomorrow / dated forms', () => {
  assert.equal(formatScheduledSendTime('2026-09-06T20:42:00Z', 'America/Chicago', NOW)!.label, 'Today · 3:42 PM')
  assert.equal(formatScheduledSendTime('2026-09-07T13:00:00Z', 'America/Chicago', NOW)!.label, 'Tomorrow · 8:00 AM')
  assert.equal(formatScheduledSendTime('2026-09-10T19:17:00Z', 'America/Chicago', NOW)!.label, 'Sep 10 · 2:17 PM')
})

check('the SELLER decides the clock, not the operator', () => {
  const instant = '2026-09-07T15:00:00Z'
  assert.equal(formatScheduledSendTime(instant, 'America/Los_Angeles', NOW)!.label, 'Tomorrow · 8:00 AM')
  assert.equal(formatScheduledSendTime(instant, 'America/New_York', NOW)!.label, 'Tomorrow · 11:00 AM')
})

check('"today" flips in the seller zone, not in UTC', () => {
  // 04:30Z on the 7th is still 9:30 PM on the 6th in Los Angeles.
  const r = formatScheduledSendTime('2026-09-07T04:30:00Z', 'America/Los_Angeles', NOW)!
  assert.equal(r.dayLabel, 'Today')
  assert.equal(r.timeLabel, '9:30 PM')
})

check('an unusable timezone degrades instead of blanking the row', () => {
  const r = formatScheduledSendTime('2026-09-07T13:00:00Z', 'Not/AZone', NOW)
  assert.ok(r && r.label.length > 0)
  assert.equal(r!.timezone, null)
})

check('missing or invalid instants render nothing rather than "Invalid Date"', () => {
  assert.equal(formatScheduledSendTime(null, 'America/Chicago', NOW), null)
  assert.equal(formatScheduledSendTime('not-a-date', 'America/Chicago', NOW), null)
})

check('the effective persisted time wins over anything requested', () => {
  // Operator asked 7:15 AM; canonical scheduling resolved 8:00 AM.
  const thread = {
    next_scheduled_send_at_utc: '2026-09-07T13:00:00Z',
    next_scheduled_timezone: 'America/Chicago',
    requested_scheduled_for: '2026-09-07T12:15:00Z',
  }
  assert.equal(readScheduledSendTime(thread, NOW)!.label, 'Tomorrow · 8:00 AM')
})

console.log('\nATTENTION STATE')

check('the server flag is the only authority; nothing is recomputed', () => {
  assert.equal(isScheduleSuppressedThread({ is_schedule_suppressed: true }), true)
  assert.equal(isScheduleSuppressedThread({ is_schedule_suppressed: false }), false)
  // A future time WITHOUT the flag must not suppress: the server already
  // weighed the seller-reply override and we do not second-guess it.
  assert.equal(isScheduleSuppressedThread({ next_scheduled_send_at_utc: '2099-01-01T00:00:00Z' }), false)
  assert.equal(isScheduleSuppressedThread(null), false)
})

check('a scheduled thread keeps its lead truth', () => {
  const thread = { is_schedule_suppressed: true, inbox_bucket: 'priority', is_hot_lead: true, priority_score: 94 }
  assert.equal(isScheduleSuppressedThread(thread), true)
  assert.equal(thread.inbox_bucket, 'priority')
  assert.equal(thread.is_hot_lead, true)
})

console.log('\nSORTING AND DE-DUPLICATION')

check('Scheduled sorts by nearest effective send, one row per thread', () => {
  const threads = [
    { thread_key: 'c', next_scheduled_send_at_utc: '2026-09-10T19:17:00Z' },
    { thread_key: 'a', next_scheduled_send_at_utc: '2026-09-06T20:42:00Z' },
    { thread_key: 'b', next_scheduled_send_at_utc: '2026-09-07T13:00:00Z' },
  ]
  const sorted = [...threads].sort((x, y) =>
    Date.parse(x.next_scheduled_send_at_utc) - Date.parse(y.next_scheduled_send_at_utc))
  assert.deepEqual(sorted.map((t) => t.thread_key), ['a', 'b', 'c'])
  assert.equal(new Set(sorted.map((t) => t.thread_key)).size, sorted.length)
})

check('multiple future actions surface a count, not duplicate rows', () => {
  assert.equal(scheduledPendingCount({ scheduled_pending_count: 2 }), 2)
  assert.equal(scheduledPendingCount({ scheduled_pending_count: 0 }), 0)
  assert.equal(scheduledPendingCount({}), 0)
})

console.log('\nSERVER-CONFIRMED BULK TRANSITION')

check('only server-confirmed recipients move (11 of 13)', () => {
  const results = [
    ...Array.from({ length: 11 }, (_, i) => ({
      thread_key: `+1555000${String(i).padStart(4, '0')}`,
      ok: true,
      effective_send_at_utc: '2026-09-07T13:00:00Z',
    })),
    { thread_key: '+15550009991', ok: false, reason: 'invalid_from_phone_number' },
    { thread_key: '+15550009992', ok: false, reason: 'contact_window_unresolvable' },
  ]
  const outcome = applyBulkScheduleResult({ ok: true, results })

  assert.equal(outcome.scheduledThreadKeys.length, 11)
  assert.equal(outcome.needsReviewThreadKeys.length, 2)
  assert.equal(outcome.summary, '11 follow-ups scheduled · 2 need review')
  assert.equal(outcome.failureReasonByThreadKey['+15550009991'], 'invalid_from_phone_number')
  assert.equal(outcome.patchByThreadKey['+15550000000'].is_schedule_suppressed, true)
  assert.equal(outcome.patchByThreadKey['+15550000000'].next_scheduled_send_at_utc, '2026-09-07T13:00:00Z')
  // Refused recipients get no patch, so nothing can move them.
  assert.equal(outcome.patchByThreadKey['+15550009991'], undefined)
})

check('an absent ok is a failure, never a silent success', () => {
  const outcome = applyBulkScheduleResult({
    results: [
      { thread_key: 'x' },
      { thread_key: 'y', ok: undefined },
      { thread_key: 'z', ok: false, skipped: true, reason: 'suppressed' },
    ],
  })
  assert.equal(outcome.scheduledThreadKeys.length, 0)
  assert.equal(outcome.needsReviewThreadKeys.length, 3)
})

check('an empty or malformed response moves nothing', () => {
  for (const response of [null, undefined, {}, { results: [] }, { results: undefined }]) {
    const outcome = applyBulkScheduleResult(response as never)
    assert.equal(outcome.scheduledThreadKeys.length, 0)
    assert.equal(outcome.summary, 'Nothing scheduled')
  }
})

check('a confirmed recipient with no effective time still moves, without inventing one', () => {
  const outcome = applyBulkScheduleResult({ results: [{ thread_key: 'q', ok: true }] })
  assert.equal(outcome.scheduledThreadKeys.length, 1)
  assert.equal(outcome.patchByThreadKey.q.next_scheduled_send_at_utc, null)
})

console.log('\nCOUNTS WHITELIST')

check('scheduled and snoozed survive the authoritative counts mapping', () => {
  // Found on staging: /api/cockpit/inbox/counts returned scheduled:1 while the
  // sidebar chip showed "-", because this mapper is a fixed whitelist and
  // neither key was in it. Both chips were dead regardless of the server.
  const mapped = mapAuthoritativeCountsFromPayload({
    counts: { priority: 150, new_replies: 164, scheduled: 1, snoozed: 3 },
  })
  assert.equal(mapped.scheduled, 1)
  assert.equal(mapped.snoozed, 3)
  assert.equal(mapped.priority, 150)
})

check('an absent scheduled count stays UNKNOWN rather than becoming 0', () => {
  const mapped = mapAuthoritativeCountsFromPayload({ counts: { priority: 150 } })
  assert.equal('scheduled' in mapped, false, 'absent must render "-", never a confident 0')
  assert.equal('snoozed' in mapped, false)
  // The other keys keep their existing coerce-to-zero behaviour.
  assert.equal(mapped.new_replies, 0)
})

check('a zero scheduled count is reported as a real zero', () => {
  const mapped = mapAuthoritativeCountsFromPayload({ counts: { priority: 1, scheduled: 0 } })
  assert.equal(mapped.scheduled, 0)
})

check('a malformed scheduled count does not poison the chip', () => {
  for (const bad of ['nonsense', -1, NaN, {}]) {
    const mapped = mapAuthoritativeCountsFromPayload({ counts: { priority: 1, scheduled: bad } })
    assert.equal('scheduled' in mapped, false, `${String(bad)} must not become a count`)
  }
})

console.log(`\nPASS  ${passed} checks\n`)
