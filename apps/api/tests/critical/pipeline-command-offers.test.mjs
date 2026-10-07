/**
 * Pipeline command: is a deal's offer ready to be spent?
 *
 * The Offers view never computes a price. These lock what it may say about
 * the engine's number:
 *   - an unpriced property is "not priced", never "authorized"
 *   - only the engine's offer-authoritative tiers can read as authorized
 *   - too few comps is a caution, not a gate the engine does not have
 *   - the verdict the negotiation persisted wins only while it is a real,
 *     current verdict (a turn that skipped the engine writes valuation_absent)
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
  // valuation_mid: every real score row carries it; the offer sanity guard fails closed without it.
  valuation_mid: 200000, recommended_cash_offer: 120000, minimum_acceptable_offer: 105000, ...over,
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

test('thin comp coverage is stated as a caution; the engine (not the read model) decides spendability', () => {
  const r = deriveOfferReadiness({ score: score({ comp_count: OFFER_COMP_COVERAGE_MIN - 1 }), negotiation: { valuation_spendable: true } })
  assert.equal(r.spendable, true)
  assert.equal(r.thinCoverage, true)
  assert.equal(r.state, 'authorized')
  assert.match(r.reasons.join(' '), /Thin comp coverage/)
})

test('a turn that never ran the engine does not erase an existing valuation (persisted valuation_absent is ignored)', () => {
  // 0 Internal Canary Way / 606 S A St pattern: AUTO_HARD_OFFER score, then an
  // "unclear" turn persisted valuation_spendable=false, reason valuation_absent.
  const r = deriveOfferReadiness({ score: score({ decision_tier: 'AUTO_HARD_OFFER' }), negotiation: { valuation_spendable: false, valuation_non_spendable_reason: 'valuation_absent', updated_at: '2026-09-27T16:17:01Z' } })
  assert.equal(r.persistedIgnored, 'turn_without_engine_run')
  assert.equal(r.source, 'engine_row')
  assert.equal(r.state, 'authorized')
})

test('a score computed after the persisted verdict wins over it', () => {
  const r = deriveOfferReadiness({
    score: score({ computed_at: '2026-09-30T20:20:46Z' }),
    negotiation: { valuation_spendable: false, valuation_non_spendable_reason: 'valuation_tier_not_offer_authoritative', updated_at: '2026-09-12T18:56:40Z' },
  })
  assert.equal(r.persistedIgnored, 'older_than_score')
  assert.equal(r.state, 'authorized')
})

test('the current non-spendable reason is preferred over the carried-forward withheld reason', () => {
  const r = deriveOfferReadiness({
    score: score({ decision_tier: 'CREATIVE_TERMS' }),
    negotiation: { valuation_spendable: false, valuation_non_spendable_reason: 'valuation_tier_not_offer_authoritative', recommended_offer_withheld_reason: 'valuation_low_comp_count_without_contamination_defense' },
  })
  assert.equal(r.reason, 'valuation_tier_not_offer_authoritative')
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
