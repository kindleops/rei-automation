// 8.5.19 Phase 9 — opportunity economics over a fixture set (pure; no network, no DB).
// Lot example, MF 2-4, MF 5+ per door, insufficient data, strong SFR HOT, absurd ask,
// stale decision, protected attributes, responsiveness/assertiveness not inputs.
import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyOpportunityEconomics, ECONOMICS_CLASSES, stripProtectedAttributes } from '../../src/lib/domain/opportunity-economics/classify-opportunity.js'
import { askFromLedger, assessOpportunityEconomics } from '../../src/lib/domain/opportunity-economics/economics-service.js'
import { buildFactLedger, factSummary } from '../../src/lib/domain/conversation-ai/facts.js'

const NOW = Date.parse('2026-10-15T15:00:00.000Z')
const COMPUTED = '2026-10-10T12:00:00.000Z'

/** A property_acquisition_scores row shaped like the engine writes it. */
function score({ mid, mao, offer, conf = 70, comps = 8, tier = 'AUTO_HARD_OFFER', demand = 70, ceilingMid = null, repairs = 0, avm = null, low = null, high = null, assetType = 'single_family', extra = {} }) {
  return {
    id: 'pas-1', property_id: 'p1', valuation_mid: mid, valuation_low: low ?? Math.round(mid * 0.92), valuation_high: high ?? Math.round(mid * 1.08), valuation_confidence: conf, comp_count: comps, confidence: conf,
    decision_tier: tier, recommended_cash_offer: offer, minimum_acceptable_offer: offer, investor_ceiling_mid: ceilingMid ?? mao, estimated_repairs: repairs, buyer_demand_score: demand, liquidity_score: 60, expected_assignment_fee: 15000,
    computed_at: COMPUTED,
    evidence: { immutable_snapshot_id: 'snap-1', offer_calculation: { effective_authorized_ceiling: mao }, subject: { asset_type: assetType }, decision_inputs: { inputs: { property: { estimated_value: avm ?? mid } } } },
    ...extra,
  }
}
const CURRENT = { status: 'current', reason: 'inputs_unchanged' }
const sfr = { property_type: 'Single Family Residential', units_count: 1, estimated_value: 200000 }
const run = (over) => classifyOpportunityEconomics({ now: NOW, freshness: CURRENT, ...over })

test('strong SFR: ask under the authoritative MAO, credible current valuation, strong demand → HOT', () => {
  const r = run({ ask: { amount: 140000, source_message_id: 'in-1', origin: 'seller_stated' }, property: sfr, valuation: score({ mid: 200000, mao: 150000, offer: 140000 }) })
  assert.equal(r.class, 'HOT')
  assert.ok(r.reasons.includes('ask_at_or_below_authoritative_mao'))
  assert.equal(r.metrics.mao, 150000)
  assert.equal(r.metrics.lane, 'sfr')
  assert.equal(r.metrics.buyer_demand.level, 'strong')
  assert.equal(r.uncertainty.level, 'low')
  assert.equal(r.metrics.acquisition_costs.closing_at_ask, 2800)
  assert.ok(r.evidence.engines.includes('deal-economics-gate.assessDealEconomics'), 'reuses the existing lane engine')
})

test('HOT needs positive evidence: unknown buyer demand or a stale decision never default to HOT', () => {
  const v = score({ mid: 200000, mao: 150000, offer: 140000, demand: null })
  const unknownDemand = run({ ask: { amount: 140000 }, property: sfr, valuation: v })
  assert.equal(unknownDemand.class, 'NEGOTIATE')
  assert.ok(unknownDemand.uncertainty.missing.includes('buyer_demand'))
  // the engine's no-purchases fallback (15/15) is UNKNOWN demand, not weak; unclassified area buyers likewise
  const fb = score({ mid: 200000, mao: 150000, offer: 140000, demand: 15, extra: { liquidity_score: 15 } })
  fb.evidence.investor_ceiling_summary = { method: 'valuation_discount_fallback', reason: 'no_eligible_buyer_purchase_events', sample_purchases: [] }
  const fallback = run({ ask: { amount: 140000 }, property: sfr, valuation: fb, market: { investor_count: 0, unclassified_count: 102, priced_sales: 127 } })
  assert.equal(fallback.metrics.buyer_demand.level, 'unknown')
  assert.ok(fallback.metrics.buyer_demand.evidence.includes('engine_demand_fallback_no_buyer_purchases'))
  assert.equal(fallback.class, 'NEGOTIATE')
  const investors = run({ ask: { amount: 140000 }, property: sfr, valuation: fb, market: { investor_count: 6, unclassified_count: 40, priced_sales: 60 } })
  assert.equal(investors.metrics.buyer_demand.level, 'moderate')
  assert.equal(investors.class, 'HOT', 'area investor purchases are positive demand evidence')
  const stale = run({ ask: { amount: 140000 }, property: sfr, valuation: score({ mid: 200000, mao: 150000, offer: 140000 }), freshness: { status: 'decision_engine_stale_for_current_state', reason: 'material_inputs_changed' } })
  assert.equal(stale.class, 'INVESTIGATE')
  assert.ok(stale.uncertainty.missing.includes('current_decision_engine_run'))
})

test('the lot example: $500K ask on a raw residential lot where finished homes sell ~$360K never becomes HOT', () => {
  const lot = { property_type: 'Vacant Land', is_vacant_land: true, building_square_feet: 0, lot_acreage: 0.25 }
  const market = { completed_home_median: 360000, completed_home_source: 'fixture' }
  const ask = { amount: 500000, source_message_id: 'in-1', origin: 'seller_stated' }
  // single-family zoning, ordinary lot: the ask exceeds what a FINISHED home sells for → PASS
  const sf = run({ ask, property: { ...lot, zoning: 'R-1' }, market })
  assert.equal(sf.class, 'PASS')
  assert.equal(sf.metrics.lane, 'land')
  assert.ok(sf.reasons.includes('land_ask_at_or_above_finished_home_value'))
  assert.equal(sf.evidence.land.ask_to_finished_home, 1.389)
  // zoning unknown → INVESTIGATE (check zoning first)
  const unknown = run({ ask, property: lot, market })
  assert.equal(unknown.class, 'INVESTIGATE')
  assert.ok(unknown.uncertainty.missing.includes('zoning'))
  // multifamily / development zoning → INVESTIGATE (development potential needs land analysis)
  const dev = run({ ask, property: { ...lot, zoning: 'RM-3' }, market })
  assert.equal(dev.class, 'INVESTIGATE')
  assert.ok(dev.reasons.includes('development_potential_needs_land_analysis'))
  // no finished-home reference at all → INVESTIGATE
  assert.equal(run({ ask, property: { ...lot, zoning: 'R-1' } }).class, 'INVESTIGATE')
  // a land valuation row (even AUTO tier) never makes a lot HOT
  const withScore = run({ ask: { amount: 30000 }, property: { ...lot, zoning: 'R-1' }, market, valuation: score({ mid: 60000, mao: 45000, offer: 40000, assetType: 'land' }) })
  assert.notEqual(withScore.class, 'HOT')
  for (const r of [sf, unknown, dev, withScore]) assert.ok(ECONOMICS_CLASSES.includes(r.class))
})

test('MF 2-4 (same-unit comps lane): ask 13% over the MAO → NEGOTIATE; 40% over → NURTURE', () => {
  const tri = { property_type: 'Triplex', units_count: 3, estimated_value: 420000 }
  const v = score({ mid: 420000, mao: 300000, offer: 285000, conf: 62, comps: 6, tier: 'AUTO_RANGE_OFFER', demand: 55, assetType: 'triplex' })
  const r = run({ ask: { amount: 340000 }, property: tri, valuation: v })
  assert.equal(r.metrics.lane, 'mf_2_4')
  assert.equal(r.class, 'NEGOTIATE')
  assert.ok(r.reasons.includes('ask_within_15pct_of_mao'))
  assert.equal(r.metrics.price_gap.vs_mao_pct, 0.133)
  assert.ok(r.metrics.execution.factors.includes('small_multifamily_rent_verification'))
  const far = run({ ask: { amount: 420000 }, property: tri, valuation: v })
  assert.equal(far.class, 'NURTURE')
  assert.ok(far.reasons.includes('price_gap_above_authority'))
})

test('MF 5+ is priced per door: a per-door ask is converted with the canonical unit count', () => {
  const apt = { property_type: 'Apartment', units_count: 12, estimated_value: 900000 }
  const v = score({ mid: 900000, mao: 640000, offer: 610000, conf: 66, comps: 7, tier: 'AUTO_RANGE_OFFER', demand: 65, assetType: 'multifamily' })
  const r = run({ ask: { amount: 55000, price_type: 'per_unit' }, property: apt, valuation: v })
  assert.equal(r.metrics.lane, 'mf_5_plus')
  assert.equal(r.metrics.ask, 660000)
  assert.equal(r.class, 'NEGOTIATE')
  assert.ok(r.metrics.execution.factors.includes('income_asset_underwriting'))
})

test('insufficient data → INVESTIGATE, never a default HOT', () => {
  const noAsk = run({ ask: null, property: sfr, valuation: score({ mid: 200000, mao: 150000, offer: 140000 }) })
  assert.equal(noAsk.class, 'INVESTIGATE')
  assert.ok(noAsk.uncertainty.missing.includes('asking_price'))
  const noValuation = run({ ask: { amount: 150000 }, property: sfr, valuation: null, freshness: { status: 'decision_engine_not_run_for_current_state' } })
  assert.equal(noValuation.class, 'INVESTIGATE')
  assert.ok(noValuation.uncertainty.missing.includes('decision_engine_run'))
  assert.equal(noValuation.uncertainty.level, 'high')
  const thin = run({ ask: { amount: 150000 }, property: sfr, valuation: score({ mid: 200000, mao: 150000, offer: 140000, conf: 35, comps: 2 }) })
  assert.equal(thin.class, 'INVESTIGATE')
  assert.ok(thin.reasons.includes('valuation_low_confidence'))
  const unknownLane = run({ ask: { amount: 150000 }, property: {}, valuation: score({ mid: 200000, mao: 150000, offer: 140000, assetType: null }) })
  assert.equal(unknownLane.class, 'INVESTIGATE')
  const year = run({ ask: { amount: 2024 }, property: sfr, valuation: score({ mid: 200000, mao: 150000, offer: 140000 }) })
  assert.equal(year.class, 'INVESTIGATE')
  assert.ok(year.reasons.some((x) => x.startsWith('ask_not_a_property_price')))
})

test('an absurd ask on a credible value is a price gap (NURTURE, never Priority); above 1.5x a retail ARV is PASS', () => {
  const v = score({ mid: 174000, mao: 120000, offer: 110000 })
  const absurd = run({ ask: { amount: 3000000 }, property: { ...sfr, estimated_value: 174000 }, valuation: v })
  assert.equal(absurd.class, 'NURTURE')
  assert.ok(absurd.reasons.includes('price_gap:above_far_band'))
  const overArv = run({ ask: { amount: 400000 }, property: { ...sfr, estimated_value: 174000, arv_estimate: 240000 }, valuation: v })
  assert.equal(overArv.class, 'PASS')
  assert.ok(overArv.reasons.includes('ask_above_1_5x_retail_arv'))
  assert.equal(overArv.metrics.realistic_value.retail_arv_lane, 240000, 'the MLS ARV is its own lane, reported separately')
})

test('assertiveness and responsiveness are not inputs; protected classes are stripped and never change the class', () => {
  const base = { ask: { amount: 140000 }, property: sfr, valuation: score({ mid: 200000, mao: 150000, offer: 140000 }) }
  const a = run(base)
  const b = run({ ...base, responsiveness: { median_reply_minutes: 2, replies: 14 }, facts: { seller_interest: { value: 'interested' } }, seller: { age: 81, marital_status: 'widowed', race: 'x', familial_status: 'children' } })
  assert.equal(a.class, b.class)
  assert.deepEqual(a.metrics.price_gap, b.metrics.price_gap)
  assert.equal(b.ignored.responsiveness, true)
  assert.deepEqual(b.ignored.protected_attributes_stripped.sort(), ['seller.age', 'seller.familial_status', 'seller.marital_status', 'seller.race'])
  const s = stripProtectedAttributes({ facts: { motivation: { value: 'moving' }, age: 70 } })
  assert.deepEqual(s.value, { facts: { motivation: { value: 'moving' } } })
})

test('seller flexibility comes from the fact ledger: a lowered ask turns a 25% gap into NEGOTIATE', () => {
  const v = score({ mid: 200000, mao: 150000, offer: 140000 })
  const facts = { motivation: { value: 'relocating' } }
  const flex = run({ ask: { amount: 185000 }, ask_history: [{ amount: 200000 }, { amount: 185000 }], property: sfr, valuation: v, facts })
  assert.equal(flex.class, 'NEGOTIATE')
  assert.ok(flex.metrics.seller_flexibility.signals.includes('ask_lowered_in_conversation'))
  const rigid = run({ ask: { amount: 185000 }, property: sfr, valuation: v })
  assert.equal(rigid.class, 'NURTURE')
})

test('the service reads the fact ledger (latest-wins correction) and classifies read-only', async () => {
  const ledger = buildFactLedger({ inbound: [
    { id: 'm1', body: 'I want 200k for it', at: '2026-10-14T10:00:00Z' },
    { id: 'm2', body: 'actually I could do 145k', at: '2026-10-14T11:00:00Z' },
  ], now: '2026-10-15T00:00:00Z' })
  const { ask, history } = askFromLedger(ledger)
  assert.equal(ask.amount, 145000)
  assert.equal(ask.source_message_id, 'm2')
  assert.deepEqual(history.map((h) => h.amount), [200000, 145000])
  assert.ok(factSummary(ledger).asking_price)
  const calls = []
  const fake = {
    from(table) {
      const q = { _t: table, select() { calls.push(['select', table]); return q }, eq() { return q }, limit() { return Promise.resolve({ data: table === 'properties' ? [{ property_id: 'p1', ...sfr }] : [score({ mid: 200000, mao: 150000, offer: 140000 })], error: null }) }, insert() { throw new Error('no writes') }, update() { throw new Error('no writes') }, delete() { throw new Error('no writes') } }
      return q
    },
  }
  const r = await assessOpportunityEconomics({ supabase: fake, property_id: 'p1', ledger, now: new Date(NOW) })
  assert.ok(ECONOMICS_CLASSES.includes(r.class))
  // the fixture row has no decision-input fingerprint → not provably current → never HOT
  assert.equal(r.class, 'INVESTIGATE')
  assert.equal(r.evidence.freshness.status, 'decision_engine_stale_for_current_state')
  assert.deepEqual(calls.map((c) => c[1]).sort(), ['properties', 'property_acquisition_scores'])
})
