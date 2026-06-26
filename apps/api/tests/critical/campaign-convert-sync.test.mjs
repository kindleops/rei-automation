import test from 'node:test'
import assert from 'node:assert/strict'

import { computeNextValidSendInstant } from '@/lib/domain/campaigns/campaign-convert-to-live.js'
import { isTestOrMockCampaign, isProofQueueRow } from '@/lib/domain/campaigns/campaign-sync-metrics.js'

test('computeNextValidSendInstant respects 08:00-21:00 window', () => {
  const noon = new Date('2026-06-26T16:00:00.000Z')
  const result = computeNextValidSendInstant({
    market: 'Miami, FL',
    contact_window_start: '08:00',
    contact_window_end: '21:00',
  }, noon)
  assert.ok(result.scheduled_for)
  assert.equal(result.timezone, 'America/New_York')
  assert.equal(result.window_start, '08:00')
  assert.equal(result.window_end, '21:00')
})

test('isTestOrMockCampaign detects proof and test campaigns', () => {
  assert.equal(isTestOrMockCampaign({ name: 'Proof Campaign Launch Execution 123' }), true)
  assert.equal(isTestOrMockCampaign({ name: 'Miami - Test Campaign' }), true)
  assert.equal(isTestOrMockCampaign({ name: 'Dallas Outreach Q2' }), false)
})

test('isProofQueueRow identifies no_send metadata', () => {
  assert.equal(isProofQueueRow({ metadata: { no_send: true } }), true)
  assert.equal(isProofQueueRow({ metadata: { launch_mode: 'proof_hydration_no_send' } }), true)
  assert.equal(isProofQueueRow({ metadata: { launch_mode: 'guarded_live_queue_creation' } }), false)
})