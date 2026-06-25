#!/usr/bin/env node
import assert from 'node:assert/strict'
import { resolveQueueDispatchTruth } from '../../src/domain/queue/queue-dispatch-truth.ts'

const now = '2026-06-25T12:00:00.000Z'

assert.equal(
  resolveQueueDispatchTruth({
    status: 'scheduled',
    scheduledForUtc: '2026-06-25T13:00:00.000Z',
    smsEligible: true,
    metadata: { no_send: true },
    now,
  }).category,
  'proof',
)

assert.equal(
  resolveQueueDispatchTruth({
    status: 'scheduled',
    scheduledForUtc: '2026-06-25T13:00:00.000Z',
    smsEligible: true,
    campaignId: 'camp-1',
    campaignStatus: 'paused',
    now,
  }).category,
  'paused_campaign',
)

assert.equal(
  resolveQueueDispatchTruth({
    status: 'scheduled',
    scheduledForUtc: '2026-06-25T13:00:00.000Z',
    smsEligible: true,
    globalBrakes: { send_blocked: true, emergency_stop_active: true },
    now,
  }).category,
  'globally_blocked',
)

assert.equal(
  resolveQueueDispatchTruth({
    status: 'scheduled',
    scheduledForUtc: '2026-06-25T15:00:00.000Z',
    smsEligible: true,
    campaignId: 'camp-1',
    campaignStatus: 'active',
    now,
  }).category,
  'future_window',
)

console.log('campaign-send-pipeline-proof: ok')