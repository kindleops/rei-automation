import { describe, expect, it } from 'vitest'
import { computeScenarioOffer } from './deal-scenario-model'

/**
 * Pinned to the same production vectors as the API's
 * tests/critical/deal-decision-model.test.mjs (278477219 and 225438557,
 * engine 2.0.0 / assignment_margin_v1). If these break, the browser scenario
 * lab has drifted from the engine it claims to replay.
 */
const A = { valuation_mid: 162500, valuation_confidence: 83, repairs: 34700, max_arv_factor: 0.7, behavior_ceiling: 113800, buyer_ceiling_authoritative: false, asset_family: 'RESIDENTIAL_SINGLE', unit_count: 1, buyer_demand_score: 15, liquidity_score: 15, minimum_margin_floor: 15000, motivation_score: 39 }
const B = { valuation_mid: 298100, valuation_confidence: 77, repairs: 88500, max_arv_factor: 0.72, behavior_ceiling: 214600, buyer_ceiling_authoritative: false, asset_family: 'SMALL_MULTI', unit_count: 2, buyer_demand_score: 15, liquidity_score: 15, minimum_margin_floor: 15000, motivation_score: 42 }
const C = { ...A, valuation_mid: 1400000, repairs: 60000, behavior_ceiling: 900000, buyer_ceiling_authoritative: true, buyer_demand_score: 80, liquidity_score: 70, valuation_confidence: 55 }

describe('deal scenario model (engine replay)', () => {
  it('reproduces stored production offers', () => {
    expect(computeScenarioOffer(A)).toMatchObject({ recommended_offer: 62300, minimum_offer: 57300, expected_fee: 16800, effective_ceiling: 79100, target_margin: 15000 })
    expect(computeScenarioOffer(B)).toMatchObject({ recommended_offer: 106400, minimum_offer: 97500, expected_fee: 19700, effective_ceiling: 126100, target_margin: 16397 })
  })
  it('matches the server model on an authoritative large deal', () => {
    expect(computeScenarioOffer(C)).toMatchObject({ recommended_offer: 783500, minimum_offer: 741500, expected_fee: 116500, effective_ceiling: 900000, target_margin: 90000 })
  })
  it('floors at $0 when repairs exhaust the ceiling', () => {
    expect(computeScenarioOffer({ ...B, repairs: 250000 })).toMatchObject({ recommended_offer: 0, minimum_offer: 0, expected_fee: 0 })
  })
})
