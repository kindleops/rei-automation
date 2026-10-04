/**
 * Pipeline table column enrichment: only visible, whitelisted columns; keyed
 * reads only; absent stays absent (never a fabricated 0).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { getPipelineColumnEnrichment, parseEnrichmentFields, MAX_IDS } from '../../src/lib/domain/opportunity/pipeline-column-enrichment.js'

function fakeClient(rowsByTable) {
  const calls = []
  return {
    calls,
    from(table) {
      const call = { table, select: null, key: null, ids: null }
      calls.push(call)
      const q = {
        select(cols) { call.select = cols; return q },
        in(key, ids) {
          call.key = key; call.ids = ids
          return Promise.resolve({ data: (rowsByTable[table] || []).filter((r) => ids.includes(String(r[key]))), error: null })
        },
      }
      return q
    },
  }
}

test('unknown or non-whitelisted fields are dropped', () => {
  const f = parseEnrichmentFields('property.year_built,property.raw_payload_json,scores.decision_tier,nope.x,owner.best_language,property.year_built')
  assert.deepEqual(f, { property: ['year_built'], owner: ['best_language'], scores: ['decision_tier'] })
})

test('reads only the tables and columns that visible fields need, keyed by id', async () => {
  const client = fakeClient({ properties: [{ property_id: 'P1', year_built: 1958, total_bedrooms: null }] })
  const out = await getPipelineColumnEnrichment({ fields: 'property.year_built,property.total_bedrooms', property_ids: 'P1,P2', owner_ids: 'M1' }, { supabase: client })
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls[0].table, 'properties')
  assert.equal(client.calls[0].select, 'property_id,year_built,total_bedrooms')
  assert.equal(client.calls[0].key, 'property_id')
  assert.deepEqual(client.calls[0].ids, ['P1', 'P2'])
  // a null column is absent, and a property with no row is absent — never 0
  assert.deepEqual(out.property, { P1: { year_built: 1958 } })
  assert.deepEqual(out.scores, {})
})

test('no visible enrichment field: no read at all', async () => {
  const client = fakeClient({})
  await getPipelineColumnEnrichment({ fields: '', property_ids: 'P1' }, { supabase: client })
  assert.equal(client.calls.length, 0)
})

test('ids are capped and chunked', async () => {
  const ids = Array.from({ length: MAX_IDS + 50 }, (_, i) => `P${i}`).join(',')
  const client = fakeClient({})
  await getPipelineColumnEnrichment({ fields: 'scores.aos_score', property_ids: ids }, { supabase: client })
  const total = client.calls.reduce((s, c) => s + c.ids.length, 0)
  assert.equal(total, MAX_IDS)
  assert.ok(client.calls.every((c) => c.ids.length <= 150 && c.table === 'property_acquisition_scores'))
})

test('extended card fields come only from what the feed loaded; absent is null', async () => {
  const { extendedCardFields } = await import('../../src/lib/domain/opportunity/pipeline-command-service.js')
  const ext = extendedCardFields({ aos: '71', motivation_score: null, priority: ' high ' }, { is_read: false, snoozed_until: null, pending_queue_count: 0, inbox_bucket: 'needs_reply' })
  assert.equal(ext.aos, 71)
  assert.equal(ext.motivation, null)
  assert.equal(ext.priority, 'high')
  assert.equal(ext.unread, true)
  assert.equal(ext.pendingQueue, 0)
  assert.equal(ext.inboxBucket, 'needs_reply')
  const none = extendedCardFields({}, null)
  assert.equal(none.unread, null)
  assert.equal(none.messageCount, null)
})
