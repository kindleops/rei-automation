import test from 'node:test'
import assert from 'node:assert/strict'
import { kpiRowToMetrics, buildRate } from '../../src/lib/domain/templates/template-intelligence-contract.js'
import { buildStageFunnel, priorWindowLabel, senderDiversityFromBucket } from '../../src/lib/domain/templates/template-intelligence-aggregates.js'

test('kpiRowToMetrics uses delivered denominator for reply rate', () => {
  const m = kpiRowToMetrics({ sends: 100, delivered: 80, inbound_replies: 8 })
  assert.equal(m.rates.reply.denominator, 80)
  assert.equal(m.rates.reply.value, 10)
})

test('kpiRowToMetrics maps stage_advanced_count', () => {
  const m = kpiRowToMetrics({ inbound_replies: 5, stage_advanced_count: 2 })
  assert.equal(m.stage_advanced, 2)
  assert.equal(m.rates.stage_advancement.numerator, 2)
  assert.equal(m.rates.stage_advancement.denominator, 5)
})

test('buildStageFunnel is stage-relative for S3', () => {
  const funnel = buildStageFunnel('S3', { delivered: 10, replies: 4, price_captured: 2, stage_advanced: 1 })
  const keys = funnel.map((s) => s.key)
  assert.ok(keys.includes('asking_price'))
  assert.ok(!keys.includes('ownership_confirmed'))
})

test('priorWindowLabel clarifies delta basis', () => {
  assert.match(priorWindowLabel('7d'), /previous/)
})

test('senderDiversityFromBucket warns on concentration', () => {
  const senders = new Map([['+15551234', 80], ['+15559876', 20]])
  const div = senderDiversityFromBucket({ senders })
  assert.equal(div.distinct, 2)
  assert.equal(div.warning, true)
})

test('buildRate returns null value for zero denominator', () => {
  const r = buildRate(1, 0)
  assert.equal(r.value, null)
})