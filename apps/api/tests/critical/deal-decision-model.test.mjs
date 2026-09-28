/**
 * DEAL DECISION — scenario replay + read-model builders.
 *
 * Vectors A and B are real production rows (278477219, 225438557 — computed
 * 2026-09-25 by engine 2.0.0 / assignment_margin_v1). The scenario model must
 * reproduce their stored offers to the dollar, or the scenario lab would be
 * presenting a second pricing model as the engine's. The dashboard port
 * (deal-scenario-model.ts) is pinned to these same vectors.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { computeScenarioOffer, replayStoredOffer, offerSensitivity, scenarioInputsFromScore } from '../../src/lib/domain/deal-intelligence/deal-scenario-model.js'
import { buildValuationSpectrum, compEvidenceQuality, deriveDealRisks, engineStrategies, sellerFactsWithProvenance, decisionSummary } from '../../src/lib/domain/deal-intelligence/deal-decision-service.js'

export const VECTORS = {
  A: { in: { valuation_mid: 162500, valuation_confidence: 83, repairs: 34700, max_arv_factor: 0.7, behavior_ceiling: 113800, buyer_ceiling_authoritative: false, asset_family: 'RESIDENTIAL_SINGLE', unit_count: 1, buyer_demand_score: 15, liquidity_score: 15, minimum_margin_floor: 15000, motivation_score: 39 }, out: { rec: 62300, min: 57300, fee: 16800, ceil: 79100, tm: 15000 } },
  B: { in: { valuation_mid: 298100, valuation_confidence: 77, repairs: 88500, max_arv_factor: 0.72, behavior_ceiling: 214600, buyer_ceiling_authoritative: false, asset_family: 'SMALL_MULTI', unit_count: 2, buyer_demand_score: 15, liquidity_score: 15, minimum_margin_floor: 15000, motivation_score: 42 }, out: { rec: 106400, min: 97500, fee: 19700, ceil: 126100, tm: 16397 } },
}

function scoreRow(v, stored) {
  return {
    valuation_mid: v.valuation_mid,
    valuation_confidence: v.valuation_confidence,
    recommended_cash_offer: stored.rec,
    minimum_acceptable_offer: stored.min,
    evidence: {
      subject: { units: v.unit_count },
      offer_calculation: {
        method: 'repair_adjusted_exit_ceiling_less_assignment_target',
        max_arv_factor: v.max_arv_factor,
        estimated_repairs: v.repairs,
        behavior_based_ceiling: v.behavior_ceiling,
        buyer_ceiling_authoritative: v.buyer_ceiling_authoritative,
        motivation: { score: v.motivation_score },
        effective_authorized_ceiling: stored.ceil,
        assignment_margin_policy: { minimum_margin: 15000, inputs: { asset_family: v.asset_family, valuation_confidence: v.valuation_confidence, buyer_demand_score: v.buyer_demand_score, liquidity_score: v.liquidity_score, minimum_margin_floor: v.minimum_margin_floor } },
      },
    },
  }
}

test('scenario model reproduces stored production offers to the dollar', () => {
  for (const [name, v] of Object.entries(VECTORS)) {
    const r = computeScenarioOffer(v.in)
    assert.equal(r.recommended_offer, v.out.rec, `${name} recommended`)
    assert.equal(r.minimum_offer, v.out.min, `${name} floor`)
    assert.equal(r.expected_fee, v.out.fee, `${name} fee`)
    assert.equal(r.target_margin, v.out.tm, `${name} target margin`)
  }
})

test('replay reads inputs from evidence and flags rows produced by older arithmetic', () => {
  const ok = replayStoredOffer(scoreRow(VECTORS.B.in, VECTORS.B.out))
  assert.equal(ok.replayable, true)
  assert.deepEqual(scenarioInputsFromScore(scoreRow(VECTORS.B.in, VECTORS.B.out)).asset_family, 'SMALL_MULTI')
  const stale = replayStoredOffer(scoreRow(VECTORS.B.in, { ...VECTORS.B.out, rec: 120000 }))
  assert.equal(stale.replayable, false)
  assert.equal(stale.reason, 'replay_differs_from_stored')
  assert.equal(stale.result.recommended_offer, 106400)
  assert.equal(replayStoredOffer({ evidence: {} }).reason, 'offer_calculation_missing')
})

test('sensitivity moves one input at a time and never mutates the baseline', () => {
  const inputs = { ...VECTORS.B.in }
  const rows = offerSensitivity(inputs)
  assert.deepEqual(inputs, VECTORS.B.in)
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
  assert.ok(byKey.value_down_5.delta < 0 && byKey.value_up_5.delta > 0)
  assert.ok(byKey.repairs_up_10k.delta < 0)
})

test('repairs that exhaust the ceiling produce a $0 offer, not a negative one', () => {
  const r = computeScenarioOffer({ ...VECTORS.B.in, repairs: 250000 })
  assert.equal(r.recommended_offer, 0)
  assert.equal(r.minimum_offer, 0)
})

test('comp evidence quality is measured, not scored', () => {
  const q = compEvidenceQuality({
    comp_data_status: { raw_candidate_count: 100, eligible_candidate_count: 1, selected_comp_count: 1, rejected_comp_count: 99, rejection_breakdown: { asset_type_mismatch: 80, outside_radius: 19 } },
    valuation_calculation_summary: { dispersion_ratio: 0 },
    selected_comps: [{ distance_miles: 1.03, sale_date: '2025-04-09', source: 'public_record_sold', score: 88.58, adjusted_value: 332498300 }],
  })
  assert.equal(q.selected, 1)
  assert.equal(q.rejectionBreakdown[0].label, 'Different asset type')
  assert.equal(q.sources.public_record_sold, 1)
  assert.equal(q.avgDistanceMiles, 1.03)
})

test('risks: a portfolio-sale comp and a 990× valuation are critical and named', () => {
  const score = { valuation_mid: 332498300, recommended_cash_offer: 173028700, computed_at: '2026-06-20T00:00:00Z', evidence: { subject: { units: 2 }, selected_comps: [{ address: '2000 E Stassney Ln', sale_price: 332500000 }], offer_calculation: {} } }
  const risks = deriveDealRisks({ score, props: {}, parcel: {}, records: {}, ns: null, replay: null, quality: { selected: 1, raw: 100, rejected: 99 }, thread: null, propertyId: '2136762817', ask: null, avm: 336000, now: Date.parse('2026-09-27') })
  const keys = risks.map((r) => r.key)
  assert.equal(risks[0].severity, 'critical')
  assert.ok(keys.includes('valuation_disagreement'))
  assert.ok(keys.includes('comp_price_anomaly'))
  assert.ok(keys.includes('thin_comps'))
  assert.ok(keys.includes('stale_analysis'))
})

test('risks: mis-parsed ask, withheld offer, debt above offer, passed auction', () => {
  const now = Date.parse('2026-09-27')
  const risks = deriveDealRisks({
    score: { valuation_mid: 117000, valuation_high: 130000, recommended_cash_offer: 25000, computed_at: '2026-09-20T00:00:00Z', evidence: { offer_calculation: { buyer_ceiling_authoritative: false } } },
    props: {}, parcel: { total_loan_balance: 61008, preforeclosure_status: 'In Preforeclosure', auction_date: '2025-01-06' },
    records: { liens: [{ doc_category: 'LIS PENDENS' }, { lien_type: 'hoa_lien', hoa_lien_amount: 2751.48 }], foreclosures: [{ doc_type: 'Notice of Default', auction_date: '2025-01-06' }] },
    ns: { valuation_spendable: false, recommended_offer_withheld_reason: 'valuation_tier_not_offer_authoritative', asking_price_history: [{ at: '2026-09-25T00:00:00Z', value: 331 }] },
    replay: null, quality: { selected: 5 }, thread: { is_suppressed: true }, propertyId: '296670809', ask: 331, avm: 86000, now,
  })
  const by = Object.fromEntries(risks.map((r) => [r.key, r]))
  assert.equal(by.implausible_ask.severity, 'high')
  assert.equal(by.offer_withheld.severity, 'medium')
  assert.equal(by.debt_exceeds_offer.severity, 'high')
  assert.equal(by.foreclosure.severity, 'high') // auction already passed → not "scheduled"
  assert.match(by.foreclosure.detail, /has passed/)
  assert.equal(by.liens.title, '2 recorded liens')
  assert.ok(by.ask_changed_after_analysis)
  assert.ok(by.suppressed)
  assert.equal(risks.some((r) => r.key === 'ask_above_value'), false) // a junk ask is not also "above value"
})

test('spectrum clamps an absurd marker to the edge instead of crushing the scale', () => {
  const s = buildValuationSpectrum({ low: 280000, mid: 298100, high: 320000, avm: 292000, ask: 331, recommended: 106400, floor: 97500, ceiling: 126100 })
  const ask = s.markers.find((m) => m.key === 'ask')
  assert.equal(ask.clamped, true)
  assert.ok(s.min > 331)
  assert.ok(s.band.from > 0 && s.band.to <= 1)
  assert.equal(buildValuationSpectrum({}), null)
})

test('seller facts keep provenance separate — said vs recorded vs derived', () => {
  const facts = sellerFactsWithProvenance({
    ns: { current_asking_price: 315000, initial_asking_price: 380000, occupancy: 'tenant_occupied', asking_price_history: [{ at: '2026-09-11', value: 380000 }, { at: '2026-09-25', value: 315000, extracted_text: '315K' }] },
    sellerFacts: {}, props: {}, parcel: { owner_status: 'Absentee Owner', total_loan_balance: 10011 },
    score: { evidence: { repair_estimate: { amount: 88500, source: 'property_estimated_repair_cost', confidence: 90 } } },
  })
  const occ = facts.filter((f) => f.label === 'Occupancy')
  assert.deepEqual(occ.map((f) => f.provenance).sort(), ['record', 'seller'])
  assert.equal(facts.find((f) => f.key === 'asking_price').quote, '315K')
  assert.equal(facts.find((f) => f.key === 'repairs_system').provenance, 'system')
  assert.equal(facts.find((f) => f.key === 'debt_record').provenance, 'record')
})

test('strategies are only what the engine scored; best is marked, not invented', () => {
  assert.deepEqual(engineStrategies(null), [])
  const s = engineStrategies({ best_strategy: 'SELLER_FINANCE', seller_finance_score: 75, subject_to_score: 0, lease_option_score: 18, novation_score: null, recommended_cash_offer: 0, evidence: {} })
  assert.equal(s[0].key, 'SELLER_FINANCE')
  assert.equal(s[0].isBest, true)
  assert.equal(s.some((r) => r.key === 'SUBJECT_TO'), false)
})

test('summary lines are deterministic facts from the payload', () => {
  const lines = decisionSummary({
    score: { decision_tier: 'CREATIVE_TERMS', recommended_cash_offer: 106400, minimum_acceptable_offer: 97500, valuation_mid: 298100 },
    tierReasons: ['seller_finance_is_strongest_viable_path'],
    gates: [{ label: 'Confidence ≥ 85', pass: false }, { label: '4+ qualified comps', pass: true }],
    ns: { valuation_spendable: false }, ask: 315000, replay: { replayable: true },
  })
  assert.match(lines[0], /^Creative terms — 1 hard gate not met: Confidence ≥ 85\.$/)
  assert.match(lines[1], /Seller finance is the strongest viable path/)
  assert.ok(lines.some((l) => /withholding/.test(l)))
  assert.ok(lines.some((l) => /Seller asks \$315K — \$209K above/.test(l)))
})

import { assetIntegrity, compBuyerMix } from '../../src/lib/domain/deal-intelligence/deal-decision-service.js'
import { buyerFromPurchaseInfo, enrichComp, ownerSections, parcelSections, prospectCards } from '../../src/lib/domain/deal-intelligence/deal-record-sections.js'

test('comp enrichment: asset match follows family and the engine unit band', () => {
  const subject = { propertyType: 'Multi-Family', units: 2 }
  const mf = enrichComp({ sale_price: 241000 }, { property_type: 'Multi-Family', normalized_asset_class: 'multifamily', units_count: 2, total_bedrooms: 4, total_baths: 2, building_square_feet: 1600, purchase_info: 'Sese Properties LLC · New Britain, CT · Multifamily' }, subject)
  assert.equal(mf.assetMatch, true)
  assert.equal(mf.buyerKind, 'company')
  assert.equal(mf.buyerLabel, 'Sese Properties LLC')
  assert.equal(mf.ppsf, 151)
  const sfr = enrichComp({ sale_price: 250000 }, { property_type: 'Single Family', normalized_asset_class: 'single_family', units_count: 1 }, subject)
  assert.equal(sfr.assetMatch, false)
  const big = enrichComp({ sale_price: 2e6 }, { property_type: 'Apartment', normalized_asset_class: 'apartment', units_count: 12 }, subject)
  assert.equal(big.assetMatch, false) // 12 units vs 2 is outside 0.35–2.75
  const integrity = assetIntegrity([{ ...mf, address: 'a' }, { ...sfr, address: 'b' }], subject)
  assert.equal(integrity.matched, 1)
  assert.equal(integrity.mismatched[0].address, 'b')
})

test('individual buyers are never named; companies are', () => {
  assert.deepEqual(buyerFromPurchaseInfo('John Q Smith · Miami, FL · Single Family'), { kind: 'individual', label: 'Individual' })
  assert.equal(buyerFromPurchaseInfo('Tcs Holdings LLC · East Berlin, CT').kind, 'company')
  assert.equal(buyerFromPurchaseInfo(null).kind, 'unknown')
})

test('comp buyer mix splits company vs individual and MLS vs public record', () => {
  const mix = compBuyerMix([
    { buyerKind: 'company', salePrice: 300000, saleSource: 'Public Record Sold', ppsf: 150 },
    { buyerKind: 'company', salePrice: 320000, saleSource: 'MLS Sold', ppsf: 160 },
    { buyerKind: 'individual', salePrice: 200000, saleSource: 'Public Record Sold', ppsf: 120 },
  ])
  assert.equal(mix.company, 2)
  assert.equal(mix.individual, 1)
  assert.equal(mix.mls, 1)
  assert.equal(mix.mlsMedian, 320000)
})

test('record sections: populated fields only, grouped, no ids or legacy fields', () => {
  const sections = parcelSections({ property_type: 'Single Family', bedrooms: 4, building_sqft: 2372, estimated_value: 677000, total_loan_balance: 0, apn: '74-42', row_hash: 'x', structured_motivation_score: 88, owner_name: 'John' })
  const titles = sections.map((s) => s.title)
  assert.ok(titles.includes('Structure') && titles.includes('Value & equity') && titles.includes('Ownership'))
  const all = sections.flatMap((s) => s.fields.map((f) => f.label))
  assert.ok(!all.some((l) => /hash/i.test(l)))
  assert.ok(!all.some((l) => /Loan balance|Open balance/.test(l))) // $0 debt is "not recorded"
  assert.equal(ownerSections({ display_name: 'David Larson', property_count: 1, row_hash: 'x' })[0].fields[0].value, 'David Larson')
  assert.equal(prospectCards([{ prospect_id: 'p1', full_name: 'A B', likely_owner: true, likely_renting: true }])[0].fields.find((f) => f.label === 'Tenure').value, 'Unclear — flagged owner and renter')
})
