/**
 * ANALYTICS performance — the rules that decide what the operator is told:
 * period windows, comparison guards, material-change thresholds, stage flow
 * and bottleneck semantics, and campaign hygiene.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildFlow, compareCount, compareRate, isTestCampaign, METRICS, resolvePeriod, storyOfPeriod, whatChanged,
} from '../../src/lib/domain/analytics/analytics-performance-service.js'

const DAY = 86_400_000
const NOW = Date.parse('2026-09-28T12:00:00Z')

test('periods: prior period is the equal-length span immediately before', () => {
  const p = resolvePeriod({ range: '30d', now: NOW })
  assert.equal(Date.parse(p.end) - Date.parse(p.start), 30 * DAY)
  assert.equal(p.prevEnd, p.start)
  assert.equal(Date.parse(p.prevEnd) - Date.parse(p.prevStart), 30 * DAY)
  assert.equal(p.bucket, 'day')
  assert.equal(resolvePeriod({ range: '90d', now: NOW }).bucket, 'week')
  assert.equal(resolvePeriod({ range: 'today', start: '2026-09-28T05:00:00Z', now: NOW }).start, '2026-09-28T05:00:00.000Z')
  assert.equal(resolvePeriod({ range: 'bogus', now: NOW }).range, '30d')
})

test('counts: percentage only when the base can carry one', () => {
  assert.deepEqual(compareCount(12, 3), { cur: 12, prev: 3, delta: 9, pct: null, basis: 'absolute' })
  assert.equal(compareCount(60, 15).pct, 300)
  assert.equal(compareCount(0, 0).pct, null)
})

test('rates: point change only with meaningful denominators on both sides', () => {
  assert.equal(compareRate(60, 376, 15, 145).pp, 5.6)
  const small = compareRate(5, 12, 0, 0)
  assert.equal(small.pp, null)
  assert.equal(small.reliable, false)
})

test('what changed: only material movement, toned by what the metric means', () => {
  const ch = whatChanged(
    { replied_conversations: 60, opt_out_conversations: 9, failed: 160, delivered_conversations: 376, replied: 0, sent: 578, delivered: 417 },
    { replied_conversations: 15, opt_out_conversations: 0, failed: 20, delivered_conversations: 145, sent: 178, delivered: 155 },
    [],
  )
  const byKey = Object.fromEntries(ch.map((c) => [c.key, c]))
  assert.equal(byKey.replied_conversations.tone, 'good')
  assert.equal(byKey.failed.tone, 'bad')
  assert.equal(byKey.delivered_conversations.tone, 'neutral') // volume is not a verdict
  assert.equal(byKey.delivery_rate.tone, 'bad')
  assert.ok(!byKey.opt_out_conversations) // 0 → 9 is below the materiality floor
  assert.equal(whatChanged({ replied_conversations: 11 }, { replied_conversations: 10 }).length, 0)
})

test('flow: entries and dwell come from transitions; bottleneck needs aging live deals, not volume', () => {
  const t = (from, to, at, prevAt) => ({ type: 'stage_transition', per: 'cur', from, to, at, prev_at: prevAt, opportunity_id: `${from}-${to}-${at}` })
  const at = (h) => new Date(NOW - h * 3_600_000).toISOString()
  const transitions = [t('offer_interest', 'asking_price', at(10), at(40)), t('asking_price', 'offer', at(5), at(9)), t('asking_price', 'offer', at(4), at(20)), t('asking_price', 'offer', at(3), at(5))]
  const live = (id, stage, days) => ({ id, stage, stage_entered_at: new Date(NOW - days * DAY).toISOString(), last_activity_at: new Date(NOW - DAY).toISOString() })
  const active = [live('a', 'offer', 16), live('b', 'offer', 12), live('c', 'offer', 2), ...Array.from({ length: 9 }, (_, i) => live(`d${i}`, 'offer_interest', 3))]
  const f = buildFlow(transitions, active, NOW)
  const byCode = Object.fromEntries(f.stages.map((s) => [s.code, s]))
  assert.equal(byCode.offer.entered, 3)
  assert.equal(byCode.asking_price.medianHoursInStage, 4)
  assert.equal(f.bottleneck.code, 'offer') // 2 of 3 past 7 days — not offer_interest's 9 fresh rows
  assert.deepEqual(f.bottleneck.ids.sort(), ['a', 'b'])
})

test('story is counts, and says plainly when nothing reached offers/contracts/closings', () => {
  const s = storyOfPeriod({ totals: { cur: { delivered_conversations: 376, replied_conversations: 60 } }, flow: { advancements: 15, bottleneck: null }, markets: [{ name: 'Miami, FL', cur: { replied_conversations: 39 } }], range: '30d' })
  assert.deepEqual(s.lines.map((l) => l.text), ['376 sellers reached', '60 replied', '15 stage advancements'])
  assert.ok(s.notes.some((n) => n.startsWith('Miami, FL produced the most seller replies (39)')))
  assert.ok(s.notes.some((n) => /No offers, contracts or closings/.test(n)))
})

test('metric contracts are declared for every surfaced rate', () => {
  for (const k of ['reply_rate', 'delivery_rate', 'opt_out_rate']) {
    assert.ok(METRICS[k].numerator && METRICS[k].denominator && METRICS[k].definition, k)
  }
  assert.equal(METRICS.delivered_conversations.good, 'neutral')
  assert.equal(METRICS.opt_out_conversations.good, 'down')
})

test('synthetic / certification campaigns are flagged, the live Miami campaign is not', () => {
  for (const n of ['ZZ-SYNTHETIC-CCML1C-1789', 'ACQ S1 LIVE PROOF 2', 'Certification canary']) assert.equal(isTestCampaign(n), true, n)
  assert.equal(isTestCampaign('Miami - Test Campaign'), false)
  assert.equal(isTestCampaign('Los Angeles- Multifamily'), false)
})
