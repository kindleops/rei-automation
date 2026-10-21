// 8.5.20-b Phase 7 — negotiation judgment: the owner's lot example (zoning / density
// FIRST, then pass / nurture / a realistic development path) and measurable execution
// friction that never penalises legitimate closing / deposit / contract questions.
import test from 'node:test'
import assert from 'node:assert/strict'

import { assessImpossibleAsk, executionFriction } from '../../src/lib/domain/opportunity-economics/negotiation-judgment.js'
import { classifyOpportunityEconomics } from '../../src/lib/domain/opportunity-economics/classify-opportunity.js'

const NOW = Date.parse('2026-10-15T15:00:00.000Z')
const lot = { property_type: 'Vacant Land', is_vacant_land: true, building_square_feet: 0, lot_acreage: 0.25 }
const market = { completed_home_median: 360000, completed_home_source: 'fixture' }
const ask = { amount: 500000, source_message_id: 'in-1', origin: 'seller_stated' }
const run = (over) => classifyOpportunityEconomics({ now: NOW, freshness: { status: 'current' }, ask, property: lot, market, ...over })

test('the lot example: $500K ask, finished homes ~$360K — zoning / density is investigated FIRST', () => {
  const r = run({ property: { ...lot, zoning: null } })
  assert.equal(r.class, 'INVESTIGATE')
  assert.equal(r.judgment.path, 'investigate_zoning_density_first')
  assert.equal(r.judgment.steps[0], 'verify_zoning_and_entitled_density_with_the_jurisdiction')
  assert.equal(r.judgment.evidence.units_needed_at_typical_lot_share, 4, '$500K ÷ (35 % × $360K) ⇒ ~4 buildable units')
  assert.deepEqual(r.judgment.realistic_price_band, [72000, 126000])
})

test('the lot example: single-family zoning, no flexibility ⇒ PASS; with flexibility ⇒ NURTURE with a realistic (internal) band', () => {
  const pass = run({ property: { ...lot, zoning: 'R-1' } })
  assert.equal(pass.class, 'PASS')
  assert.equal(pass.judgment.path, 'pass')
  const flex = run({ property: { ...lot, zoning: 'R-1' }, facts: { motivation: { value: 'moving out of state' } }, ask_history: [{ amount: 550000 }, { amount: 500000 }] })
  assert.equal(flex.class, 'NURTURE')
  assert.ok(flex.reasons.includes('seller_flexibility_realistic_price_path'))
  assert.equal(flex.judgment.path, 'nurture_realistic_price')
  assert.deepEqual(flex.judgment.realistic_price_band, [72000, 126000])
})

test('the lot example: density-permitting zoning on enough land ⇒ a development-feasibility path for an operator, never an automated offer', () => {
  const big = run({ property: { ...lot, zoning: 'RM-20', lot_acreage: 0.5 } })
  assert.equal(big.class, 'INVESTIGATE')
  assert.equal(big.judgment.path, 'development_feasibility_review')
  assert.equal(big.judgment.operator_only, true)
  assert.ok(big.judgment.evidence.potential_units.max >= 4)
  const small = assessImpossibleAsk({ lane: 'land', economics_class: 'INVESTIGATE', ask: 500000, property: { zoning: 'RM-20', lot_square_feet: 6000 }, market })
  assert.equal(small.path, 'investigate_zoning_density_first', 'a density zone on a lot too small for the units the ask needs is still a zoning question')
  assert.equal(assessImpossibleAsk({ lane: 'land', ask: 500000, property: { zoning: 'R-1' }, market: null }).path, 'investigate')
})

test('built assets: PASS / NURTURE / NEGOTIATE paths carry their evidence', () => {
  assert.equal(assessImpossibleAsk({ lane: 'sfr', economics_class: 'PASS', ask: 600000, mao: 150000 }).path, 'pass')
  assert.equal(assessImpossibleAsk({ lane: 'sfr', economics_class: 'PASS', ask: 600000, mao: 150000, flexibility: { score: 2 } }).path, 'nurture_realistic_price')
  assert.equal(assessImpossibleAsk({ lane: 'sfr', economics_class: 'NURTURE', ask: 220000, mao: 150000 }).path, 'nurture_price_gap')
  assert.equal(assessImpossibleAsk({ lane: 'sfr', economics_class: 'NEGOTIATE', ask: 160000, mao: 150000 }).path, 'negotiate')
})

test('execution friction: legitimate closing / deposit / contract / title / proof-of-funds questions carry ZERO weight', () => {
  const legit = executionFriction({ seller_messages: [
    'How soon can you close?', 'How much earnest money deposit do you put down?', 'Can I see the contract first?', 'Which title company do you use?',
    'Can you show proof of funds?', 'Who pays closing costs?', 'Are you a real company? Is this a scam?',
  ] })
  assert.equal(legit.score, 0)
  assert.equal(legit.level, 'low')
  assert.deepEqual(legit.legitimate_questions, ['closing_costs', 'closing_timeline', 'contract_terms', 'earnest_money_or_deposit', 'proof_of_funds', 'title_or_escrow', 'who_we_are'])
  assert.equal(legit.not_penalized, true)
})

test('execution friction: measurable signals — re-trade after our offer, refused access, money up front, unresolved decision maker, title issues', () => {
  const f = executionFriction({
    ask_history: [{ amount: 180000 }, { amount: 210000 }], our_last_offer: 150000,
    seller_messages: ['No inspections, nobody goes inside.', 'Send me $2,000 upfront before we sign.'],
    facts: { identity_role: { value: 'family_member' } }, complexity: { title_issue: true, owners_count: 3 },
  })
  const codes = f.factors.map((x) => x.code).sort()
  assert.deepEqual(codes, ['decision_maker_unresolved', 'multiple_owners', 'refuses_access_or_inspection', 'retrade_ask_raised_after_our_offer', 'title_issue', 'upfront_money_demand'])
  assert.equal(f.level, 'high')
  // tone / reply speed are not inputs; a firm seller is not friction
  assert.equal(executionFriction({ seller_messages: ['My price is firm. 200k, take it or leave it.'] }).score, 0)
  // friction rides on every economics result
  const e = classifyOpportunityEconomics({ now: NOW, ask: { amount: 140000 }, property: { property_type: 'Single Family Residential', units_count: 1 }, seller_messages: ['When can you close? What deposit?'] })
  assert.equal(e.execution_friction.score, 0)
  assert.ok(e.execution_friction.legitimate_questions.includes('earnest_money_or_deposit'))
})
