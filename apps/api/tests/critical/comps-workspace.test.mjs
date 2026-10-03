/**
 * COMPS INTELLIGENCE workspace — pure builders. The workspace judges every
 * candidate with the engine's scoreComparable (covered by the engine suites);
 * these tests pin what this layer adds: observable subject-vs-comp facts,
 * measured sufficiency, set statistics, per-asset dimensions and complete
 * reason labels for every engine code.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalPropertyIds, compareToSubject, dimensionsFor, enginePoolInput, engineRunFrom, evidenceSufficiency, getCompsWorkspace, REASON_LABELS, setStats } from '../../src/lib/domain/comp-intelligence/comps-workspace-service.js'
import { normalizePropertyFeatures, scoreComparable } from '../../src/lib/acquisition/acquisitionDecisionEngine.js'

const DAY = 86_400_000
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10)

test('subject-vs-comp facts are deltas, not a composite score', () => {
  const s = { sqft: 1842, beds: 3, baths: 2, yearBuilt: 1987, lotSqft: 6000, units: 1 }
  // A full timestamp: iso() truncates to UTC midnight, so after 12:00 UTC a
  // date-only 38 days ago rounds to 39 and this failed by time of day.
  const c = { sqft: 1920, beds: 3, baths: 2.5, yearBuilt: 1989, lotSqft: 5400, units: 1, saleDate: new Date(Date.now() - 38 * DAY).toISOString(), assetMatch: true }
  const d = compareToSubject(s, c)
  assert.equal(d.sqftPct, 4)
  assert.equal(d.beds, 0)
  assert.equal(d.baths, 0.5)
  assert.equal(d.years, 2)
  assert.equal(d.lotPct, -10)
  assert.equal(d.days, 38)
  assert.equal(compareToSubject(s, { saleDate: null }).days, null) // an undated sale is never "recent"
})

test('sufficiency is counted from same-type sales within a mile in the last year', () => {
  const near = (n, over = {}) => Array.from({ length: n }, (_, i) => ({ state: 'candidate', distanceMiles: 0.4, assetMatch: true, saleDate: iso(60 + i), ...over }))
  assert.equal(evidenceSufficiency(near(6)).level, 'strong')
  assert.equal(evidenceSufficiency(near(3)).level, 'moderate')
  assert.equal(evidenceSufficiency(near(1)).level, 'limited')
  assert.equal(evidenceSufficiency(near(5, { assetMatch: false })).level, 'thin')
  assert.equal(evidenceSufficiency(near(5, { state: 'excluded' })).level, 'thin')
  assert.equal(evidenceSufficiency(near(5, { saleDate: iso(500) })).level, 'thin')
})

test('set statistics: medians and observed range, adjusted from engine prices', () => {
  const st = setStats([
    { salePrice: 385000, ppsf: 210, distanceMiles: 0.3, saleDate: iso(30), engine: { adjustedPrice: 390000 } },
    { salePrice: 412000, ppsf: 228, distanceMiles: 0.5, saleDate: iso(60), engine: { adjustedPrice: 405000 } },
    { salePrice: 438000, ppsf: 240, distanceMiles: 0.9, saleDate: iso(90), engine: { adjustedPrice: 430000 } },
  ])
  assert.equal(st.count, 3)
  assert.equal(st.medianPrice, 412000)
  assert.equal(st.low, 385000)
  assert.equal(st.high, 438000)
  assert.equal(st.medianPpsf, 228)
  assert.equal(st.medianAdjusted, 405000)
  assert.equal(st.medianDistance, 0.5)
})

test('comparability dimensions follow the asset class', () => {
  assert.ok(dimensionsFor('residential').includes('beds'))
  assert.ok(dimensionsFor('multifamily').includes('units'))
  assert.ok(!dimensionsFor('multifamily').includes('beds'))
  assert.deepEqual(dimensionsFor('land').slice(0, 1), ['lot_sqft'])
})

test('every engine and recorded-deed reason code has operator language', () => {
  for (const code of [
    'invalid_sale_price', 'nominal_non_arms_length_transfer', 'package_consideration_unresolved', 'same_property',
    'asset_type_mismatch', 'sale_too_old', 'outside_radius', 'outside_zip_without_coordinates', 'square_feet_outside_range',
    'unit_count_outside_range', 'building_size_outside_range', 'comp_score_below_30', 'missing_adjusted_price',
    'adjusted_price_outlier', 'outside_top_comp_limit', 'nominal_price', 'non_arms_length', 'distress_or_transfer_deed',
  ]) assert.ok(REASON_LABELS[code], code)
})

/* ── engine-faithful projection (2026-10-01) ─────────────────────────────
 * getCompsWorkspace over an injected client: the engine's own row scores
 * every pool candidate, stored system verdicts keep their replay inputs at
 * engine precision, and the stored decision's method / components / outlier
 * band / funnel ride along. No network: the client is a fixture. */

const WS_NOW = new Date('2026-10-01T15:00:00Z')
const COMPUTED_AT = '2026-09-30T20:20:46.704Z'

function fakeClient(tables, rpcs) {
  const calls = []
  const from = (table) => {
    const st = { table, filters: [], single: false }
    const q = {
      select(cols) { st.select = cols; return q },
      eq(k, v) { st.filters.push(['eq', k, v]); return q },
      in(k, v) { st.filters.push(['in', k, v]); return q },
      order() { return q },
      limit() { return q },
      maybeSingle() { st.single = true; return q },
      then(resolve, reject) {
        calls.push(st)
        let rows = tables[table] ?? []
        for (const [op, k, v] of st.filters) rows = rows.filter((r) => (op === 'eq' ? String(r[k]) === String(v) : v.map(String).includes(String(r[k]))))
        return Promise.resolve({ data: st.single ? rows[0] ?? null : rows, error: null }).then(resolve, reject)
      },
    }
    return q
  }
  const rpc = (name, args) => { calls.push({ rpc: name, args }); const v = rpcs[name]; return Promise.resolve({ data: typeof v === 'function' ? v(args) : v ?? null, error: null }) }
  return { from, rpc, calls }
}

const SUBJECT_ROW = { property_id: 'S1', property_address_full: '1 Subject St, Minneapolis, MN 55430', property_address_city: 'Minneapolis', property_address_state: 'MN', property_address_zip: '55430', property_address_county_name: 'Hennepin', market: 'Minneapolis, MN', latitude: 45.0483, longitude: -93.3116, property_type: 'Single Family', units_count: 1, total_bedrooms: 3, total_baths: 1.5, building_square_feet: 1122, lot_square_feet: 6098, year_built: 1954, building_condition: 'Average', subdivision_name: 'ENGLEWOOD', zoning: 'R1A', estimated_value: 260000, sale_date: '2007-02-13', sale_price: 318000 }
const detailOf = (id, over) => ({ id, property_id: `P-${id}`, property_address_full: `${id} Comp Ave N, Minneapolis, MN 55430`, property_address_zip: '55430', latitude: 45.05, longitude: -93.31, property_type: 'Single Family', units_count: 1, total_bedrooms: 3, total_baths: 1, building_square_feet: 1140, lot_square_feet: 5227, year_built: 1952, building_condition: 'Average', construction_type: 'Frame', subdivision_name: 'ENGLEWOOD', zoning: 'R1A', garage: 'Garage', pool: 'No', sale_price: 265000, sale_date: '2026-04-22', mls_sold_price: 265000, mls_sold_date: '2026-04-22', estimated_value: 255000, computed_ppsf: 232, streetview_image: null, ...over })
const rpcRowOf = (d, distance) => ({ comp_id: d.id, property_id: d.property_id, address: d.property_address_full, zip: '55430', latitude: d.latitude, longitude: d.longitude, sale_price: d.sale_price, sale_date: d.sale_date, mls_sold_price: d.mls_sold_price, property_type: d.property_type, beds: d.total_bedrooms, baths: d.total_baths, sqft: d.building_square_feet, units_count: 1, year_built: d.year_built, distance_miles: distance })

function workspaceFixture() {
  const dSys = detailOf('sys-1', {})
  const dCand = detailOf('cand-1', { sale_price: 315000, mls_sold_price: 315000, building_square_feet: 975, sale_date: '2026-04-03', mls_sold_date: '2026-04-03' })
  const pool = [rpcRowOf(dSys, 0.31), rpcRowOf(dCand, 0.19)]
  const subject = normalizePropertyFeatures(SUBJECT_ROW, { source: 'properties', now: WS_NOW })
  // The stored system verdict is what the engine produced at COMPUTED_AT from its own row.
  const asPriced = scoreComparable(subject, enginePoolInput(pool[0], dSys), { source: 'v_recent_sold_comps', distance_miles: 0.31, now: new Date(COMPUTED_AT) })
  const score = {
    property_id: 'S1', computed_at: COMPUTED_AT, valuation_low: 263300, valuation_mid: 294600, valuation_high: 319200, valuation_confidence: 84,
    recommended_cash_offer: 150400, minimum_acceptable_offer: 141600, decision_tier: 'AUTO_RANGE_OFFER',
    sel: [{ id: 'sys-1', comp_id: 'sys-1', property_id: dSys.property_id, address: dSys.property_address_full, source: 'mls_sold', sale_price: 265000, sale_date: '2026-04-22', distance_miles: 0.31, adjusted_price: asPriced.adjusted_price, adjusted_value: asPriced.adjusted_price, comp_score: asPriced.comp_score, score: asPriced.comp_score, comp_confidence: asPriced.comp_confidence, data_completeness: asPriced.data_completeness, weight: asPriced.weight, price_adjustments: asPriced.price_adjustments, match_breakdown: asPriced.feature_match_breakdown }],
    rej: [{ comp_id: 'cand-1', reasons: ['outside_top_comp_limit'] }],
    calc: { method: 'weighted_adjusted_comp_value', formula: 'sum(adjusted_comp_price * comp_weight) / sum(comp_weight)', selected_comp_count: 1, total_weight: asPriced.weight, dispersion_ratio: 0, source_types: ['mls_sold'], components: { depth_score: 12.5, average_comp_score: asPriced.comp_score, average_data_completeness: asPriced.data_completeness, consistency_score: 100, source_diversity_score: 70 } },
    outl: { method: 'insufficient_count_for_mad' },
    eng: { name: 'acquisition_decision_engine', version: '2.0.0', computed_at: COMPUTED_AT },
    cds_status: 'comps_selected', cds_raw: 2, cds_elig: 2, cds_rej: { outside_top_comp_limit: 1 },
  }
  const client = fakeClient(
    { properties: [SUBJECT_ROW], property_acquisition_scores: [score], v_recent_sold_comps: [dSys, dCand], acquisition_opportunities: [] },
    { get_comp_candidates_for_subject: () => pool, comps_market_evidence: { total_in_radius: 0, total_same_family: 0, returned: 0, rows: [] }, comps_market_cell: null },
  )
  return { client, subject, pool, dSys, dCand, asPriced }
}

test('workspace opens on the engine window when no window is asked for', async () => {
  const { client } = workspaceFixture()
  const w = await getCompsWorkspace({ propertyId: 'S1' }, { supabase: client, now: WS_NOW })
  assert.equal(w.query.radiusMiles, 4)
  assert.equal(w.query.months, 30)
  assert.deepEqual(w.query.engineWindow, { radiusMiles: 4, months: 30, clamped: false })
  const call = client.calls.find((c) => c.rpc === 'get_comp_candidates_for_subject')
  assert.equal(call.args.p_radius_miles, 4)
  assert.equal(call.args.p_months_back, 30)
  const explicit = await getCompsWorkspace({ propertyId: 'S1', radius: '1', months: '12' }, { supabase: fakeClient({ properties: [SUBJECT_ROW] }, { get_comp_candidates_for_subject: [] }), now: WS_NOW })
  assert.equal(explicit.query.radiusMiles, 1)
  assert.equal(explicit.query.months, 12)
})

test('candidates are scored from the engine’s own row, as MLS sales when they are', async () => {
  const { client, subject, pool, dCand } = workspaceFixture()
  const w = await getCompsWorkspace({ propertyId: 'S1' }, { supabase: client, now: WS_NOW })
  const cand = w.comps.find((c) => c.compId === 'cand-1')
  const engineView = scoreComparable(subject, enginePoolInput(pool[1], dCand), { source: 'v_recent_sold_comps', distance_miles: 0.19, now: WS_NOW })
  assert.equal(cand.state, 'candidate')
  assert.equal(cand.engine.saleSource, 'mls_sold')
  assert.equal(cand.engine.completeness, engineView.data_completeness)
  assert.equal(cand.engine.weight, engineView.weight)
  assert.equal(cand.engine.recency, engineView.recency_score)
  assert.ok(cand.engine.cats.length >= 4)
  assert.deepEqual(cand.reasons.map((r) => r.code), ['outside_top_comp_limit'])
})

test('system comps keep the stored replay inputs, recover their recency, and show today’s verdict', async () => {
  const { client, asPriced } = workspaceFixture()
  const w = await getCompsWorkspace({ propertyId: 'S1' }, { supabase: client, now: WS_NOW })
  const sys = w.comps.find((c) => c.state === 'system')
  assert.equal(sys.engine.origin, 'stored')
  assert.equal(sys.engine.weight, asPriced.weight)
  assert.equal(sys.engine.adjustedPrice, asPriced.adjusted_price)
  assert.equal(sys.engine.score, asPriced.comp_score)
  assert.equal(sys.engine.completeness, asPriced.data_completeness)
  assert.equal(sys.engine.saleSource, 'mls_sold')
  assert.equal(sys.engine.recency, asPriced.recency_score)
  assert.equal(sys.today.eligible, true)
  assert.equal(typeof sys.today.weight, 'number')
})

test('the stored decision’s method, components, funnel and outlier rule are projected', async () => {
  const { client } = workspaceFixture()
  const w = await getCompsWorkspace({ propertyId: 'S1' }, { supabase: client, now: WS_NOW })
  assert.equal(w.conclusion.method, 'weighted_adjusted_comp_value')
  assert.equal(w.engineRun.version, '2.0.0')
  assert.equal(w.engineRun.computedAt, COMPUTED_AT)
  assert.equal(w.engineRun.components.depth, 12.5)
  assert.deepEqual(w.engineRun.pool, { status: 'comps_selected', rawCandidates: 2, eligibleCandidates: 2, rejectionBreakdown: { outside_top_comp_limit: 1 } })
  assert.equal(w.engineRun.outlier.method, 'insufficient_count_for_mad')
  assert.equal(w.engineRules.radiusMiles, 4)
  assert.equal(w.subject.county, 'Hennepin')
  assert.deepEqual(w.subject.lastSale, { date: '2007-02-13', price: 318000 })
  assert.equal(engineRunFrom(null), null)
})

test('the engine pool input is the RPC row overlaid with the engine’s columns only', () => {
  const row = enginePoolInput({ comp_id: 'x', address: 'A', distance_miles: 1.2, similarity_score: 80 }, { id: 'x', building_square_feet: 900, purchase_info: { a: 1 }, not_an_engine_column: 5 })
  assert.equal(row.id, 'x')
  assert.equal(row.address, 'A')
  assert.equal(row.distance_miles, 1.2)
  assert.equal(row.source, 'v_recent_sold_comps')
  assert.equal(row.building_square_feet, 900)
  assert.equal(row.similarity_score, 80)
  assert.ok(!('purchase_info' in row))
  assert.ok(!('not_an_engine_column' in row))
})

test('each comp says whether its property is canonical, from ONE batched properties read', async () => {
  const { client } = workspaceFixture()
  // P-sys-1 is a tracked property; P-cand-1 is a comp-only parcel (sold, never entered `properties`)
  const tracked = fakeClient({ properties: [SUBJECT_ROW, { property_id: 'P-sys-1' }] }, {})
  const batched = []
  const from = (t) => {
    if (t !== 'properties') return client.from(t)
    const q = tracked.from(t)
    const inFn = q.in
    q.in = (k, v) => { batched.push(v); return inFn(k, v) }
    return q
  }
  const w = await getCompsWorkspace({ propertyId: 'S1' }, { supabase: { from, rpc: client.rpc }, now: WS_NOW })
  assert.equal(w.comps.find((c) => c.compId === 'sys-1').canonicalProperty, true)
  assert.equal(w.comps.find((c) => c.compId === 'cand-1').canonicalProperty, false)
  assert.equal(batched.length, 1)
  assert.deepEqual([...batched[0]].sort(), ['P-cand-1', 'P-sys-1'])
})

test('canonicalPropertyIds: chunked, de-duplicated, and unknown (null) when the read fails', async () => {
  const seen = []
  const client = { from: () => ({ select: () => ({ in: (_k, v) => { seen.push(v.length); return Promise.resolve({ data: v.filter((x) => Number(x) % 2 === 0).map((property_id) => ({ property_id })), error: null }) } }) }) }
  const ids = Array.from({ length: 450 }, (_, i) => String(i)).concat(['2', '2', ''])
  const found = await canonicalPropertyIds(client, ids)
  assert.deepEqual(seen, [200, 200, 50])
  assert.equal(found.has('2'), true)
  assert.equal(found.has('3'), false)
  const failing = { from: () => ({ select: () => ({ in: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }
  assert.equal(await canonicalPropertyIds(failing, ['1']), null)
})
