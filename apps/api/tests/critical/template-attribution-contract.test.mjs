import test from 'node:test'
import assert from 'node:assert/strict'
import {
  reconcileAttributionCounts,
  buildAttributionRates,
  aggregatePortfolioAttribution,
  buildPortfolioInsightRail,
  detectUndeclaredPlaceholders,
} from '../../src/lib/domain/templates/template-attribution-contract.js'

test('reconcileAttributionCounts prevents positive replies without attributable replies', () => {
  const c = reconcileAttributionCounts({
    sends: 100,
    delivered: 80,
    replies: 0,
    positive_replies: 15,
    attribution_available: true,
  })
  assert.equal(c.replies, 0)
  assert.equal(c.positive_replies, 0)
})

test('reconcileAttributionCounts keeps null replies as unattributed not zero', () => {
  const c = reconcileAttributionCounts({
    sends: 50,
    delivered: 45,
    replies: null,
    positive_replies: 3,
    attribution_partial: true,
  })
  assert.equal(c.replies, null)
  assert.equal(c.positive_replies, null)
  assert.equal(c.reply_tracking_unavailable, true)
})

test('buildAttributionRates shows unattributed when reply denominator missing', () => {
  const rates = buildAttributionRates({
    sends: 10,
    delivered: 8,
    replies: null,
    positive_replies: null,
    attribution_partial: true,
  })
  assert.equal(rates.reply.value, null)
  assert.equal(rates.reply.unavailable, true)
  assert.equal(rates.positive_reply.denominator, null)
})

test('aggregatePortfolioAttribution sums only attributable reply counts', () => {
  const portfolio = aggregatePortfolioAttribution([
    { metrics: { current: { sends: 10, delivered: 8, replies: 2, positive_replies: 1 } } },
    { metrics: { current: { sends: 5, delivered: 4, replies: null, positive_replies: null } } },
  ])
  assert.equal(portfolio.replies, 2)
  assert.equal(portfolio.positive_replies, 1)
  assert.equal(portfolio.attribution_partial, true)
})

test('buildPortfolioInsightRail does not repeat same template across insights', () => {
  const row = (id, sends, replyRate, optOut, stage, deliveryDelta) => ({
    identity: { template_id: id, canonical_display_name: id },
    metrics: {
      current: { sends, delivered: sends, replies: 10, stage_advanced: stage, positive_replies: 5 },
      rates: {
        reply: { value: replyRate, numerator: 10, denominator: sends },
        positive_reply: { value: 50, numerator: 5, denominator: 10 },
        opt_out: { value: optOut, numerator: 1, denominator: sends },
      },
      comparison: { rates: { delivery: { delta_absolute: deliveryDelta } } },
    },
    data_quality: { attribution_status: 'attributed', metadata_issues: [] },
  })
  const rail = buildPortfolioInsightRail([
    row('a', 100, 12, 2, 5, -5),
    row('b', 80, 8, 6, 2, -1),
    row('c', 60, 15, 1, 1, 0),
  ])
  const named = rail.insights.filter((i) => i.display_name).map((i) => i.template_id)
  const unique = new Set(named)
  assert.equal(unique.size, named.length, 'same template must not win multiple insights')
})

test('detectUndeclaredPlaceholders ignores declared variables', () => {
  const body = 'Hi {{seller_name}}, about {{property_address}}'
  assert.deepEqual(detectUndeclaredPlaceholders(body, ['seller_name', 'property_address']), [])
})

test('detectUndeclaredPlaceholders flags unsupported placeholders', () => {
  const body = 'Hi {{seller_name}}, code {{mystery_field}}'
  assert.deepEqual(detectUndeclaredPlaceholders(body, ['seller_name']), ['mystery_field'])
})