/**
 * CURRENT-SALES VALUATION v2 (shadow). Two contracts:
 *   1. PRODUCTION IS UNCHANGED. The production engine path still reads an
 *      unknown comp repair cost as $0, and its output for a pinned fixture is
 *      byte-identical (sha256 of valuation + offer + tier + confidence +
 *      selected weights) to the engine at the commit that introduced v2.
 *      Running v2 does not mutate inputs or leak state into the next prod call.
 *   2. v2 evidence rules: unknown repairs -> no adjustment, RPC ranking,
 *      one sale per parcel+date, deed qualification, 5+ unit comp guard,
 *      a reason on every exclusion.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { calculateAcquisitionDecision, normalizePropertyFeatures } from '../../src/lib/acquisition/acquisitionDecisionEngine.js'
import {
  CURRENT_SALES_V2, V2_REASONS, valueWithCurrentSalesV2, dedupeEconomicSales, qualificationReasons,
  bulkConsiderationIndex, rankLikeEngineRpc, rpcSimilarity, toEngineComp, withMinCompGuard, selectCurrentSalesCandidates,
} from '../../src/lib/acquisition/shadow/currentSalesValuationV2.js'

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
const prodRun = () => {
  const subject = normalizePropertyFeatures(rawSubject, { source: 'properties', now: NOW })
  return calculateAcquisitionDecision({ subject, comps: prodComps, buyerPurchases: [], now: NOW, v3Enabled: false })
}

test('production path is byte-identical: unknown comp repairs still read as $0, pinned output', () => {
  const d = prodRun()
  const repair = d.selected_comps[0].price_adjustments.find((a) => a.basis === 'repair_difference')
  assert.equal(repair.amount, -40000) // production semantics untouched
  assert.equal(d.valuation.mid, 214800)
  assert.equal(d.offer.recommended_cash_offer, 93900)
  assert.equal(d.decision.tier, 'NURTURE')
  assert.equal(d.confidence, 53)
  assert.equal(signature(d), 'fd6b8fc103ca987f03a836f12fb398182d1101586b0c989827ea0a623c86e6c7')
})

test('running v2 neither mutates inputs nor changes the next production call', () => {
  const before = signature(prodRun())
  const rows = prodComps.map((c) => ({ comp_id: `t:${c.id}`, source: 'public_record', sold_on: c.sale_date, price: c.sale_price, lat: 45.0, lng: -93.3, property_id: c.property_id, zip: '55412', property_type: 'Single Family', beds: 3, baths: 2, sqft: c.building_square_feet, year_built: 1958, units: 1, estimated_value: c.sale_price, portfolio_size: 1 }))
  const frozen = JSON.stringify(rows)
  const v2 = valueWithCurrentSalesV2({ rawSubject, rows, radiusMiles: 4, now: NOW })
  assert.equal(JSON.stringify(rows), frozen)
  assert.equal(signature(prodRun()), before)
  // and v2 differs from prod only by the repair rule: no repair markdown
  const repair = v2.decision.selected_comps[0].price_adjustments.find((a) => a.basis === 'repair_difference')
  assert.equal(repair.amount, 0)
  assert.ok(v2.decision.valuation.mid > 214800)
})

test('unknown comp repairs are unknown: comp carries subject estimate, basis recorded', () => {
  const subject = { estimated_repairs: 40000 }
  const c = toEngineComp({ comp_id: 't:1', price: 200000, sold_on: '2026-07-01' }, subject)
  assert.equal(c.estimated_repair_cost, 40000)
  assert.equal(c._v2.repair_basis, 'unknown_no_adjustment')
  const both = toEngineComp({ comp_id: 't:1', price: 200000, sold_on: '2026-07-01' }, { estimated_repairs: null })
  assert.equal(both.estimated_repair_cost, null)
  assert.equal(both._v2.repair_basis, 'both_unknown')
})

test('dedupe: one economic sale per parcel and date, MLS > recorded deed > pool row', () => {
  const rows = [
    { comp_id: 'p:abc', source: 'public_record', property_id: 'X', sold_on: '2026-02-18', price: 8800610 },
    { comp_id: 't:1', source: 'public_record', property_id: 'X', sold_on: '2026-02-18', price: 8271300 },
    { comp_id: 'p:mls', source: 'mls', property_id: 'Y', sold_on: '2026-03-01', price: 300000 },
    { comp_id: 't:2', source: 'public_record', property_id: 'Y', sold_on: '2026-03-01', price: 299000 },
    { comp_id: 't:3', source: 'public_record', property_id: 'Y', sold_on: '2026-04-01', price: 310000 },
  ]
  const { kept, duplicates } = dedupeEconomicSales(rows)
  assert.deepEqual(kept.map((r) => r.comp_id).sort(), ['p:mls', 't:1', 't:3'])
  assert.deepEqual(duplicates.map((d) => [d.row.comp_id, d.kept_id]).sort(), [['p:abc', 't:1'], ['t:2', 'p:mls']])
})

test('qualification: non-arms, portfolio, implausible consideration and multi-parcel deeds are excluded with reasons', () => {
  assert.deepEqual(qualificationReasons({ is_arms_length: false, price: 45000000, estimated_value: 6778206 }), [V2_REASONS.nonArms])
  assert.deepEqual(qualificationReasons({ portfolio_size: 4, price: 1e6 }), [V2_REASONS.portfolio])
  assert.deepEqual(qualificationReasons({ price: 48664500, estimated_value: 252210 }), [V2_REASONS.ratio])
  const bulkOf = bulkConsiderationIndex([
    { sold_on: '2025-12-23', price: 1995000000, zip: '92101', city: 'San Diego', state: 'CA', parcels: 2 },
    { sold_on: '2025-12-24', price: 137767500, zip: '92101', city: 'San Diego', state: 'CA', parcels: 1 },
    { sold_on: '2025-12-24', price: 137767500, zip: '92103', city: 'San Diego', state: 'CA', parcels: 1 },
    { sold_on: '2025-12-24', price: 137767500, zip: '92104', city: 'San Diego', state: 'CA', parcels: 1 },
    { sold_on: '2026-01-05', price: 250000, zip: '55412', city: 'Minneapolis', state: 'MN', parcels: 1 },
    { sold_on: '2026-01-05', price: 250000, zip: '33101', city: 'Miami', state: 'FL', parcels: 1 },
    { sold_on: '2026-01-05', price: 250000, zip: '77002', city: 'Houston', state: 'TX', parcels: 1 },
  ])
  assert.ok(qualificationReasons({ sold_on: '2025-12-23', price: 1995000000, zip: '92101', city: 'San Diego', state: 'CA' }, bulkOf).includes(V2_REASONS.bulk)) // 2 in one zip
  assert.ok(qualificationReasons({ sold_on: '2025-12-24', price: 137767500, zip: '92104', city: 'San Diego', state: 'CA' }, bulkOf).includes(V2_REASONS.bulk)) // 3 in one city
  // a common price on one day in three different cities is coincidence, not a package
  assert.deepEqual(qualificationReasons({ sold_on: '2026-01-05', price: 250000, zip: '55412', city: 'Minneapolis', state: 'MN' }, bulkOf), [])
})

test('ranking mirrors get_comp_candidates_for_subject: asset rank, similarity, recency, distance', () => {
  const key = { cls: 'single_family', sqft: 1500, beds: 3, baths: 2, year_built: 1960, units: 1 }
  const base = { property_type: 'Single Family', units: 1, beds: 3, baths: 2, year_built: 1960 }
  const ranked = rankLikeEngineRpc(key, [
    { comp_id: 'far-similar', ...base, sqft: 1500, sold_on: '2026-01-01', distance_miles: 3 },
    { comp_id: 'near-dissimilar', ...base, sqft: 2900, sold_on: '2026-09-01', distance_miles: 0.1 },
    { comp_id: 'duplex', ...base, property_type: 'Multi-Family', units: 2, sqft: 1500, sold_on: '2026-09-01', distance_miles: 0.1 },
    { comp_id: 'land', property_type: 'Vacant Land', sqft: null, sold_on: '2026-09-01', distance_miles: 0.05 },
    { comp_id: 'far-similar-newer', ...base, sqft: 1500, sold_on: '2026-02-01', distance_miles: 3.5 },
  ])
  assert.deepEqual(ranked.map((r) => r.comp_id), ['far-similar-newer', 'far-similar', 'near-dissimilar', 'duplex', 'land'])
  assert.equal(rpcSimilarity(key, { cls: 'single_family', sqft: 1500, beds: 3, baths: 2, year_built: 1960 }), 100)
})

test('every exclusion carries a reason; the candidate list is capped at the RPC limit', () => {
  const rows = []
  for (let i = 0; i < 130; i += 1) rows.push({ comp_id: `t:${i}`, source: 'public_record', property_id: `P${i}`, sold_on: '2026-06-01', price: 200000 + i, lat: 45.0, lng: -93.3, zip: '55412', property_type: 'Single Family', units: 1, sqft: 1500, beds: 3, baths: 2, year_built: 1960 })
  rows.push({ comp_id: 't:unpriced', property_id: 'U', sold_on: '2026-06-01', price: null, lat: 45.0, lng: -93.3 })
  rows.push({ comp_id: 't:far', property_id: 'F', sold_on: '2026-06-01', price: 1, lat: 46.0, lng: -93.3 })
  const subject = normalizePropertyFeatures(rawSubject, { source: 'properties', now: NOW })
  const sel = selectCurrentSalesCandidates({ rows, subject, rawSubject, radiusMiles: 4 })
  assert.equal(sel.candidates.length, CURRENT_SALES_V2.candidateLimit)
  assert.equal(sel.census.outside_radius, 1)
  assert.ok(sel.ledger.every((l) => l.reasons.length > 0))
  assert.equal(sel.ledger.filter((l) => l.reasons[0] === V2_REASONS.outsideLimit).length, 30)
  assert.equal(sel.ledger.filter((l) => l.reasons[0] === V2_REASONS.unpriced).length, 1)
})

test('5+ unit guard: fewer than 3 selected comps falls back to the engine no-comps path; smaller assets untouched', () => {
  const mfSubject = normalizePropertyFeatures({ ...rawSubject, property_type: 'Apartment', units_count: 12, building_square_feet: 9000 }, { source: 'properties', now: NOW })
  const one = [{ ...prodComps[0], property_type: 'Apartment', units_count: 12, building_square_feet: 9000, sale_price: 9000000 }]
  const d = calculateAcquisitionDecision({ subject: mfSubject, comps: one, buyerPurchases: [], now: NOW, v3Enabled: false })
  assert.equal(d.selected_comps.length, 1)
  const g = withMinCompGuard({ subject: mfSubject, now: NOW, decision: d })
  assert.equal(g.guard.applied, true)
  assert.equal(g.guard.reason, V2_REASONS.guard)
  assert.equal(g.decision.valuation.calculation.method, 'subject_value_fallback')
  const sfr = prodRun()
  assert.equal(withMinCompGuard({ subject: normalizePropertyFeatures(rawSubject, { source: 'properties', now: NOW }), now: NOW, decision: sfr }).guard.applied, false)
})
