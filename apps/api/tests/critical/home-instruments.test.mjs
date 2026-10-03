/**
 * HOME INSTRUMENTS — pure rules + route contract (no network, no database).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { holdCodeOf, splitMarket, summarizeDeals } from '../../src/lib/domain/home/home-instruments-service.js'
import { createHomeInstrumentsRoutes } from '../../src/lib/domain/home/home-instruments-routes.js'

test('market labels split into city + state, garbage is ignored', () => {
  assert.deepEqual(splitMarket('Dallas, TX'), { city: 'Dallas', state: 'TX', label: 'Dallas, TX' })
  assert.equal(splitMarket('Unknown market'), null)
  assert.equal(splitMarket(''), null)
})

test('deal summary applies Deal Intelligence gates and only live offers', () => {
  const opps = [{ id: 'o1', primary_property_id: 'p1' }, { id: 'o2', primary_property_id: 'p2' }, { id: 'o3', primary_property_id: 'p3' }]
  const scores = [
    { property_id: 'p1', decision_tier: 'REVIEW_REQUIRED', confidence: 90, valuation_confidence: 85, computed_at: '2026-10-01' },
    { property_id: 'p1', decision_tier: 'NURTURE', confidence: 50, valuation_confidence: 50, computed_at: '2026-09-01' },
    { property_id: 'p2', decision_tier: 'AUTO_RANGE_OFFER', confidence: 84, valuation_confidence: 90, computed_at: '2026-10-01' },
  ]
  const offers = [{ id: 'a', status: 'sent', superseded_at: null }, { id: 'b', status: 'sent', superseded_at: '2026-10-02' }, { id: 'c', status: 'withdrawn', superseded_at: null }]
  const d = summarizeDeals(opps, scores, offers)
  assert.equal(d.active, 3)
  assert.equal(d.scored, 2)
  assert.equal(d.unscored, 1)
  assert.equal(d.review, 1) // latest score wins: p1 is REVIEW_REQUIRED, not NURTURE
  assert.equal(d.lowConfidence, 1) // p2 confidence 84 < 85
  assert.equal(d.offersAwaiting, 1)
})

test('hold code prefers the guard / blocked / paused reason over the status', () => {
  assert.equal(holdCodeOf({ queue_status: 'blocked', blocked_reason: 'blocked_sender_number' }), 'blocked_sender_number')
  assert.equal(holdCodeOf({ queue_status: 'paused_global_lock' }), 'paused_global_lock')
})

test('route: auth first, unknown kind refused, reads cached per kind', async () => {
  let calls = 0
  const routes = createHomeInstrumentsRoutes({ authorize: () => ({ ok: true }), cors: () => ({}), read: async (k) => { calls += 1; return { kind: k } } })
  assert.equal((await routes.GET(new Request('http://x/api/cockpit/home/instruments?kind=nope'))).status, 400)
  const a = await (await routes.GET(new Request('http://x/api/cockpit/home/instruments?kind=deal'))).json()
  await routes.GET(new Request('http://x/api/cockpit/home/instruments?kind=deal'))
  assert.equal(a.data.kind, 'deal')
  assert.equal(calls, 1)
  const denied = createHomeInstrumentsRoutes({ authorize: () => ({ ok: false, response: { status: 401 } }), cors: () => ({}), read: async () => ({}) })
  assert.equal((await denied.GET(new Request('http://x/api/cockpit/home/instruments?kind=deal'))).status, 401)
})
