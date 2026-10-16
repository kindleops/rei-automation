// 8.5.21-b — owner decision (2): the SFR repair conflict. The engine's 0.70 × as-is − repairs deducts
// repairs from an AS-IS basis (repair-differential-adjusted sold comps), the owner lane is LLC investor
// cluster − 13 %, no repairs. ONE authoritative SFR calculation (sfrLaneCeiling.js) behind the OFF-by-
// default ACQUISITION_SFR_LANE_CEILING_V1: flag off ⇒ the engine is byte-for-byte unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'

import { calculateAcquisitionDecision } from '../../src/lib/acquisition/acquisitionDecisionEngine.js'
import { sfrLaneCeiling, traceSfrFormulas, isSfrSubject, sfrLaneEnabled, SFR_LANE_FLAG } from '../../src/lib/acquisition/sfrLaneCeiling.js'
import { laneValuation } from '../../src/lib/acquisition/laneValuation.js'

const NOW = new Date('2026-06-12T12:00:00.000Z')
const SUBJECT = {
  property_id: '12345678', property_address_full: '100 Main St, Dallas, TX 75201', property_address_city: 'Dallas', property_address_state: 'TX', property_address_zip: '75201',
  market: 'Dallas, TX', latitude: 32.7767, longitude: -96.797, normalized_asset_class: 'single_family', property_type: 'Single Family', property_class: 'Residential',
  total_bedrooms: 3, total_baths: 2, building_square_feet: 1800, units_count: 1, year_built: 1988, effective_year_built: 2008, lot_square_feet: 7500,
  building_condition: 'Average', estimated_repair_cost: 32_000, estimated_value: 360_000, equity_percent: 62, ownership_years: 14,
}
const comp = (i, price) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, property_id: `sold-${i}`, property_address_full: `${100 + i} Main St, Dallas, TX 75201`, property_address_city: 'Dallas', property_address_state: 'TX', property_address_zip: '75201', market: 'Dallas, TX', latitude: 32.7767 + i * 0.001, longitude: -96.797 + i * 0.001, normalized_asset_class: 'single_family', property_type: 'Single Family', property_class: 'Residential', total_bedrooms: 3, total_baths: 2, building_square_feet: 1760 + i * 12, units_count: 1, year_built: 1986 + i, effective_year_built: 2006 + i, lot_square_feet: 7300 + i * 50, building_condition: 'Average', estimated_repair_cost: 28_000, mls_sold_price: price, mls_sold_date: `2026-0${Math.min(i, 5)}-15`, source: 'buyer_comp_properties_v2' })
const purchase = (i, price) => ({ id: `purchase-${i}`, buyer_key: `buyer-${i % 5}`, buyer_name: `Buyer ${i % 5}`, buyer_type: i % 2 ? 'Investor' : 'Corporate', is_corporate_buyer: i % 2 === 0, purchase_date: `2026-0${Math.min(i, 5)}-01`, purchase_price: price, property_address_full: `${200 + i} Main St, Dallas, TX 75201`, property_city: 'Dallas', property_state: 'TX', property_zip: '75201', market: 'Dallas, TX', latitude: 32.77 + i * 0.002, longitude: -96.79 + i * 0.002, normalized_asset_class: 'single_family', property_type: 'Single Family', beds: 3, baths: 2, sqft: 1750 + i * 10, units_count: 1, year_built: 1990, likely_strategy: 'rental investor' })
const COMPS = [comp(1, 330_000), comp(2, 338_000), comp(3, 342_000), comp(4, 348_000), comp(5, 355_000), comp(6, 362_000)]
const PURCHASES = Array.from({ length: 12 }, (_, i) => purchase(i + 1, 248_000 + i * 4_000))
const run = (o = {}) => calculateAcquisitionDecision({ subject: SUBJECT, comps: COMPS, buyerPurchases: PURCHASES, now: NOW, v3Enabled: false, ...o })

test('flag OFF by default and the engine is unchanged (same output with the flag explicitly off)', () => {
  assert.equal(sfrLaneEnabled({}), false)
  assert.equal(sfrLaneEnabled({ [SFR_LANE_FLAG]: '1' }), true)
  const a = run()
  const b = run({ sfrLaneCeilingV1: false })
  assert.deepEqual([a.offer.recommended_cash_offer, a.evidence.offer_calculation], [b.offer.recommended_cash_offer, b.evidence.offer_calculation])
  assert.ok(a.offer.recommended_cash_offer > 0)
  assert.equal(a.evidence.offer_calculation.method, 'repair_adjusted_exit_ceiling_less_assignment_target')
  assert.equal(a.evidence.offer_calculation.sfr_lane, undefined)
})

test('the traced conflict: the current ceiling deducts repairs from an as-is basis (the comps are already repair-differential adjusted)', () => {
  const d = run()
  const oc = d.evidence.offer_calculation
  const V = d.valuation.mid
  assert.equal(oc.valuation_based_ceiling, Math.round(Math.max(0, V * 0.7 - 32_000) / 100) * 100)
  assert.ok(d.evidence.selected_comps.every((c) => (c.price_adjustments || []).some((x) => x.basis === 'repair_difference')), 'every comp already carries the repair differential')
  const t = traceSfrFormulas({ valuation_mid: V, estimated_repairs: 32_000, investor_ceiling_mid: oc.behavior_based_ceiling, icm: 'weighted_nearby_investor_purchase_quantiles', evidence: { offer_calculation: oc } }, { cluster_authoritative: true })
  assert.equal(t.current_engine.double_deduction_usd, 32_000)
  assert.equal(t.current_engine.repairs_already_in_as_is_basis, true)
  assert.equal(t.owner_lane.repairs_applied, 0)
  // the lane is a DIFFERENT basis (the investor cluster), not "current + repairs": here investors pay
  // well under the as-is value, so the lane MAO lands close to the current ceiling for a different reason
  assert.equal(t.owner_lane.mao, Math.floor((Math.min(t.owner_lane.investor_cluster_mid, V) * 0.87) / 100) * 100)
})

test('flag ON (SFR): MAO = floor(0.87 × min(authoritative investor cluster, as-is)) with NO repairs and NO second margin deduction; the offer never exceeds it', () => {
  const off = run()
  const on = run({ sfrLaneCeilingV1: true })
  const oc = on.evidence.offer_calculation
  assert.equal(oc.method, 'sfr_llc_investor_cluster_less_13pct')
  assert.equal(oc.repairs_deducted, 0)
  const lane = oc.sfr_lane
  if (lane.mao != null) {
    assert.equal(lane.basis, Math.min(lane.investor_cluster_mid, lane.as_is_value))
    assert.equal(lane.mao, Math.floor((lane.basis * 0.87) / 100) * 100)
    assert.equal(oc.effective_authorized_ceiling, lane.mao)
    assert.ok(on.offer.recommended_cash_offer > 0 && on.offer.recommended_cash_offer <= lane.mao)
    assert.ok(lane.assignment_margin_at_mao >= lane.protected_margin, 'the 13 % spread carries the margin; protected margin respected')
  } else {
    assert.equal(oc.effective_authorized_ceiling, 0, 'no authoritative cluster ⇒ no MAO (review), never a guess')
    assert.equal(on.offer.recommended_cash_offer, null)
  }
  assert.deepEqual(oc.replaced_formula.valuation_based_ceiling, off.evidence.offer_calculation.valuation_based_ceiling, 'the replaced formula is recorded for audit')
})

test('lane function: cluster above the as-is value is capped; a non-authoritative cluster or none ⇒ MAO null; protected margin floor; ARV lane only with a sourced retail ARV (repairs only there)', () => {
  const capped = sfrLaneCeiling({ as_is_value: 200_000, investor_cluster_mid: 215_000, cluster_authoritative: true, protected_margin: 15_000 })
  assert.deepEqual([capped.basis, capped.basis_clamped_to_as_is, capped.mao, capped.repairs_applied], [200_000, true, 174_000, 0])
  assert.deepEqual([sfrLaneCeiling({ as_is_value: 206_000, investor_cluster_mid: 931_600, cluster_authoritative: true }).mao, sfrLaneCeiling({ as_is_value: 206_000, investor_cluster_mid: 931_600, cluster_authoritative: true }).reason], [null, 'investor_cluster_above_as_is_value_review'], 'a contaminated cluster is review, never clamp-to-as-is')
  assert.equal(sfrLaneCeiling({ as_is_value: 200_000, investor_cluster_mid: 180_000, cluster_authoritative: false }).mao, null)
  assert.equal(sfrLaneCeiling({ as_is_value: 200_000 }).reason, 'no_investor_cluster')
  const small = sfrLaneCeiling({ as_is_value: 80_000, investor_cluster_mid: 70_000, cluster_authoritative: true, protected_margin: 15_000 })
  assert.deepEqual([small.mao, small.protected_margin_applied], [55_000, true], '13 % of 70k < 15k protected ⇒ MAO = 70k − 15k')
  const withArv = sfrLaneCeiling({ as_is_value: 200_000, investor_cluster_mid: 190_000, cluster_authoritative: true, retail_arv: { value: 260_000, source: 'mls_sold_updated' }, repairs: 40_000 })
  assert.deepEqual([withArv.arv_lane.mao, withArv.arv_lane.role, withArv.mao], [142_000, 'cross_check_only_never_blended', 165_300])
  assert.equal(sfrLaneCeiling({ as_is_value: 200_000, investor_cluster_mid: 190_000, cluster_authoritative: true }).arv_lane.reason, 'no_sourced_retail_arv')
})

test('flag ON leaves non-SFR assets on the existing formula (2-4 units, multifamily)', () => {
  assert.equal(isSfrSubject({ asset_family: 'residential', units: 1 }), true)
  assert.equal(isSfrSubject({ asset_family: 'residential', units: 3 }), false)
  assert.equal(isSfrSubject({ asset_family: 'multifamily', units: 8 }), false)
  const mf = calculateAcquisitionDecision({ subject: { ...SUBJECT, normalized_asset_class: 'multifamily', property_type: 'Apartment', units_count: 8 }, comps: COMPS, buyerPurchases: PURCHASES, now: NOW, v3Enabled: false, sfrLaneCeilingV1: true })
  assert.notEqual(mf.evidence.offer_calculation.method, 'sfr_llc_investor_cluster_less_13pct')
})

test('laneValuation (pure, for the shortlist): facts + comps in → lane-labelled valuation, MAO (ceiling) and an opening strictly below it; production formula by default, SFR lane on request', () => {
  const base = laneValuation({ property: SUBJECT, comps: COMPS, buyer_purchases: PURCHASES, now: NOW })
  assert.equal(base.lane, 'sfr')
  assert.equal(base.formula, 'repair_adjusted_exit_ceiling_less_assignment_target')
  assert.ok(base.mao > 0 && base.mao_role === 'ceiling_not_opening')
  if (base.opening) assert.ok(base.opening.recommended < base.mao && base.opening.range.every((x) => x < base.mao))
  assert.match(base.owner_question, /sfr_engine_subtracts_repairs/)
  assert.equal(base.sfr_trace.current_engine.double_deduction_usd, 32_000)
  const lane = laneValuation({ property: SUBJECT, comps: COMPS, buyer_purchases: PURCHASES, now: NOW, sfr_lane: true })
  assert.equal(lane.formula, 'sfr_llc_investor_cluster_less_13pct')
  assert.equal(lane.mao, lane.sfr_trace.owner_lane.mao)
  if (lane.opening) assert.ok(lane.opening.recommended < lane.mao)
  assert.equal(lane.authority, 'analysis_only_not_persisted_not_spendable')
  assert.deepEqual(laneValuation({ property: SUBJECT, comps: COMPS, buyer_purchases: PURCHASES, now: NOW }), base, 'pure: same input ⇒ same output')
})
