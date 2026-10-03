/**
 * HOME INSTRUMENTS — pure rules + route contract (no network, no database).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { __resetInstrumentMemo, createHomeInstrumentsReader, holdCodeOf, splitMarket, summarizeDeals } from '../../src/lib/domain/home/home-instruments-service.js'
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

/* a recording fake of the supabase query surface */
function fakeDb(tables) {
  const log = []
  const from = (table) => {
    const q = { table, filters: [], head: false, order: null, limit: null }
    log.push(q)
    const rows = () => (tables[table] || []).filter((r) => q.filters.every(([op, k, v]) => (op === 'eq' ? r[k] === v : op === 'gt' ? r[k] > v : op === 'gte' ? r[k] >= v : op === 'lte' ? r[k] <= v : op === 'in' ? v.includes(r[k]) : op === 'is' ? (r[k] ?? null) === v : true)))
    const run = () => {
      let r = rows()
      if (q.order) r = [...r].sort((a, b) => (a[q.order.k] < b[q.order.k] ? 1 : -1) * (q.order.asc ? -1 : 1))
      if (q.limit) r = r.slice(0, q.limit)
      return q.head ? { data: null, count: rows().length, error: null } : { data: r, error: null }
    }
    const b = {
      select(_c, opts) { q.head = Boolean(opts?.head); return b },
      eq(k, v) { q.filters.push(['eq', k, v]); return b }, gt(k, v) { q.filters.push(['gt', k, v]); return b },
      gte(k, v) { q.filters.push(['gte', k, v]); return b }, lte(k, v) { q.filters.push(['lte', k, v]); return b },
      in(k, v) { q.filters.push(['in', k, v]); return b }, is(k, v) { q.filters.push(['is', k, v]); return b },
      not() { return b }, neq() { return b }, ilike() { return b },
      order(k, o) { q.order = { k, asc: o?.ascending !== false }; return b }, limit(n) { q.limit = n; return b }, range() { return b },
      then(res, rej) { return Promise.resolve(run()).then(res, rej) },
    }
    return b
  }
  return { from, log }
}

const NOW = Date.parse('2026-10-03T15:00:00Z')
const sales = [
  { comp_id: 't:1', sold_on: '2026-09-10', price: 300000, sqft: 1500, portfolio_size: 1, lat: 32.8, lng: -96.8, is_investor: true, property_id: 'x1', address: '1 A St' },
  { comp_id: 't:2', sold_on: '2026-09-01', price: 0, lat: 32.81, lng: -96.79, is_investor: true },
  { comp_id: 't:3', sold_on: '2026-08-20', price: null, lat: 32.79, lng: -96.81, is_investor: false },
  { comp_id: 't:4', sold_on: '2026-03-01', price: 250000, lat: 32.8, lng: -96.8, is_investor: false },
  { comp_id: 't:5', sold_on: '2026-09-05', price: 410000, lat: 44.97, lng: -93.26, is_investor: true },
]
const base = {
  acquisition_opportunities: [{ id: 'o1', primary_property_id: 'p1', market: 'Dallas, TX', opportunity_status: 'active' }, { id: 'o2', primary_property_id: 'p2', market: 'Dallas, TX', opportunity_status: 'active' }],
  properties: [{ property_id: 'p1', latitude: 32.8, longitude: -96.8 }, { property_id: 'p2', latitude: 32.81, longitude: -96.8 }],
  mv_map_market_sales: sales,
  mv_map_sold_comps: [{ comp_id: 'legacy', sold_on: '2026-05-08', price: 1 }],
  buyer_match_candidates: [{ property_id: 'p1', buyer_type: 'corporate', match_score: 88, match_grade: 'A', buyer_display_name: 'SHOULD NOT LEAK' }],
}

test('comps read the canonical sales projection with the owner price rule, never the legacy view', async () => {
  __resetInstrumentMemo()
  const db = fakeDb(base)
  const c = await createHomeInstrumentsReader({ db, now: () => NOW })('comps')
  assert.ok(db.log.every((q) => q.table !== 'mv_map_sold_comps'))
  assert.equal(c.newestSale, '2026-09-10')
  assert.equal(c.freshnessDays, 23)
  assert.equal(c.sales90, 2) // priced only (t:1, t:5); zero / null price is activity
  assert.equal(c.activity90, 4)
  assert.ok(c.recent.every((r) => r.price > 0))
  assert.deepEqual(c.activeMarkets, [{ market: 'Dallas, TX', deals: 2, comps90: 1 }]) // Minneapolis sale is outside the Dallas box
})

test('buyer demand counts investor activity around each market and never returns buyer names', async () => {
  __resetInstrumentMemo()
  const db = fakeDb(base)
  const b = await createHomeInstrumentsReader({ db, now: () => NOW })('buyers')
  assert.deepEqual(b.demand, [{ market: 'Dallas, TX', deals: 2, sales90: 3, investorPurchases90: 2 }])
  assert.equal(JSON.stringify(b).includes('SHOULD NOT LEAK'), false)
  assert.equal(b.strongest[0].bestGrade, 'A')
})
