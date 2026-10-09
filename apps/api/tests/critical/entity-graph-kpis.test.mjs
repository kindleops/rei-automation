/**
 * "Portfolio stacks: Not available" flickered (owner, 2026-10-08): a single
 * timed-out exact count was cached as null for ten minutes. A null never
 * replaces a recent measured value; it is retried once and never cached.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { getEntityGraphKpis } from '../../src/lib/domain/entity-graph/entity-graph-kpis.js'

function client(failing = new Set(), calls = []) {
  return {
    from(table) {
      const tags = [table]
      const q = {
        select() { return q }, not(c) { tags.push(`not:${c}`); return q }, gte(c) { tags.push(`gte:${c}`); return q },
        then(res, rej) {
          const key = tags.join('|')
          calls.push(key)
          if ([...failing].some((f) => key.includes(f))) return Promise.resolve({ count: null, error: { message: 'canceling statement due to statement timeout' } }).then(res, rej)
          return Promise.resolve({ count: 11363, error: null }).then(res, rej)
        },
      }
      return q
    },
  }
}

test('a timed-out count keeps the last good value (marked stale) and is retried once', async () => {
  const lastGood = new Map()
  const first = await getEntityGraphKpis({ supabase: client(), lastGood, now: 1_000 })
  assert.equal(first.portfolioOwners, 11363)
  const calls = []
  const second = await getEntityGraphKpis({ supabase: client(new Set(['gte:property_count']), calls), lastGood, now: 60_000 })
  assert.equal(second.portfolioOwners, 11363)
  assert.equal(second.stale.portfolioOwners, new Date(1_000).toISOString())
  assert.equal(calls.filter((c) => c.includes('gte:property_count')).length, 2, 'retried once')
  const cold = await getEntityGraphKpis({ supabase: client(new Set(['gte:property_count'])), lastGood: new Map(), now: 60_000 })
  assert.equal(cold.portfolioOwners, null, 'never invented when nothing was measured')
})
