/**
 * The Nurture lens: one predicate (opportunity_status = 'nurture' and no seller
 * reply since the deal went to nurture) for the list and its count.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { nurtureFacts, inNurtureLens } from '../../src/lib/domain/opportunity/pipeline-command-service.js'

const NOW = Date.parse('2026-10-04T12:00:00Z')

test('a nurture deal with no reply since it went to nurture is in the lens', () => {
  const f = nurtureFacts({ opportunity_status: 'nurture', last_contact_at: '2026-09-11T15:12:00Z', next_action_due: '2026-10-11T15:12:00Z' }, { last_inbound_at: '2026-09-11T15:12:03Z' }, '2026-10-02T18:43:50Z', NOW)
  assert.equal(f.inLens, true)
  assert.equal(inNurtureLens({ nurture: f }), true)
  // days in nurture run from the "not interested" turn, not the backfilled status change
  assert.equal(f.since, '2026-09-11T15:12:00.000Z')
  assert.equal(f.days, 22)
  assert.equal(f.followUpDue, '2026-10-11T15:12:00Z')
})

test('a seller reply after the deal went to nurture returns it to the main view', () => {
  const f = nurtureFacts({ opportunity_status: 'nurture', last_contact_at: '2026-09-11T15:12:00Z' }, { last_inbound_at: '2026-10-03T09:00:00Z' }, '2026-10-02T18:43:50Z', NOW)
  assert.equal(f.inLens, false)
  assert.equal(f.repliedAfter, true)
})

test('without a status-change event the anchor is last_contact_at', () => {
  assert.equal(nurtureFacts({ opportunity_status: 'nurture', last_contact_at: '2026-09-11T15:12:00Z' }, { last_inbound_at: '2026-09-11T15:12:03Z' }, null, NOW).inLens, false)
  assert.equal(nurtureFacts({ opportunity_status: 'nurture', last_contact_at: '2026-09-11T15:12:00Z' }, { last_inbound_at: '2026-09-11T15:11:00Z' }, null, NOW).inLens, true)
})

test('not nurture status: never in the lens', () => {
  assert.equal(nurtureFacts({ opportunity_status: 'active' }, null, null, NOW), null)
  assert.equal(inNurtureLens({ nurture: null }), false)
})
