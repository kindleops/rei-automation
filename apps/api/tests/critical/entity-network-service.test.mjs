import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyHolder, getEntityNetwork } from '@/lib/domain/entity-graph/entity-network-service.js'

test('holder kind comes from the name on title', () => {
  assert.equal(classifyHolder('1822 DODGE AVE LLC'), 'llc')
  assert.equal(classifyHolder('Chicago Title Land Trust Co'), 'trust')
  assert.equal(classifyHolder('ESTATE OF JOHN DOE'), 'estate')
  assert.equal(classifyHolder('Vivid Properties Inc'), 'company')
  assert.equal(classifyHolder('Wells Fargo Bank NA'), 'institution')
  assert.equal(classifyHolder('Maria C Ortega'), 'individual')
})

/** A chainable stub that answers per table and records every selected column list. */
function stubSupabase(tables) {
  const selects = []
  const from = (name) => {
    const rows = tables[name] ?? []
    const q = {
      _rows: rows,
      select(cols) { selects.push([name, cols]); return q },
      eq() { return q }, neq() { return q }, in() { return q }, gt() { return q }, ilike() { return q },
      order() { return q }, limit() { return q },
      maybeSingle() { return Promise.resolve({ data: rows[0] ?? null }) },
      then(res, rej) { return Promise.resolve({ data: rows }).then(res, rej) },
    }
    return q
  }
  return { client: { from }, selects }
}

test('a property network: owner hub, portfolio, entities, people, debt, history — and no legacy scores', async () => {
  const property = {
    property_id: 'p1', master_owner_id: 'mo1', property_address_full: '10 MAIN ST', property_address_city: 'KC', property_address_state: 'mo',
    estimated_value: 200000, total_loan_balance: 150000, equity_amount: 50000, equity_percent: 25, sale_date: '2020-01-02', sale_price: 120000,
    last_sale_doc_type: 'WARRANTY DEED', active_lien: true, owner_address_full: '1 PO BOX',
  }
  const { client, selects } = stubSupabase({
    properties: [property],
    master_owners: [{ master_owner_id: 'mo1', display_name: 'ACME HOLDINGS LLC', property_count: 1, household_key: 'h1', primary_owner_address: '1 PO BOX', joined_property_ids_json: '["p1"]' }],
    sub_owners: [{ sub_owner_id: 's1', master_owner_id: 'mo1', owner_name: 'ACME TRUST' }],
    prospects: [{ prospect_id: 'x1', full_name: 'JANE DOE', is_primary_prospect: true, slot_label: 'phone_numbers[1]' }],
    phones: [{ phone_id: 'ph1', canonical_e164: '+18165550100', primary_prospect_id: 'x1' }],
    emails: [],
    mv_map_sold_comps: [{ comp_id: 'c1', property_id: 'p1', source: 'mls', sold_on: '2024-05-01', price: 180000 }],
    inbox_thread_state: [],
    send_queue: [],
  })
  const n = await getEntityNetwork('property', 'p1', { supabase: client })
  assert.equal(n.owner.kind, 'llc')
  assert.equal(n.properties.length, 1)
  assert.equal(n.properties[0].ltv, 75)
  assert.equal(n.debt.totalLoanBalance, 150000)
  assert.equal(n.entities[0].kind, 'trust')
  assert.equal(n.people[0].role, 'Decision maker')
  assert.ok(n.history.some((e) => e.source === 'mls') && n.history.some((e) => e.source === 'deed'))
  const types = new Set(n.graph.nodes.map((x) => x.type))
  for (const t of ['owner', 'property', 'entity', 'person', 'phone', 'mailing']) assert.ok(types.has(t), t)
  assert.ok(n.graph.edges.some((e) => e.kind === 'owns' && e.to === 'property:p1'))
  const legacy = /(cash_offer|final_acquisition_score|ai_score|structured_motivation_score|deal_strength_score)/
  for (const [, cols] of selects) assert.ok(!legacy.test(String(cols)), `legacy field selected: ${cols}`)
  assert.ok(!legacy.test(JSON.stringify(n)))
})
