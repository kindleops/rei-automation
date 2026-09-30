/**
 * Pipeline command: is a deal's offer ready to be spent?
 *
 * The Offers view never computes a price. These lock what it may say about
 * the engine's number:
 *   - an unpriced property is "not priced", never "authorized"
 *   - only the engine's offer-authoritative tiers can read as authorized
 *   - too few comps is a validation checkpoint even when policy would spend
 *   - the verdict the negotiation already persisted wins over a recomputation
 *   - a mis-captured seller number is flagged, not believed
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveOfferReadiness,
  isImplausibleSellerNumber,
  OFFER_COMP_COVERAGE_MIN,
} from '../../src/lib/domain/opportunity/pipeline-command-service.js'

const score = (over = {}) => ({
  decision_tier: 'AUTO_RANGE_OFFER', comp_count: 12, confidence: 88, valuation_confidence: 84,
  recommended_cash_offer: 120000, minimum_acceptable_offer: 105000, ...over,
})

test('an unpriced property is not priced, never authorized', () => {
  const r = deriveOfferReadiness({ score: null })
  assert.equal(r.state, 'not_priced')
  assert.equal(r.spendable, false)
})

test('an offer-authoritative tier with defended comps is authorized', () => {
  const r = deriveOfferReadiness({ score: score() })
  assert.equal(r.state, 'authorized')
  assert.equal(r.spendable, true)
  assert.deepEqual(r.reasons, [])
})

test('a creative-terms valuation needs validation, with the engine reason', () => {
  const r = deriveOfferReadiness({ score: score({ decision_tier: 'CREATIVE_TERMS' }) })
  assert.equal(r.state, 'needs_validation')
  assert.match(r.reasons.join(' '), /not offer-authoritative/)
})

test('thin comp coverage is a validation checkpoint even when spendable', () => {
  const r = deriveOfferReadiness({ score: score({ comp_count: OFFER_COMP_COVERAGE_MIN - 1 }), negotiation: { valuation_spendable: true } })
  assert.equal(r.spendable, true)
  assert.equal(r.thinCoverage, true)
  assert.equal(r.state, 'needs_validation')
})

test('the persisted negotiation verdict wins over the recomputation', () => {
  const r = deriveOfferReadiness({ score: score(), negotiation: { valuation_spendable: false, recommended_offer_withheld_reason: 'ask_out_of_band' } })
  assert.equal(r.state, 'needs_validation')
  assert.equal(r.source, 'negotiation')
  assert.match(r.reasons.join(' '), /outside the authorized band/)
})

test('failing engine gates are stated, not hidden', () => {
  const r = deriveOfferReadiness({ score: score({ gates: { confidence_at_least_85: false, comp_count_at_least_4: true } }) })
  assert.ok(r.reasons.some((t) => /Confidence ≥ 85/.test(t)))
})

test('a mis-captured seller number is flagged', () => {
  assert.equal(isImplausibleSellerNumber(331, 86000), true)
  assert.equal(isImplausibleSellerNumber(120, null), true)
  assert.equal(isImplausibleSellerNumber(160000, 126000), false)
  assert.equal(isImplausibleSellerNumber(null, 126000), false)
})
