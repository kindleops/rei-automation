/**
 * PERSON FIELDS FOR EVERY PROPERTY (owner P0 2026-10-10: "owner age, language,
 * gender, marital status, net worth / income and net asset value, many of
 * which are empty").
 *
 * public.prospects holds only the April + May imports, so the 52,556
 * compact-import properties had no person in Entity Graph. The same vendor
 * person is in seller.owner (keyed by individual_key = the campaign graph's
 * seller_person_key) and the deed owner resolves to a person in
 * seller.property_owner_resolution_v1. Person facts now fall back, field by
 * field: prospects → seller.owner (graph contact) → seller.owner (deed owner,
 * confirmed / high confidence only). Read-only, keyed; the 1.3 M-row
 * seller.owner is never scanned. Protected classes stay display / targeting
 * only (sensitive marker; never a pricing input).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { computeFacts, mergePerson } from '../../src/lib/domain/entity-graph/entity-graph-facts.js'

const PERSON = ['person_gender', 'person_marital_status', 'person_language_preference', 'person_est_household_income', 'person_net_asset_value', 'person_age', 'person_source']

function fake({ graph = [], prospects = [], owners = [], resolution = [], seen = [] }) {
  const keyed = (rows, params, key) => (params && Array.isArray(params[0]) ? rows.filter((r) => params[0].includes(r[key])) : rows)
  return async (sql, params = []) => {
    seen.push({ sql, keyed: Boolean(params && Array.isArray(params[0])) })
    if (/from public\.campaign_target_graph/.test(sql)) return { rows: keyed(graph, params, 'property_id') }
    if (/from seller\.property_owner_resolution_v1/.test(sql)) return { rows: keyed(resolution, params, 'property_id') }
    if (/from seller\.owner o/.test(sql)) return { rows: keyed(owners, params, 'individual_key') }
    if (/from public\.prospects p where/.test(sql)) return { rows: keyed(prospects, params, 'individual_key') }
    return { rows: [] }
  }
}

test('field-by-field: prospects first, then seller.owner for the graph person, then the resolved deed owner', () => {
  const m = mergePerson([
    ['prospect', { gender: 'F', marital_status: null, mob: '' }],
    ['seller_owner_contact', { gender: 'M', marital_status: 'Married', mob: '195503' }],
    ['seller_owner_deed', { net_asset_value: '$250K-$500K' }],
  ])
  assert.equal(m.person.gender, 'F', 'the prospect value wins where it exists')
  assert.equal(m.person.marital_status, 'Married')
  assert.equal(m.person.mob, '195503')
  assert.equal(m.person.net_asset_value, '$250K-$500K')
  assert.equal(m.source, 'seller_owner_contact', 'the source that supplied most fields')
  assert.deepEqual(mergePerson([['prospect', null], ['seller_owner_contact', null], ['seller_owner_deed', null]]), { person: null, source: null })
})

test('a compact-import property (no prospect) gets its person from seller.owner via the campaign graph person', async () => {
  const now = new Date('2026-10-10T12:00:00Z')
  const graph = [{ property_id: 'c1', seller_person_key: 'K1', best_phone_score: 80 }]
  const owners = [{ individual_key: 'K1', mob: '195510', gender: 'Female', marital_status: 'Married', language_preference: 'English', est_household_income: '$75K-$100K', net_asset_value: '$500K-$750K' }]
  const facts = await computeFacts([{ property_id: 'c1' }], PERSON, { query: fake({ graph, owners }), now })
  assert.deepEqual(facts.get('c1'), {
    person_gender: 'Female', person_marital_status: 'Married', person_language_preference: 'English',
    person_est_household_income: '$75K-$100K', person_net_asset_value: '$500K-$750K', person_age: 71, person_source: 'seller_owner_contact',
  })
})

test('no graph person: the deed owner resolved (confirmed / high) to a person supplies the fields; nothing → null, never a guess', async () => {
  const resolution = [{ property_id: 'd1', individual_key: 'K9', owner_resolution_status: 'confirmed', owner_role: 'primary_legal_owner' }]
  const owners = [{ individual_key: 'K9', gender: 'Male', mob: null }]
  const facts = await computeFacts([{ property_id: 'd1' }, { property_id: 'd2' }], PERSON, { query: fake({ resolution, owners }) })
  assert.equal(facts.get('d1').person_gender, 'Male')
  assert.equal(facts.get('d1').person_age, null)
  assert.equal(facts.get('d1').person_source, 'seller_owner_deed')
  assert.deepEqual(Object.values(facts.get('d2')), PERSON.map(() => null))
})

test('the resolution read keeps only confirmed / high-confidence primary legal owners (SQL predicate)', async () => {
  const seen = []
  await computeFacts([{ property_id: 'x' }], ['person_gender'], { query: fake({ seen }) })
  const sql = seen.find((s) => /property_owner_resolution_v1/.test(s.sql)).sql
  assert.match(sql, /owner_role = 'primary_legal_owner'/)
  assert.match(sql, /owner_resolution_status in \('confirmed', 'high_confidence'\)/)
  assert.ok(!/medium_confidence/.test(sql))
})

test('seller.owner (1.3 M rows) is always read by key — even on the universe pass that scans the other sources', async () => {
  const seen = []
  const graph = [{ property_id: 'a', seller_person_key: 'K1' }, { property_id: 'b', seller_person_key: 'K2' }]
  await computeFacts([{ property_id: 'a' }, { property_id: 'b' }], ['person_gender'], { query: fake({ graph, seen }), keyedMax: 0 })
  const owner = seen.filter((s) => /from seller\.owner o/.test(s.sql))
  assert.ok(owner.length >= 1)
  assert.ok(owner.every((s) => s.keyed), 'seller.owner read with a key array')
  assert.ok(seen.filter((s) => /campaign_target_graph/.test(s.sql)).every((s) => !s.keyed), 'the graph is scanned once (keyedMax 0)')
})
