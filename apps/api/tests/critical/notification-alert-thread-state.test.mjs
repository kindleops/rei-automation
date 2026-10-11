/**
 * notif-ux (2026-10-10): the alert list carries each inbox alert's thread reply
 * state + seller name (read-only enrichment; the client expires answered alerts).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyThreadReplyState, attachThreadReplyState, threadKeyOfRow } from '../../src/lib/domain/notifications/notification-thread-state.js'

const row = (id, over = {}) => ({ id, domain: 'inbox', source_entity_type: 'thread', source_entity_id: '+16125550101', created_at: '2026-10-10T10:00:00.000Z', ...over })

test('thread key: inbox rows on a thread (inbound "thread" and workflow "seller_thread"); never a campaign', () => {
  assert.equal(threadKeyOfRow(row('a')), '+16125550101')
  assert.equal(threadKeyOfRow(row('b', { source_entity_type: 'seller_thread' })), '+16125550101')
  assert.equal(threadKeyOfRow(row('c', { domain: 'campaigns', source_entity_type: 'campaign' })), null)
})

test('apply: latest outbound per thread + the first named inbound; other rows untouched', () => {
  const rows = [row('a'), row('b', { source_entity_id: '+16125550199' }), { id: 'c', domain: 'campaigns', source_entity_type: 'campaign', source_entity_id: 'c1' }]
  const out = applyThreadReplyState(rows, [
    { thread_key: '+16125550101', created_at: '2026-10-10T11:00:00.000Z' },
    { thread_key: '+16125550101', created_at: '2026-10-10T12:00:00.000Z' },
  ], [{ thread_key: '+16125550101', seller_display_name: 'Sondra E' }])
  assert.equal(out[0].thread_last_outbound_at, '2026-10-10T12:00:00.000Z')
  assert.equal(out[0].seller_display_name, 'Sondra E')
  assert.equal(out[1].thread_last_outbound_at, null)
  assert.equal(out[1].seller_display_name, null)
  assert.deepEqual(out[2], rows[2])
})

function fakeDb({ fail = false } = {}) {
  const calls = []
  const db = {
    calls,
    from(table) {
      const q = { table, filters: [] }
      calls.push(q)
      const chain = {
        select(cols) { q.cols = cols; return chain },
        eq(c, v) { q.filters.push(['eq', c, v]); return chain },
        in(c, v) { q.filters.push(['in', c, v]); return chain },
        gte(c, v) { q.filters.push(['gte', c, v]); return chain },
        not(c, op, v) { q.filters.push(['not', c, op, v]); return chain },
        order() { return chain },
        limit(n) { q.limit = n; return chain },
        then(resolve) {
          if (fail) return resolve({ data: null, error: { message: 'boom' } })
          const dir = q.filters.find((f) => f[1] === 'direction')?.[2]
          return resolve({ data: dir === 'outbound' ? [{ thread_key: '+16125550101', created_at: '2026-10-10T12:00:00.000Z' }] : [{ thread_key: '+16125550101', seller_display_name: 'Sondra E' }], error: null })
        },
      }
      return chain
    },
  }
  return db
}

test('attach: two read-only selects on message_events, bounded by the oldest alert; writes nothing', async () => {
  const db = fakeDb()
  const out = await attachThreadReplyState([row('a'), row('b', { created_at: '2026-10-09T10:00:00.000Z' })], { db })
  assert.equal(out[0].thread_last_outbound_at, '2026-10-10T12:00:00.000Z')
  assert.equal(out[0].seller_display_name, 'Sondra E')
  assert.equal(db.calls.length, 2)
  assert.ok(db.calls.every((c) => c.table === 'message_events'))
  const outbound = db.calls.find((c) => c.filters.some((f) => f[2] === 'outbound'))
  assert.deepEqual(outbound.filters.find((f) => f[0] === 'gte'), ['gte', 'created_at', '2026-10-09T10:00:00.000Z'])
})

test('attach: a failed read leaves the rows exactly as they were; no inbox rows → no read', async () => {
  const rows = [row('a')]
  assert.deepEqual(await attachThreadReplyState(rows, { db: fakeDb({ fail: true }) }), rows)
  const db = fakeDb()
  await attachThreadReplyState([{ id: 'c', domain: 'campaigns' }], { db })
  assert.equal(db.calls.length, 0)
})
