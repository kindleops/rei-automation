/**
 * RC 8.3.2 — a bulk archive answers per item, inside its deadline.
 * 2026-10-04: 11 threads, each write 20-40 s on a saturated database; one
 * request outlived the client's 120 s deadline and all 11 were reported failed
 * although all 11 were archived. A slow item now answers `unconfirmed`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createBulkArchiveService, ITEM_TIMEOUT_MS } from '../../src/lib/domain/archive/bulk-archive-service.js'

const T_FAST = '+15551230101'
const T_SLOW = '+15551230102'

function ports({ slowMs }) {
  return {
    itemTimeoutMs: 40,
    readThreadState: async () => ({ is_archived: false }),
    countActiveSendsForThread: async () => 0,
    patchLeadState: async ({ threadKey }) => {
      if (threadKey === T_SLOW) await new Promise((r) => setTimeout(r, slowMs))
      return { ok: true, row: {} }
    },
  }
}

test('a slow item answers unconfirmed within the item deadline; the fast one is archived', async () => {
  const service = createBulkArchiveService(ports({ slowMs: 300 }))
  const started = Date.now()
  const out = await service.run({ objectType: 'inbox_thread', action: 'archive', ids: [T_FAST, T_SLOW], reason: null }, 'op')
  assert.ok(Date.now() - started < 250, 'the response does not wait for the slow write')
  const byId = Object.fromEntries(out.results.map((r) => [r.id, r]))
  assert.equal(byId[T_FAST].outcome, 'archived')
  assert.equal(byId[T_SLOW].outcome, 'unconfirmed')
  assert.match(byId[T_SLOW].message, /may complete/)
  assert.equal(out.summary.unconfirmed, 1)
  assert.equal(out.summary.failed, 0, 'unconfirmed is not a failure')
  assert.equal(out.partial, true)
})

test('the production item deadline sits under the client per-request deadline (30 s)', () => {
  assert.ok(ITEM_TIMEOUT_MS > 0 && ITEM_TIMEOUT_MS < 30_000)
})
