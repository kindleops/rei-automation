/**
 * Repair estimate (owner 2026-10-08) + equity truth + ZIP context.
 * Root cause: vendor estimated_repair_cost = a flat $/sqft tier × building_square_feet;
 * the sqft on large / multi-parcel records is wrong (18 units at 2,184,392 sqft).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { repairTruth, withRepairTruth } from '../../src/lib/domain/entity-graph/entity-graph-truth.js'
import { getEntityGraphColumnEnrichment } from '../../src/lib/domain/entity-graph/entity-graph-column-enrichment.js'

/*
 * Owner 2026-10-08 ("the repair est for the entity graph is completely
 * fucked"; valuation lanes BINDING: SFR = investor cluster −13%, NO repairs;
 * repairs only in the MLS ARV lane; MF5+ per door). The vendor figure is a
 * flat $15/$35/$75 tier × building sqft: never a property field anywhere in
 * Entity Graph; only an "MLS ARV lane · vendor reference" for SFR / 2–4 that
 * passes the data-derived bounds.
 */
test('repair truth: lanes + data bounds; the measured absurd records never pass', () => {
  // 392-unit $111M apartment with a $13M "repair": MF5+ is never a repair lane
  assert.equal(repairTruth({ estimated_repair_cost: 13000000, estimated_value: 111000000, building_square_feet: 371000, units_count: 392, property_type: 'Apartment' }).status, 'not_applicable')
  // 18 units at 2,184,392 sqft → $76M on $3.4M
  assert.equal(repairTruth({ estimated_repair_cost: 76453720, estimated_value: 3414768, building_square_feet: 2184392, units_count: 18, property_type: 'Multi-Family' }).status, 'not_applicable')
  const sfr = (o) => repairTruth({ property_type: 'Single Family', units_count: 1, estimated_value: 250000, building_square_feet: 1200, estimated_repair_cost: 42000, ...o })
  assert.deepEqual(sfr({}), { value: 42000, status: 'vendor_reference', reason: null, lane: 'sfr', label: 'vendor estimate · unverified' })
  assert.equal(sfr({ building_square_feet: 9000, estimated_repair_cost: 315000, estimated_value: 900000 }).reason, 'building_sqft_implausible')
  assert.equal(sfr({ building_square_feet: 250 }).reason, 'building_sqft_implausible')
  assert.equal(sfr({ estimated_repair_cost: 120000 }).reason, 'rate_above_vendor_tiers') // $100/sqft
  assert.equal(sfr({ estimated_value: 70000 }).reason, 'exceeds_share_of_value')
  assert.equal(sfr({ estimated_value: null }).reason, 'no_value_to_check_against')
  assert.equal(sfr({ building_square_feet: null }).reason, 'no_building_sqft')
  assert.equal(repairTruth({ property_type: 'Multi-Family', units_count: 4, estimated_value: 900000, building_square_feet: 4000, estimated_repair_cost: 140000 }).lane, 'mf2_4')
  assert.equal(repairTruth({ property_type: 'Multi-Family', units_count: 2, estimated_value: 900000, building_square_feet: 2000, estimated_repair_cost: 400000 }).reason, 'rate_above_vendor_tiers')
  assert.equal(repairTruth({ property_type: 'Vacant Land', estimated_repair_cost: 1000, estimated_value: 50000 }).status, 'not_applicable')
  assert.equal(repairTruth({}).status, 'unknown')
})

test('withRepairTruth: the raw vendor columns never travel; a plausible SFR figure moves to the MLS ARV lane reference', () => {
  const absurd = withRepairTruth({ property_id: '1', estimated_repair_cost: 76453720, estimated_repair_cost_per_sqft: 35, estimated_value: 3414768, property_type: 'Multi-Family', units_count: 18 })
  assert.ok(!('estimated_repair_cost' in absurd) && !('estimated_repair_cost_per_sqft' in absurd) && !('mls_arv_lane_reference' in absurd))
  const ok = withRepairTruth({ property_id: '2', estimated_repair_cost: 42000, estimated_value: 250000, building_square_feet: 1200, units_count: 1, property_type: 'Single Family' })
  assert.ok(!('estimated_repair_cost' in ok))
  assert.deepEqual(ok.mls_arv_lane_reference, { vendor_repair_estimate: 42000, lane: 'sfr', label: 'vendor estimate · unverified' })
})

test('the column enrichment refuses the repair columns entirely (not a grid field)', async () => {
  const { parseEntityGraphColumnFields } = await import('../../src/lib/domain/entity-graph/entity-graph-column-enrichment.js')
  assert.deepEqual(parseEntityGraphColumnFields('estimated_repair_cost,estimated_repair_cost_per_sqft,scores.estimated_repairs,year_built'), ['year_built'])
  let called = false
  const supabase = { from: () => { called = true; return { select() { return this }, in() { return Promise.resolve({ data: [], error: null }) } } } }
  const { values } = await getEntityGraphColumnEnrichment({ property_ids: '1,2', fields: 'estimated_repair_cost' }, { supabase })
  assert.deepEqual(values, {})
  assert.equal(called, false)
})

test('equity: a recorded-documents answer beats the vendor flag', async () => {
  const { equityTruth } = await import('../../src/lib/domain/entity-graph/entity-graph-truth.js')
  assert.deepEqual(equityTruth({ estimated_value: 472000, total_loan_balance: 0, property_flags_text: 'High Equity', rec_mortgage_count: 0 }), { known: true, percent: 100, amount: 472000, class: 'high', rule: 'no_recorded_mortgage' })
  assert.equal(equityTruth({ estimated_value: 400000, total_loan_balance: null, rec_mortgage_balance: 100000, rec_mortgage_count: 1 }).percent, 75)
  // no records captured: still only the flag class, never a fabricated 100%
  assert.equal(equityTruth({ estimated_value: 472000, total_loan_balance: 0, property_flags_text: 'High Equity' }).rule, 'vendor_high_equity_flag')
})

test('zip context: MI rollup of the current ready build, buyers on request, demographics unavailable when census is empty', async () => {
  const { getEntityGraphZipContext, __zipContextTest } = await import('../../src/lib/domain/entity-graph/entity-graph-zip-context.js')
  __zipContextTest.reset()
  const calls = []
  const tables = {
    mi_rollup_builds: [{ build_id: 10, status: 'ready' }, { build_id: 9, status: 'superseded' }],
    mi_geo_period_rollup: [
      { build_id: 10, geo_level: 'zip', asset: 'all', period: '1y', geo_key: '75001', sale_count: 100, investor_count: 3, buyer_known_count: 9, cash_known_count: 4, cash_count: 1, median_price: 653229, median_ppsf: 275, latest_sale: '2026-08-13' },
      { build_id: 10, geo_level: 'zip', asset: 'all', period: '90d', geo_key: '75001', sale_count: 23 },
    ],
    census_geo_metrics: [],
    eg_buyer_index: [{ buyer_id: 'a', zips: ['75001'], activity_status: 'active' }, { buyer_id: 'b', zips: ['75001'], activity_status: 'slowing' }],
  }
  const q = (t) => {
    const preds = []; let head = false; let count = false
    const api = {
      select(_c, o = {}) { head = !!o.head; count = !!o.count; return api },
      eq(c, v) { preds.push((r) => String(r[c]) === String(v)); return api },
      in(c, vs) { preds.push((r) => vs.map(String).includes(String(r[c]))); return api },
      overlaps(c, vs) { preds.push((r) => (r[c] || []).some((x) => vs.includes(x))); return api },
      order() { return api }, limit() { return api },
      then(res) { calls.push(t); const rows = (tables[t] || []).filter((r) => preds.every((p) => p(r))); return Promise.resolve({ data: head ? null : rows, count: count ? rows.length : null, error: null }).then(res) },
    }
    return api
  }
  const out = await getEntityGraphZipContext({ zips: '75001,abc', buyers: '1' }, { supabase: { from: q } })
  const z = out.zips['75001']
  assert.equal(out.buildId, 10)
  assert.deepEqual([z.sales1y, z.sales90d, z.investorShare1y, z.cashShare1y, z.medianPrice1y], [100, 23, 33, 25, 653229])
  assert.deepEqual([z.buyers, z.activeBuyers], [2, 1])
  assert.equal(z.demographics, null)
  assert.equal(out.demographicsAvailable, false)
  assert.ok(!('abc' in out.zips))
})
