// FIXTURE-backed per-tool behaviour, empty results and not-found.
import test from 'node:test'
import assert from 'node:assert/strict'
import { connect, call } from './helpers.mjs'
import { FIXTURE_CAMPAIGN, FIXTURE_CAMPAIGN_2 } from '../fixtures/dataset.mjs'

let c
test.before(async () => { c = await connect() })
test.after(async () => { await c.close() })

const ok = async (name, args) => {
  const r = await call(c.client, name, args)
  assert.ok(!r.isError, `${name}: ${JSON.stringify(r.structuredContent?.error)}`)
  assert.equal(r.structuredContent.data_mode, 'fixture')
  assert.match(r.structuredContent.fixture_notice, /FIXTURE DATA/)
  return r.structuredContent
}
const fails = async (name, args, cls) => {
  const r = await call(c.client, name, args)
  assert.equal(r.isError, true, `${name} should fail`)
  assert.equal(r.structuredContent.error.class, cls, JSON.stringify(r.structuredContent.error))
  return r.structuredContent.error
}

test('search_leads: anchor + filters, lead state only', async () => {
  const s = await ok('leadcommand_search_leads', { market: 'Fixture Metro, TX', conversation_stage: 'S3' })
  assert.equal(s.result.rows.length, 1)
  const l = s.result.rows[0]
  assert.equal(l.lead_id, 'FX1001')
  assert.equal(l.pipeline.deal_linked, true)
  assert.equal(l.decision_engine.aos_score, 71)
  assert.equal('address' in l, false, 'lead list carries no street address')
})

test('search_leads: an unscored lead reports decision_engine missing, never 0', async () => {
  const s = await ok('leadcommand_search_leads', { zip: '75001', limit: 25 })
  const unscored = s.result.rows.find((r) => r.property_id === 'FX1002')
  assert.equal(unscored.decision_engine.aos_score, null)
  assert.equal(unscored.decision_engine.provenance.kind, 'missing')
})

test('get_lead: outreach with stage source, no message text', async () => {
  const s = await ok('leadcommand_get_lead', { property_id: 'FX1001' })
  assert.deepEqual(s.result.outreach.stage, { value: 'offer', source: 'pipeline' })
  assert.equal(s.result.message_text.included, false)
  assert.deepEqual(Object.keys(s.result.outreach.conversation).sort(), ['at', 'direction', 'suppressed'])
})

test('search_properties: anchor search and address lookup', async () => {
  const s = await ok('leadcommand_search_properties', { zip: '75001', units_min: 2 })
  assert.deepEqual(s.result.rows.map((r) => r.property_id), ['FX1002'])
  assert.equal(s.result.mode, 'keyset')
  const a = await ok('leadcommand_search_properties', { address: '101 Fixture Way' })
  assert.equal(a.result.mode, 'address_lookup')
  assert.equal(a.result.rows[0].property_id, 'FX1001')
  assert.equal(a.page.next_cursor, null)
})

test('search_properties: city anchor needs state; city+state works case-insensitively', async () => {
  await fails('leadcommand_search_properties', { city: 'Testville' }, 'unsupported_filter')
  const s = await ok('leadcommand_search_properties', { city: 'testville', state: 'tx', limit: 3 })
  assert.equal(s.result.rows.length, 3)
})

test('get_property: facts, ownership shape, recorded docs, distress side by side', async () => {
  const s = await ok('leadcommand_get_property', { property_id: 'FX1001' })
  assert.equal(s.result.ownership.owner_kind, 'individual')
  assert.equal(s.result.recorded_documents.mortgages[1].lender, null, 'private lender withheld')
  assert.equal(s.result.distress.preforeclosure.verdict, 'STILL_IN_PREFORECLOSURE')
  assert.equal(s.result.distress.preforeclosure.evidence_host, 'records.example.test')
  assert.equal(JSON.stringify(s).includes('records.example.test/case'), false, 'evidence URL never returned')
})

test('get_property: missing recorded documents are "unavailable", not empty', async () => {
  const s = await ok('leadcommand_get_property', { property_id: 'FX1002' })
  assert.equal(s.result.recorded_documents.available, false)
  assert.equal(s.result.recorded_documents.provenance.kind, 'missing')
})

test('get_acquisition_score: current / stale / not run', async () => {
  const cur = await ok('leadcommand_get_acquisition_score', { property_id: 'FX1001' })
  assert.equal(cur.result.status, 'current')
  assert.equal(cur.result.valuation.band.mid, 172000)
  assert.equal(JSON.stringify(cur).includes('98000'), false, 'minimum acceptable offer withheld')
  assert.equal(JSON.stringify(cur).includes('fixture_withheld'), false, 'owner situation / angle withheld')
  const stale = await ok('leadcommand_get_acquisition_score', { property_id: 'FX1003' })
  assert.equal(stale.result.status, 'decision_engine_stale_for_current_state')
  assert.equal(stale.result.provenance.kind, 'stale')
  assert.deepEqual(stale.result.freshness.changed_inputs, [{ scope: 'property', field: 'estimated_value' }])
  const none = await ok('leadcommand_get_acquisition_score', { property_id: 'FX1002' })
  assert.equal(none.result.available, false)
  assert.equal(none.result.scores, null)
  assert.equal(none.result.provenance.kind, 'missing')
})

test('get_market_intelligence: by zip, by property, and an absent zip', async () => {
  const z = await ok('leadcommand_get_market_intelligence', { zip: '75001' })
  assert.equal(z.result.metrics.sales_1y, 61)
  assert.equal('demographics' in z.result, false)
  const p = await ok('leadcommand_get_market_intelligence', { property_id: 'FX1001' })
  assert.equal(p.result.resolved_from, 'property_record')
  const empty = await ok('leadcommand_get_market_intelligence', { zip: '99999' })
  assert.equal(empty.result.available, false)
  assert.equal(empty.result.metrics, null)
  assert.equal(empty.result.provenance.kind, 'missing')
})

test('search_comps: nearest first, lane filter, buyer evidence basis, not a valuation', async () => {
  const s = await ok('leadcommand_search_comps', { property_id: 'FX1001' })
  const ids = s.result.rows.map((r) => r.comp_id)
  assert.deepEqual(ids, ['cmp-1', 'cmp-3', 'cmp-2'], 'MF comp and the far comp excluded')
  const noBuyer = s.result.rows.find((r) => r.comp_id === 'cmp-3')
  assert.equal(noBuyer.buyer.basis, 'not_on_record')
  assert.equal(noBuyer.buyer.provenance.kind, 'missing')
  for (const r of s.result.rows) assert.equal(r.buyer.current_owner_link, 'not_evaluated', 'a deed buyer is never asserted to be the current owner')
  assert.equal(s.result.rows[0].investor.inferred_provenance.kind, 'inferred')
  assert.equal(JSON.stringify(s).includes('FIXTURE HOLDINGS'), false, 'buyer names withheld')
  const all = await ok('leadcommand_search_comps', { property_id: 'FX1001', same_lane_only: false })
  assert.ok(all.result.rows.some((r) => r.comp_id === 'cmp-4'))
})

test('search_comps: empty result when nothing sold in the window', async () => {
  const near = await ok('leadcommand_search_comps', { property_id: 'FX1001', months: 3, radius_miles: 0.25 })
  assert.deepEqual(near.result.rows.map((r) => r.comp_id), ['cmp-1'])
  const s = await ok('leadcommand_search_comps', { property_id: 'FX9001' })
  assert.deepEqual(s.result.rows, [])
  assert.equal(s.result.search.rows_read, 0)
})

test('get_campaign_metrics: one campaign with exact status counts; list mode; caveat present', async () => {
  const s = await ok('leadcommand_get_campaign_metrics', { campaign_id: FIXTURE_CAMPAIGN })
  assert.equal(s.result.targets.total, 10)
  assert.deepEqual(s.result.targets.by_status, { ready: 6, blocked: 3 })
  assert.equal(s.result.targets.other_statuses, 1)
  assert.match(s.result.campaigns[0].counters.caveat, /under-count/)
  assert.equal(s.result.campaigns[0].audience.pinned_property_count, 3)
  assert.equal(JSON.stringify(s).includes('FX1001'), false, 'pinned ids are counted, never returned')
  const list = await ok('leadcommand_get_campaign_metrics', { status: 'draft' })
  assert.deepEqual(list.result.campaigns.map((x) => x.campaign_id), [FIXTURE_CAMPAIGN_2])
  assert.equal(list.result.targets, null)
})

test('get_lead_contact_status: handles, eligibility and suppression state', async () => {
  const s = await ok('leadcommand_get_lead_contact_status', { property_id: 'FX1001' })
  assert.deepEqual(s.result.contacts.map((x) => x.contact), ['C1', 'C2'])
  assert.equal(s.result.eligibility.eligible, true)
})

test('not_found: unknown ids on every per-record tool', async () => {
  for (const n of ['leadcommand_get_lead', 'leadcommand_get_property', 'leadcommand_search_comps', 'leadcommand_get_lead_contact_status']) await fails(n, { property_id: 'NOPE404' }, 'not_found')
  await fails('leadcommand_get_market_intelligence', { property_id: 'NOPE404' }, 'not_found')
  await fails('leadcommand_get_campaign_metrics', { campaign_id: '00000000-0000-4000-8000-00000000dead' }, 'not_found')
})

test('empty results: anchored searches with no match return rows: [] and no cursor', async () => {
  const s = await ok('leadcommand_search_leads', { market: 'Nowhere, ZZ' })
  assert.deepEqual(s.result.rows, [])
  assert.equal(s.page.has_more, false)
  assert.equal(s.page.next_cursor, null)
  const p = await ok('leadcommand_search_properties', { zip: '00000' })
  assert.deepEqual(p.result.rows, [])
})
