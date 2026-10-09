/**
 * ONE COMPLETE PAGE (owner, 2026-10-08: "you scroll and cells fill in
 * afterward"). Browse answers with every visible column value and the outreach
 * state attached — no client lazy fill; a failed attachment is named.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { browseEntityGraphPage } from '../../src/lib/domain/entity-graph/entity-graph-browse-page.js'

const page = { ok: true, results: [{ entityType: 'property', entityId: '1', details: { value: 1 } }, { entityType: 'property', entityId: '2', details: {} }], pagination: { total: 2, hasMore: false } }

test('rows arrive with their visible column values and outreach state in the same response', async () => {
  const calls = []
  const out = await browseEntityGraphPage({ tab: 'properties', fields: 'year_built,building_square_feet,raw_payload_json', outreach: '1', page_size: '60' }, {
    browse: async (p) => { calls.push(['browse', p]); return page },
    enrich: async (p) => { calls.push(['enrich', p]); return { values: { 1: { year_built: 1958, building_square_feet: 1400 } } } },
    outreachState: async (p) => { calls.push(['outreach', p]); return { states: { 1: { sms: { eligible: true } }, 2: { sms: null } }, unavailable: [] } },
  })
  assert.ok(!('fields' in calls[0][1]) && !('outreach' in calls[0][1]), 'browse gets only browse params')
  assert.deepEqual(calls.find((c) => c[0] === 'enrich')[1], { fields: 'year_built,building_square_feet', property_ids: '1,2' }, 'whitelisted fields, page ids')
  assert.equal(out.results[0].details.row.year_built, 1958)
  assert.equal(out.results[0].details.value, 1)
  assert.deepEqual(out.results[1].details.row, {}, 'no value stays absent (renders —), never 0')
  assert.equal(out.results[0].details.outreach.sms.eligible, true)
  assert.deepEqual(out.attached.fields, ['year_built', 'building_square_feet'])
  assert.equal(out.attached.errors.length, 0)
})

test('a failed attachment keeps the rows and is named; other tabs are untouched', async () => {
  const out = await browseEntityGraphPage({ tab: 'properties', fields: 'year_built', outreach: '1' }, {
    browse: async () => page,
    enrich: async () => { throw new Error('canceling statement due to statement timeout') },
    outreachState: async () => ({ states: {}, unavailable: [{ source: 'inbox_thread_state', message: 'x' }] }),
  })
  assert.equal(out.results.length, 2)
  assert.deepEqual(out.attached.errors.map((e) => e.source), ['columns', 'outreach.inbox_thread_state'])
  assert.ok(!('row' in out.results[0].details), 'no fabricated values when the read failed')
  let enriched = false
  const owners = await browseEntityGraphPage({ tab: 'master_owners', fields: 'year_built', outreach: '1' }, { browse: async () => ({ results: [{ entityType: 'master_owner', entityId: 'mo1' }] }), enrich: async () => { enriched = true } })
  assert.equal(enriched, false)
  assert.equal(owners.results[0].entityId, 'mo1')
})
