import test from 'node:test'
import assert from 'node:assert/strict'

import { deriveOperatorState, operatorStateLabel } from '../../src/lib/domain/campaigns/campaign-operator-state.js'
import { wrapCampaignActionResponse } from '../../src/lib/domain/campaigns/campaign-lifecycle-response.js'

test('proof-only execution never displays Live operator state', () => {
  const state = deriveOperatorState(
    { status: 'active', auto_send_enabled: false, total_targets: 802 },
    {
      proof_mode: true,
      live_send_rows: 0,
      proof_no_send_rows: 50,
      routing_allowed: 0,
      transmission_enabled: false,
      no_messages_will_transmit: true,
    },
    { launch_readiness: 'blocked', blockers: ['Sending disabled'] },
  )
  assert.equal(state, 'test_mode')
  assert.equal(operatorStateLabel(state), 'Test Mode')
})

test('readiness blocked when routing is zero on active campaign', () => {
  const state = deriveOperatorState(
    { status: 'active', auto_send_enabled: true, total_targets: 100 },
    { proof_mode: false, live_send_rows: 0, routing_allowed: 0, transmission_enabled: false },
    { launch_readiness: 'blocked', blockers: ['No routable recipients'] },
  )
  assert.equal(state, 'blocked')
})

test('lifecycle action response always includes JSON contract fields', () => {
  const wrapped = wrapCampaignActionResponse({
    ok: true,
    campaign_id: 'c-1',
    run_id: 'r-1',
    from: 'paused',
    to: 'active',
    state: 'live',
    message: 'Resumed',
    counts: { ready: 10 },
    blockers: [],
    warnings: [],
  })
  assert.equal(wrapped.ok, true)
  assert.equal(wrapped.campaign_id, 'c-1')
  assert.equal(wrapped.run_id, 'r-1')
  assert.equal(wrapped.previous_state, 'paused')
  assert.equal(wrapped.state, 'live')
  assert.deepEqual(wrapped.counts, { ready: 10 })
})

test('blocked resume returns structured error contract', () => {
  const wrapped = wrapCampaignActionResponse({
    ok: false,
    code: 'CAMPAIGN_BLOCKED',
    error: 'CAMPAIGN_BLOCKED',
    campaign_id: 'c-1',
    from: 'paused',
    to: 'paused',
    state: 'blocked',
    blockers: ['Emergency stop is active'],
    counts: { ready: 5 },
    message: 'Resume blocked',
  })
  assert.equal(wrapped.ok, false)
  assert.equal(wrapped.code, 'CAMPAIGN_BLOCKED')
  assert.equal(wrapped.blockers[0], 'Emergency stop is active')
})