/**
 * INVESTOR VALUATION v3 (shadow). Contracts:
 *   1. PRODUCTION PRICING IS UNCHANGED: the production engine's pinned fixture
 *      output (same pin as current-sales-valuation-v2.test.mjs) is identical
 *      before and after running v3, and v3 never imports the engine.
 *   2. v3 evidence rules: investor-buyer basis, junk / distressed / portfolio /
 *      flip exclusions, strong distance decay, tract barrier proxy, subdivision
 *      preference, within-set robust outliers, no leakage, a reason on every
 *      comp, and an offer that never subtracts repairs a second time.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { calculateAcquisitionDecision, normalizePropertyFeatures } from '../../src/lib/acquisition/acquisitionDecisionEngine.js'
import {
  V3, V3_OFFER, V3_REASONS, valueSubjectV3, computeOfferV3, normalizeSubdivision, classifyCompBuyer, qualifyRow,
  compWeight, flipResaleIds, rejectOutliers, resolveSubjectGeography, adjustCompPrice, V3_MF24, V3_MF5, laneFor, capShares, repairEvidence,
} from '../../src/lib/acquisition/shadow/investorValuationV3.js'

// ── 1. production pin ──
const NOW = new Date('2026-10-01T00:00:00Z')
const rawSubject = {
  property_id: 'S1', property_type: 'Single Family', units_count: 1, total_bedrooms: 3, total_baths: 2,
  building_square_feet: 1500, year_built: 1960, latitude: 45.0, longitude: -93.3, property_address_zip: '55412',
  estimated_value: 250000, estimated_repair_cost: 40000, market: 'Minneapolis, MN', building_condition: 'Average',
}
const prodComps = [
  ['c1', 260000, '2026-08-01', 1450, 0.3], ['c2', 245000, '2026-07-15', 1600, 0.5], ['c3', 275000, '2026-06-20', 1550, 0.8],
  ['c4', 238000, '2026-05-30', 1400, 1.1], ['c5', 255000, '2026-04-10', 1500, 1.4], ['c6', 268000, '2026-03-05', 1650, 1.9],
].map(([id, p, d, sf, dist]) => ({
  id, property_id: `P${id}`, property_type: 'Single Family', units_count: 1, total_bedrooms: 3, total_baths: 2,
  building_square_feet: sf, year_built: 1958, sale_price: p, sale_date: d, latitude: 45.0, longitude: -93.3,
  property_address_zip: '55412', distance_miles: dist, estimated_value: p, source: 'mv_map_market_sales',
}))
const signature = (d) => createHash('sha256').update(JSON.stringify({
  v: d.valuation, o: d.offer.recommended_cash_offer, f: d.offer.minimum_acceptable_offer, t: d.decision.tier, c: d.confidence,
  sel: d.selected_comps.map((s) => [s.comp.source_id, s.adjusted_price, s.weight]),
})).digest('hex')
const prodRun = () => calculateAcquisitionDecision({
  subject: normalizePropertyFeatures(rawSubject, { source: 'properties', now: NOW }), comps: prodComps, buyerPurchases: [], now: NOW, v3Enabled: false,
})
const PROD_PIN = 'fd6b8fc103ca987f03a836f12fb398182d1101586b0c989827ea0a623c86e6c7'

// ── v3 fixtures ──
const AS_OF = '2026-09-01'
const subject = {
  property_id: 'S1', latitude: 32.9, longitude: -96.7, sqft: 1400, beds: 3, baths: 2, year_built: 1965,
  estimated_repairs: 49000, census_tract: '019033', fips: '48113', subdivision_name: 'SKILLMAN FOREST 1',
}
const dLat = (miles) => 32.9 + miles / 69.0
let seq = 0
const sale = (o = {}) => {
  seq += 1
  return {
    comp_id: `t:${seq}`, source: 'public_record', sold_on: '2026-07-01', price: 160000, lat: dLat(o.miles ?? 0.2), lng: -96.7,
    property_id: `P${seq}`, address: `${seq} Main St`, city: 'Dallas', state: 'TX', zip: '75238', property_type: 'Single Family',
    beds: 3, baths: 2, sqft: 1400, year_built: 1964, units: 1, portfolio_size: 1, buyer_class: 'llc_investor', is_investor: true,
    doc_type: 'Warranty Deed', is_cash_purchase: null, is_arms_length: true, subdivision_name: 'SKILLMAN FOREST 1',
    census_tract: '019033', fips: '48113', estimated_repair_cost: 49000, owner_linked: false, ...o,
  }
}

test('production engine pinned output is unchanged, before and after running v3', () => {
  const before = prodRun()
  assert.equal(before.valuation.mid, 214800)
  assert.equal(before.offer.recommended_cash_offer, 93900)
  assert.equal(signature(before), PROD_PIN)
  valueSubjectV3({ subject, rows: [sale(), sale(), sale(), sale()], asOf: AS_OF })
  assert.equal(signature(prodRun()), PROD_PIN)
})

test('v3 is self-contained: it does not import the production engine', () => {
  const src = readFileSync(new URL('../../src/lib/acquisition/shadow/investorValuationV3.js', import.meta.url), 'utf8')
  assert.ok(!/from ['"]\.\.\/acquisitionDecisionEngine/.test(src))
})

test('subdivision: plat and base names', () => {
  assert.deepEqual(normalizeSubdivision('WESTBURY SEC 3'), { plat: 'WESTBURY SEC 3', base: 'WESTBURY' })
  assert.equal(normalizeSubdivision('WESTBURY SEC 4').base, 'WESTBURY')
  assert.equal(normalizeSubdivision('BAKERS 4TH ADDN TO MPLS').base, 'BAKERS')
  assert.equal(normalizeSubdivision('/5855 OF EASTERVIEW ADDITION NO. 5').base, 'EASTERVIEW')
  assert.deepEqual(normalizeSubdivision(null), { plat: null, base: null })
})

test('buyer type: recorded investor > cash > inferred owner tiers; MLS is never the investor basis', () => {
  assert.equal(classifyCompBuyer(sale()).type, 'recorded_investor')
  assert.equal(classifyCompBuyer(sale({ is_investor: false, buyer_class: 'unknown', is_cash_purchase: true })).type, 'cash')
  const strong = classifyCompBuyer(sale({ is_investor: false, buyer_class: 'unknown', owner_linked: true, owner_corporate: true, owner_out_of_state: true }))
  assert.equal(strong.type, 'inferred_strong')
  assert.equal(strong.investor, true)
  const likely = classifyCompBuyer(sale({ is_investor: false, buyer_class: 'unknown', owner_linked: true, owner_corporate: true }))
  assert.equal(likely.type, 'inferred_likely')
  const unlinked = classifyCompBuyer(sale({ is_investor: false, buyer_class: 'unknown', owner_linked: false, owner_corporate: true }))
  assert.equal(unlinked.type, 'public_other')
  const mls = classifyCompBuyer(sale({ source: 'mls' }))
  assert.equal(mls.type, 'investor_mls')
  assert.equal(mls.investor, false)
})

test('junk rules: $25K floor, distressed / non-arms / portfolio / builder / new construction / leakage / self', () => {
  const R = V3_REASONS
  const q = (o) => qualifyRow(sale(o), subject, { asOf: AS_OF })
  assert.ok(q({ price: 25000 - 1 }).includes(R.junkPrice))
  assert.ok(q({ doc_type: 'Trustee’s Deed' }).includes(R.distressedDeed))
  assert.ok(q({ doc_type: 'Quit Claim Deed' }).includes(R.distressedDeed))
  assert.ok(q({ doc_type: 'Sheriff’s Deed' }).includes(R.distressedDeed))
  assert.ok(q({ is_arms_length: false }).includes(R.nonArms))
  assert.ok(q({ portfolio_size: 4 }).includes(R.portfolio))
  assert.ok(q({ buyer_class: 'builder' }).includes(R.excludedBuyer))
  assert.ok(q({ year_built: 2026 }).includes(R.newConstruction))
  assert.ok(q({ sold_on: AS_OF }).includes(R.leak))
  assert.ok(q({ property_id: 'S1' }).includes(R.self))
  assert.ok(q({ sqft: 2200 }).includes(R.sqft))
  assert.deepEqual(q({}), [])
  // 0 beds / 0 sqft are "not recorded", never a mismatch
  assert.deepEqual(q({ beds: 0, sqft: 0 }), [])
})

test('flip resale: a later sale within 12 months at >= 1.3x is renovated retail, not an as-is price', () => {
  const a = sale({ property_id: 'F', sold_on: '2026-01-10', price: 120000 })
  const b = sale({ property_id: 'F', sold_on: '2026-06-10', price: 205000 })
  assert.deepEqual([...flipResaleIds([a, b])], [b.comp_id])
})

test('distance decays hard: a 2.5 mi $300K comp barely moves a nearby $170K set', () => {
  const near = [0.1, 0.15, 0.2, 0.25].map((m) => sale({ miles: m, price: 170000 }))
  const far = sale({ miles: 2.5, price: 300000, subdivision_name: 'OTHER', census_tract: '019100' })
  const r = valueSubjectV3({ subject, rows: [...near, far], asOf: AS_OF })
  assert.equal(r.value.method, 'investor_comps')
  assert.ok(r.value.mid < 172000, `mid ${r.value.mid}`)
  const w = (c) => r.comps.find((x) => x.comp_id === c.comp_id)
  assert.ok(w(far).status === 'excluded' || w(far).share < 0.01)
  assert.ok(compWeight(far, subject, AS_OF).factors.distance < 0.04)
})

test('barrier proxy and subdivision preference are explicit weight factors', () => {
  const same = compWeight(sale(), subject, AS_OF).factors
  assert.equal(same.barrier_basis, 'same_tract')
  assert.equal(same.subdivision_basis, 'same_plat')
  const across = compWeight(sale({ census_tract: '019100', subdivision_name: 'LAKE HIGHLANDS' }), subject, AS_OF).factors
  assert.equal(across.barrier_basis, 'other_tract_possible_barrier')
  assert.equal(across.barrier, V3.barrier.otherTract)
  assert.equal(across.subdivision, 1)
  const otherCounty = compWeight(sale({ fips: '48085' }), subject, AS_OF).factors
  assert.equal(otherCounty.barrier_basis, 'other_county')
  assert.equal(otherCounty.subdivision_basis, 'different_or_unknown')
})

test('within-set outliers: a $40K deed and a $600K deed in a $170K set are excluded with reasons', () => {
  const set = [168000, 172000, 175000, 165000, 170000, 40000, 600000].map((p) => ({ adjusted_price: p, weight: 1, status: 'candidate' }))
  rejectOutliers(set)
  assert.deepEqual(set.map((c) => c.status === 'excluded'), [false, false, false, false, false, true, true])
  assert.equal(set[5].reasons[0], V3_REASONS.outlierLow)
  assert.equal(set[6].reasons[0], V3_REASONS.outlierHigh)
})

test('repairs: same flat-rate tier -> no comp adjustment; the offer never subtracts repairs again', () => {
  const same = adjustCompPrice(sale(), subject)
  assert.equal(same.adjustments.find((a) => a.basis === 'condition_tier_difference').amount, 0)
  const heavy = adjustCompPrice(sale({ estimated_repair_cost: 15 * 1400 }), subject) // comp $15/sf, subject $35/sf
  assert.ok(heavy.adjustments.find((a) => a.basis === 'condition_tier_difference').amount < 0)
  const offer = computeOfferV3({ value: { mid: 150000, confidence: 80, method: 'investor_comps' }, subject: { estimated_repairs: 49000 } })
  // ceiling = value x (1 - 8% SFR calibration), no haircut at confidence >= 70 -> 138,000;
  // fee = 12% (ceiling < $150K) = 16,560 -> offer 121,440. Repairs are NOT subtracted.
  assert.equal(offer.buyer_ceiling, 138000)
  assert.equal(offer.recommended_cash_offer, 121400)
  assert.equal(offer.calibration_pct, 8)
  assert.equal(offer.repairs_basis, 'embedded_in_as_is_investor_comps_not_subtracted_again')
  const small = computeOfferV3({ value: { mid: 100000, confidence: 55, method: 'investor_comps' } })
  assert.equal(small.buyer_ceiling, 89200) // 100K x 0.92 x 0.97
  assert.equal(small.assignment_fee_target, V3_OFFER.feeFloor)
  const noCal = computeOfferV3({ value: { mid: 150000, confidence: 80, method: 'investor_comps' } }, { ...V3_OFFER, calibrationByLane: {} })
  assert.equal(noCal.recommended_cash_offer, 135000)
})

test('fallback: thin investor evidence uses all arms-length sales x the local investor ratio, labelled', () => {
  const rows = [0.1, 0.2, 0.3, 0.4, 0.5].map((m) => sale({ miles: m, is_investor: false, buyer_class: 'individual', price: 200000 }))
  const r = valueSubjectV3({ subject, rows, asOf: AS_OF })
  assert.equal(r.value.method, 'market_ratio_fallback')
  assert.equal(r.value.investor_ratio.basis, 'default_insufficient_local_investor_sales')
  assert.equal(r.value.mid, Math.round((200000 * V3.defaultInvestorRatio) / 100) * 100)
})

test('every comp carries a status and a reason', () => {
  const rows = [sale(), sale(), sale(), sale({ price: 9000 }), sale({ doc_type: 'Quit Claim Deed' }), sale({ is_investor: false, buyer_class: 'individual' })]
  const r = valueSubjectV3({ subject, rows, asOf: AS_OF })
  assert.equal(r.comps.length, rows.length)
  for (const c of r.comps) { assert.ok(c.status); assert.ok(c.reasons.length > 0) }
})

test('subject geography: own record, else same-point parcel, else nearest majority', () => {
  const neighbors = [
    { fips: '48113', county_name: 'Dallas', census_tract: '019033', subdivision_name: 'SKILLMAN FOREST 1', miles: 0.004 },
    { fips: '48113', county_name: 'Dallas', census_tract: '019032', subdivision_name: 'WALNUT TERRACE 2', miles: 0.03 },
  ]
  const own = resolveSubjectGeography({ own: { census_tract: '19033', county_name: 'Dallas' }, neighbors })
  assert.equal(own.census_tract, '019033')
  assert.equal(own.fips, '48113')
  assert.equal(own.subdivision_name, 'SKILLMAN FOREST 1')
  const inferred = resolveSubjectGeography({ own: {}, neighbors })
  assert.equal(inferred.basis.tract, 'same_point_parcel')
})

test('owner comp rules: >= 2.5 mi, year-built era, much bigger lot are NOT comparable', () => {
  const R = V3_REASONS
  const rows = [sale({ miles: 2.6 }), sale({ year_built: 2012 }), sale({ year_built: 1920 }), sale({ lot_sqft: 60000 }), sale(), sale(), sale()]
  const r = valueSubjectV3({ subject: { ...subject, lot_sqft: 7000 }, asOf: AS_OF, rows })
  const why = (i) => r.comps.find((c) => c.comp_id === rows[i].comp_id).reasons[0]
  assert.equal(why(0), R.beyondSfrMax)
  assert.equal(why(1), R.yearEra)
  assert.equal(why(2), R.yearEra)
  assert.equal(why(3), R.lotMuchBigger)
  assert.equal(r.value.radius_miles, 2.5)
})

test('same subdivision with small differences (3 yrs newer, 200 sf smaller) stays a strong comp', () => {
  const f = compWeight(sale({ year_built: 1968, sqft: 1200 }), subject, AS_OF).factors
  assert.equal(f.subdivision_basis, 'same_plat')
  assert.ok(f.similarity >= V3.sameSubdivisionSimilarityFloor)
  const other = compWeight(sale({ year_built: 1968, sqft: 1200, subdivision_name: 'LAKE HIGHLANDS' }), subject, AS_OF).factors
  assert.ok(other.similarity < f.similarity)
})

test('no single comp carries more than 35%, and a dominant out-of-line comp is removed', () => {
  const top = [{ weight: 10 }, { weight: 1 }, { weight: 1 }, { weight: 1 }]
  capShares(top, 0.35)
  const W = top.reduce((a, c) => a + c.weight, 0)
  assert.ok(top[0].weight / W <= 0.3501)
  const rows = [sale({ miles: 0.01, price: 260000 }), sale({ miles: 0.6, price: 170000 }), sale({ miles: 0.7, price: 172000 }), sale({ miles: 0.8, price: 168000 })]
  const r = valueSubjectV3({ subject, rows, asOf: AS_OF })
  assert.ok(r.value.mid < 185000, `mid ${r.value.mid}`)
})

test('repairs evidence: the $35/sqft import guess is low confidence and only a condition difference', () => {
  const e = repairEvidence({ estimated_repairs: 35 * 1400, sqft: 1400, condition: 'Unknown' })
  assert.equal(e.source, 'import_flat_rate_per_sqft')
  assert.equal(e.confidence, 'low')
  assert.equal(e.used_as, 'condition_tier_difference_only')
})

test('multifamily: lane by real unit count, price per door, per-door range label, wider radius', () => {
  assert.equal(laneFor({ units: 11 }).lane, 'mf5')
  assert.equal(laneFor({ units: 3 }).lane, 'mf24')
  assert.equal(laneFor({ units: null }).lane, 'sfr')
  const mfSubject = { ...subject, units: 11, sqft: 10476, beds: null, baths: null, year_built: 1963, lot_sqft: null }
  const mf = (o) => sale({ property_type: 'Apartment', beds: null, baths: null, year_built: 1965, sqft: 10000, units: 11, price: 990000, ...o })
  const rows = [mf({ miles: 0.5 }), mf({ miles: 1.0, price: 1045000 }), mf({ miles: 1.5, units: 12, price: 1080000, sqft: 11000 }),
    mf({ miles: 4, units: 10, price: 900000 }), mf({ miles: 3, units: null }), mf({ miles: 3, units: 2, price: 300000 })]
  const r = valueSubjectV3({ subject: mfSubject, rows, asOf: AS_OF })
  assert.equal(r.value.lane, 'mf5')
  assert.equal(r.value.radius_miles, V3_MF5.radiusMiles)
  assert.ok(r.value.per_door.mid > 85000 && r.value.per_door.mid < 100000, `per door ${r.value.per_door.mid}`)
  assert.match(r.value.per_door.label, /^\$\d+-\d+K\/door x 11 doors$/)
  assert.ok(Math.abs(r.value.mid - r.value.per_door.mid * 11) <= 11 * 50)
  const reasons = r.comps.filter((c) => c.status === 'excluded').map((c) => c.reasons[0])
  assert.ok(reasons.includes(V3_REASONS.unitsUnknown))
  assert.ok(reasons.includes(V3_REASONS.unitBand))
  assert.ok(r.value.adaptive_bandwidth.half_life_miles <= V3_MF5.distanceHalfLifeMiles)
  assert.ok(r.offer.per_door.offer > 0)
  assert.equal(r.offer.lane, 'mf5')
  assert.equal(V3_MF24.radiusMiles, 5)
})

test('engine gate is injected and its reasons are recorded per comp', () => {
  const rows = [sale(), sale(), sale(), sale()]
  const r = valueSubjectV3({ subject, rows, asOf: AS_OF, gate: (row) => (row === rows[0] ? [] : []) })
  assert.equal(r.comps.filter((c) => c.status === 'selected').length, 4)
  const g = valueSubjectV3({ subject, rows, asOf: AS_OF, gate: (row) => (row.comp_id === rows[0].comp_id ? ['asset_type_mismatch'] : []) })
  assert.equal(g.comps.find((c) => c.comp_id === rows[0].comp_id).reasons[0], 'engine_gate:asset_type_mismatch')
})
