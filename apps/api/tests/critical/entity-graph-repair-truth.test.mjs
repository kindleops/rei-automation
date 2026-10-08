/**
 * Repair estimate plausibility (owner 2026-10-08: "$71M on a $3M property").
 * Root cause: vendor estimated_repair_cost = $/sqft × building_square_feet, and
 * the sqft on large / multi-parcel records is wrong (18 units at 2,184,392 sqft).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { repairTruth, withRepairTruth } from '../../src/lib/domain/entity-graph/entity-graph-truth.js'
import { getEntityGraphColumnEnrichment } from '../../src/lib/domain/entity-graph/entity-graph-column-enrichment.js'

test('the measured absurd record is withheld, with the reason', () => {
  const t = repairTruth({ estimated_repair_cost: 76453720, estimated_value: 3414768, building_square_feet: 2184392, units_count: 18 })
  assert.deepEqual(t, { value: null, status: 'unreliable', reason: 'building_sqft_implausible' })
  assert.equal(repairTruth({ estimated_repair_cost: 1792000, estimated_value: 1397731, building_square_feet: 51200, units_count: 128 }).reason, 'exceeds_share_of_value')
  assert.equal(repairTruth({ estimated_repair_cost: 40000, estimated_value: null }).reason, 'no_value_to_check_against')
  assert.deepEqual(repairTruth({ estimated_repair_cost: 42000, estimated_value: 250000, building_square_feet: 1200, units_count: 1 }), { value: 42000, status: 'vendor_estimate', reason: null })
  assert.equal(repairTruth({}).status, 'unknown')
  assert.equal(withRepairTruth({ estimated_repair_cost: 76453720, estimated_value: 3414768 }).estimated_repair_cost, null)
})

test('the column enrichment never returns an implausible repair estimate', async () => {
  const rows = [
    { property_id: '1', estimated_repair_cost: 76453720, estimated_value: 3414768, building_square_feet: 2184392, units_count: 18 },
    { property_id: '2', estimated_repair_cost: 42000, estimated_value: 250000, building_square_feet: 1200, units_count: 1 },
  ]
  const supabase = { from: () => ({ select() { return this }, in() { return Promise.resolve({ data: rows, error: null }) } }) }
  const { values } = await getEntityGraphColumnEnrichment({ property_ids: '1,2', fields: 'estimated_repair_cost' }, { supabase })
  assert.deepEqual(values['1'], { estimated_repair_cost_status: 'unreliable' })
  assert.equal(values['2'].estimated_repair_cost, 42000)
  assert.ok(!('estimated_value' in values['2']), 'helper columns are not leaked as values')
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
