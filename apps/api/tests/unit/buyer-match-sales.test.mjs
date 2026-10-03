import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BUYER_MATCH_SALES_SOURCE,
  assertUniqueSales,
  dedupeSales,
  isPricedSale,
  loadBuyerMatchComps,
  loadBuyerMatchSales,
  normalizeSalesQuery,
  shapeSale,
  toBuyerMatchComp,
} from '../../src/lib/domain/buyer-match/buyer-match-sales.js'
import { createBuyerMatchSalesGet } from '../../src/lib/domain/buyer-match/buyer-match-sales-handler.js'

// Minneapolis subject (581 Buffalo St NE, 55432) and real-shaped MV rows.
const SUBJECT = { lat: 45.112302, lng: -93.285952, zip: '55432' }
const row = (over) => ({
  comp_id: 't:1', txn_id: 1, source: 'public_record', sold_on: '2026-08-01', price: 300000, is_priced: true,
  price_source: 'recorded_full', doc_type: 'Warranty Deed', is_arms_length: true, is_cash_purchase: null,
  buyer: null, buyer_kind: 'person', buyer_class: 'individual', is_investor: false, portfolio_size: 1,
  property_id: '100', address: '1 Main St', city: 'Fridley', state: 'MN', zip: '55432',
  lat: 45.1125, lng: -93.2860, property_type: 'Single Family', beds: 3, baths: 2, sqft: 1500, year_built: 1960, units: 1,
  ...over,
})

/** Fake PostgREST builder: records filters, applies gte/lte/gt/eq, honours limit. */
function fakeDb(rows, calls = []) {
  return {
    from(table) {
      const f = []
      let lim = Infinity
      const q = {
        select(cols) { calls.push(['from', table, cols]); return q },
        gte(c, v) { f.push((r) => r[c] !== null && r[c] >= v); return q },
        lte(c, v) { f.push((r) => r[c] !== null && r[c] <= v); return q },
        gt(c, v) { f.push((r) => r[c] !== null && Number(r[c]) > v); calls.push(['gt', c, v]); return q },
        eq(c, v) { f.push((r) => r[c] === v); calls.push(['eq', c, v]); return q },
        order() { return q },
        limit(n) { lim = n; return Promise.resolve({ data: rows.filter((r) => f.every((fn) => fn(r))).slice(0, lim), error: null }) },
      }
      return q
    },
  }
}

const NOW = '2026-10-03T00:00:00Z'

test('price rule: only price > 0 is priced; zero/NULL never yields a price or ppsf', () => {
  assert.equal(isPricedSale({ price: 1 }), true)
  for (const p of [0, null, undefined, '', -5, 'abc']) assert.equal(isPricedSale({ price: p }), false, String(p))
  const zero = shapeSale(row({ price: 0, is_priced: false }))
  assert.equal(zero.price, null)
  assert.equal(zero.ppsf, null)
  assert.equal(zero.is_priced, false)
  const nul = shapeSale(row({ price: null, is_priced: false }))
  assert.equal(nul.price, null)
  assert.equal(nul.ppsf, null)
  assert.equal(toBuyerMatchComp(zero), null, 'an unpriced sale is never a comp')
  const priced = shapeSale(row({ price: 300000, sqft: 1500 }))
  assert.equal(priced.ppsf, 200)
  // a portfolio deed's price covers many doors: no per-sqft figure
  assert.equal(shapeSale(row({ portfolio_size: 4 })).ppsf, null)
})

test('person buyer names are never emitted; company names are', () => {
  assert.equal(shapeSale(row({ buyer: 'SMITH, JOHN' })).buyer, null)
  assert.equal(shapeSale(row({ buyer: 'ACME HOLDINGS LLC' })).buyer, 'ACME HOLDINGS LLC')
})

test('dedupe: one economic sale = one row on comp_id; assertion catches repeats', () => {
  const { rows, duplicates } = dedupeSales([row({ comp_id: 't:1' }), row({ comp_id: 't:1' }), row({ comp_id: 'p:9' }), row({ comp_id: '' })])
  assert.deepEqual(rows.map((r) => r.comp_id), ['t:1', 'p:9'])
  assert.equal(duplicates, 2)
  assert.throws(() => assertUniqueSales([{ comp_id: 'a' }, { comp_id: 'a' }]), /duplicate_key:a/)
})

test('geo: progressive radii stop at the first radius with enough sales; nearest first', async () => {
  const near = Array.from({ length: 12 }, (_, i) => row({ comp_id: `t:${i}`, lat: 45.1123 + i * 0.0005, lng: -93.2860 }))
  const far = row({ comp_id: 't:far', lat: 45.30, lng: -93.2860 }) // ~13 mi
  const calls = []
  const res = await loadBuyerMatchSales({ ...SUBJECT, limit: 12 }, { db: fakeDb([far, ...near], calls), now: NOW })
  assert.equal(res.meta.source, BUYER_MATCH_SALES_SOURCE)
  assert.equal(res.meta.strategy, 'geo')
  assert.equal(res.meta.radius_miles, 1)
  assert.equal(res.meta.queries, 1)
  assert.equal(res.sales.length, 12)
  assert.ok(!res.sales.some((s) => s.comp_id === 't:far'))
  for (let i = 1; i < res.sales.length; i++) assert.ok(res.sales[i].distance_miles >= res.sales[i - 1].distance_miles)
  assert.ok(calls.some((c) => c[0] === 'from' && c[1] === 'mv_map_market_sales'))
  assert.ok(calls.some((c) => c[0] === 'gt' && c[1] === 'price' && c[2] === 0), 'priced mode filters price > 0 in SQL')
})

test('geo widens when the small radius is thin', async () => {
  const far = row({ comp_id: 't:far', lat: 45.20, lng: -93.2860 }) // ~6 mi
  const res = await loadBuyerMatchSales({ ...SUBJECT, limit: 1 }, { db: fakeDb([far]), now: NOW })
  assert.equal(res.meta.radius_miles, 10)
  assert.equal(res.sales[0].comp_id, 't:far')
})

test('activity mode keeps unpriced sales (counted) but never prices them; comps mode drops them', async () => {
  const rows = [row({ comp_id: 't:1' }), row({ comp_id: 't:2', price: null, is_priced: false }), row({ comp_id: 't:3', price: 0, is_priced: false })]
  const all = await loadBuyerMatchSales({ zip: '55432', priced: 'all', limit: 50 }, { db: fakeDb(rows), now: NOW })
  assert.equal(all.meta.strategy, 'zip')
  assert.equal(all.sales.length, 3)
  assert.equal(all.meta.priced_count, 1)
  assert.ok(all.sales.filter((s) => !s.is_priced).every((s) => s.price === null && s.ppsf === null))
  const { comps } = await loadBuyerMatchComps({ zip: '55432' }, {}, { db: fakeDb(rows), now: NOW })
  assert.deepEqual(comps.map((c) => c.comp_id), ['t:1'])
  assert.ok(comps.every((c) => c.sold_price > 0 && c.source_type === 'CANONICAL_SALE'))
})

test('window: sales older than `months` are excluded in SQL', async () => {
  const rows = [row({ comp_id: 't:old', sold_on: '2023-01-01' }), row({ comp_id: 't:new' })]
  const res = await loadBuyerMatchSales({ zip: '55432', months: 24 }, { db: fakeDb(rows), now: NOW })
  assert.deepEqual(res.sales.map((s) => s.comp_id), ['t:new'])
  assert.equal(res.meta.since, '2024-10-03')
})

test('query normalisation bounds every input', () => {
  const q = normalizeSalesQuery({ lat: 0, lng: 0, zip: '55432-1234', state: 'mn', limit: 9999, months: 0, radius: 400 })
  assert.equal(q.lat, null, '0,0 is not a coordinate')
  assert.equal(q.zip, '55432')
  assert.equal(q.state, 'MN')
  assert.equal(q.limit, 500)
  assert.equal(q.months, 1)
  assert.equal(q.radius_miles, 25)
  assert.equal(q.priced, 'only')
})

test('route handler: auth gate, scope validation, success envelope', async () => {
  const cors = () => ({})
  const deny = () => ({ ok: false, response: { status: 401 } })
  const allow = () => ({ ok: true })
  const seen = []
  const load = async (q) => { seen.push(q); return { sales: [], meta: { source: BUYER_MATCH_SALES_SOURCE } } }

  const denied = await createBuyerMatchSalesGet({ auth: deny, cors, load })(new Request('http://x/api/cockpit/buyer-match/sales?zip=55432'))
  assert.equal(denied.status, 401)
  assert.equal(seen.length, 0)

  const GET = createBuyerMatchSalesGet({ auth: allow, cors, load })
  assert.equal((await GET(new Request('http://x/api/cockpit/buyer-match/sales'))).status, 400)
  assert.equal((await GET(new Request('http://x/api/cockpit/buyer-match/sales?zip=%27%3Bdrop'))).status, 400)
  const ok = await GET(new Request('http://x/api/cockpit/buyer-match/sales?lat=45.1&lng=-93.2&radius=5&priced=all'))
  assert.equal(ok.status, 200)
  const body = await ok.json()
  assert.equal(body.ok, true)
  assert.equal(body.data.meta.source, 'mv_map_market_sales')
  assert.equal(seen[0].radius_miles, '5')
  assert.equal(seen[0].priced, 'all')
})

test('route module: rejects an unauthenticated request when the ops secret is configured', async () => {
  process.env.OPS_DASHBOARD_SECRET = process.env.OPS_DASHBOARD_SECRET || 'test-ops-secret'
  const { GET } = await import('../../src/app/api/cockpit/buyer-match/sales/route.js')
  const res = await GET(new Request('http://localhost/api/cockpit/buyer-match/sales?zip=55432'))
  assert.equal(res.status, 401)
})
