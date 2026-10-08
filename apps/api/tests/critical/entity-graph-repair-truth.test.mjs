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
