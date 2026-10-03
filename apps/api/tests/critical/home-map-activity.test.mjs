/**
 * HOME MAP ACTIVITY — the Home Map widget's own narrow read.
 * No network: an in-memory PostgREST surface (select/eq/in/gte/lt/order/range, rpc).
 *   per-lens counting rules mirror analytics_performance · canary rows excluded ·
 *   replies are distinct conversations placed via the prompting send ·
 *   unplaced rows are counted, not dropped · buyers say "not readable" when the
 *   proposed RPC is missing · paging past PostgREST max-rows · route validation
 *   and the in-flight/TTL cache.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { aggregatePlaces, getHomeMapActivity, isExcludedRow, canaryPhoneSet } from '../../src/lib/domain/home/home-map-activity-service.js'
import { createHomeMapActivityRoutes } from '../../src/lib/domain/home/home-map-activity-routes.js'

const NOW = Date.parse('2026-10-03T12:00:00Z')
const at = (daysAgo) => new Date(NOW - daysAgo * 86_400_000).toISOString()

function fakeDb(tables, { rpc = null, pageCap = 1000 } = {}) {
  const calls = []
  const from = (table) => {
    const q = { table, filters: [], range: null }
    const api = {
      select(cols) { q.cols = cols; return api },
      eq(k, v) { q.filters.push((r) => r[k] === v); return api },
      in(k, vs) { const set = new Set(vs.map(String)); q.filters.push((r) => set.has(String(r[k]))); return api },
      gte(k, v) { q.filters.push((r) => r[k] >= v); return api },
      lt(k, v) { q.filters.push((r) => r[k] < v); return api },
      not() { return api },
      or() { return api }, // server-side superset; the service's JS predicate decides
      limit() { return api },
      order(k) { q.order = k; return api },
      range(a, b) { q.range = [a, b]; return api },
      then(res, rej) {
        calls.push(q)
        let rows = (tables[table] ?? []).filter((r) => q.filters.every((f) => f(r)))
        if (q.order) rows = [...rows].sort((x, y) => String(x[q.order]).localeCompare(String(y[q.order])))
        const [a, b] = q.range ?? [0, rows.length]
        rows = rows.slice(a, Math.min(b + 1, a + pageCap))
        return Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null }).then(res, rej)
      },
    }
    return api
  }
  return { from, rpc: async (name, args) => (rpc ? rpc(name, args) : { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } }), calls }
}

const props = [
  { property_id: 'p1', property_address_zip: '75201-1234', latitude: 32.78, longitude: -96.8, canonical_market_id: 'dallas' },
  { property_id: 'p2', property_address_zip: '55401', latitude: 44.98, longitude: -93.27, canonical_market_id: 'minneapolis' },
  { property_id: 'p3', property_address_zip: '75202', latitude: null, longitude: null, canonical_market_id: 'dallas' },
]
const markets = [{ id: 'dallas', display_name: 'Dallas, TX' }, { id: 'minneapolis', display_name: 'Minneapolis, MN' }]
const canary = [...canaryPhoneSet()][0]

test('canary rule: thread/phone, internal_canary source and metadata flags are excluded', () => {
  const phones = canaryPhoneSet()
  assert.equal(isExcludedRow({ thread_key: canary }, phones), true)
  assert.equal(isExcludedRow({ source: 'internal_canary' }, phones), true)
  assert.equal(isExcludedRow({ md_canary: 'TRUE' }, phones), true)
  assert.equal(isExcludedRow({ md_kpi: 'yes' }, phones), true)
  assert.equal(isExcludedRow({ thread_key: '+15550001111', source: 'campaign' }, phones), false)
})

test('aggregation: ZIP groups, distinct conversations, unplaced counted not dropped', () => {
  const items = [
    { k: 't1', zip: '75201', mkt: 'dallas', lat: 32.7, lng: -96.8 },
    { k: 't1', zip: '75201', mkt: 'dallas', lat: 32.9, lng: -96.8 },
    { k: 't2', zip: '75201', mkt: 'dallas', lat: 32.8, lng: -96.8 },
    { k: 't3', zip: null, mkt: null, lat: null, lng: null },
    { k: 't3', zip: null, mkt: null, lat: 0, lng: 0 },
  ]
  const d = aggregatePlaces(items, { distinct: true })
  assert.equal(d.places.length, 1)
  assert.equal(d.places[0].value, 2)
  assert.equal(d.places[0].lat, 32.8)
  assert.equal(d.unplaced, 1) // one conversation, two rows
  const c = aggregatePlaces(items)
  assert.equal(c.places[0].value, 3)
  assert.equal(c.unplaced, 2)
  assert.equal(c.total, 3)
})

test('delivered and failed: status predicates, period window and canary exclusion', async () => {
  const db = fakeDb({
    send_queue: [
      { id: 's1', created_at: at(1), queue_status: 'delivered', property_id: 'p1', thread_key: 'a' },
      { id: 's2', created_at: at(2), queue_status: 'sent', delivery_confirmed: 'Delivered', property_id: 'p1', thread_key: 'b' },
      { id: 's3', created_at: at(3), queue_status: 'failed_transport', property_id: 'p2', thread_key: 'c' },
      { id: 's4', created_at: at(3), queue_status: 'delivered', property_id: 'p2', thread_key: canary },
      { id: 's5', created_at: at(9), queue_status: 'delivered', property_id: 'p2', thread_key: 'd' }, // outside 7d
      { id: 's6', created_at: at(1), queue_status: 'delivered', property_id: 'p3', thread_key: 'e' }, // no coordinates
    ],
    properties: props,
    canonical_markets: markets,
  })
  const d = await getHomeMapActivity({ lens: 'delivered', range: '7d' }, { supabase: db, now: NOW })
  assert.equal(d.available, true)
  assert.deepEqual(d.places.map((p) => [p.zip, p.value, p.marketName]), [['75201', 2, 'Dallas, TX']])
  assert.equal(d.unplaced, 1)
  const f = await getHomeMapActivity({ lens: 'failed', range: '7d' }, { supabase: db, now: NOW })
  assert.deepEqual(f.places.map((p) => [p.zip, p.value]), [['55401', 1]])
})

test('replies: distinct conversations, placed at the prompting send when the message has no property', async () => {
  const db = fakeDb({
    message_events: [
      { id: 'm1', direction: 'inbound', created_at: at(1), thread_key: 't1', property_id: null },
      { id: 'm2', direction: 'inbound', created_at: at(1), thread_key: 't1', property_id: null },
      { id: 'm3', direction: 'inbound', created_at: at(2), thread_key: 't2', property_id: 'p2' },
      { id: 'm4', direction: 'outbound', created_at: at(2), thread_key: 't3', property_id: 'p2' },
      { id: 'm5', direction: 'inbound', created_at: at(2), thread_key: canary, property_id: 'p2' },
    ],
    send_queue: [
      { id: 's1', thread_key: 't1', property_id: 'p2', created_at: at(5) },
      { id: 's2', thread_key: 't1', property_id: 'p1', created_at: at(3) }, // latest before the reply wins
      { id: 's3', thread_key: 't1', property_id: 'p2', created_at: at(0.5) }, // after the reply: ignored
    ],
    properties: props,
    canonical_markets: markets,
  })
  const d = await getHomeMapActivity({ lens: 'replies', range: '7d' }, { supabase: db, now: NOW })
  assert.deepEqual(d.places.map((p) => [p.zip, p.value]).sort(), [['55401', 1], ['75201', 1]])
  assert.equal(d.total, 2)
})

test('moves exclude test history; offers exclude seller counters', async () => {
  const db = fakeDb({
    acquisition_opportunity_history: [
      { id: 'h1', event_type: 'stage_transition', created_at: at(1), opportunity_id: 'o1', actor: 'seller_engine', reason: '' },
      { id: 'h2', event_type: 'stage_transition', created_at: at(1), opportunity_id: 'o1', actor: 'cert_runner', reason: '' },
      { id: 'h3', event_type: 'stage_transition', created_at: at(1), opportunity_id: 'o1', actor: 'op', reason: 'restore test' },
      { id: 'h4', event_type: 'opportunity_created', created_at: at(1), opportunity_id: 'o1', actor: 'op', reason: '' },
    ],
    acquisition_opportunities: [{ id: 'o1', primary_property_id: 'p2' }],
    seller_offers: [
      { offer_id: 'f1', created_at: at(1), property_id: 'p1', direction: 'outbound' },
      { offer_id: 'f2', created_at: at(1), property_id: 'p1', direction: 'inbound' },
    ],
    properties: props,
    canonical_markets: markets,
  })
  const m = await getHomeMapActivity({ lens: 'moves', range: '7d' }, { supabase: db, now: NOW })
  assert.equal(m.total, 1)
  const o = await getHomeMapActivity({ lens: 'offers', range: '7d' }, { supabase: db, now: NOW })
  assert.equal(o.total, 1)
})

test('buyers: missing RPC is "not readable", never zero; present RPC is aggregated with data-through', async () => {
  const missing = await getHomeMapActivity({ lens: 'buyers', range: '30d' }, { supabase: fakeDb({}), now: NOW })
  assert.equal(missing.available, false)
  assert.equal(missing.reason, 'buyer_read_not_installed')
  const db = fakeDb({ canonical_markets: markets }, {
    rpc: (name, args) => {
      assert.equal(name, 'home_map_buyer_purchases')
      assert.equal(args.p_end, '2026-10-03')
      return { data: { data_through: '2026-07-28', rows: [{ zip: '75201', market: 'dallas', lat: 32.8, lng: -96.8, n: 3 }] }, error: null }
    },
  })
  const b = await getHomeMapActivity({ lens: 'buyers', range: '30d' }, { supabase: db, now: NOW })
  assert.equal(b.available, true)
  assert.equal(b.total, 3)
  assert.equal(b.dataThrough, '2026-07-28')
})

test('paging: reads past the PostgREST max-rows page', async () => {
  const send_queue = Array.from({ length: 2500 }, (_, i) => ({ id: `s${String(i).padStart(5, '0')}`, created_at: at(1), queue_status: 'delivered', property_id: 'p1', thread_key: `t${i}` }))
  const db = fakeDb({ send_queue, properties: props, canonical_markets: markets })
  const d = await getHomeMapActivity({ lens: 'delivered', range: '7d' }, { supabase: db, now: NOW })
  assert.equal(d.total, 2500)
})

test('route: auth, lens/range validation, shared in-flight read, failure is a retryable 500', async () => {
  let reads = 0
  let fail = false
  const routes = createHomeMapActivityRoutes({
    authorize: (req) => (req.headers.get('x-ok') ? { ok: true } : { ok: false, response: { status: 401 } }),
    cors: () => ({}),
    read: async (p) => { reads += 1; if (fail) throw new Error('boom'); return { lens: p.lens, places: [] } },
  })
  const req = (qs, ok = true) => new Request(`http://x/api/cockpit/home/map-activity?${qs}`, { headers: ok ? { 'x-ok': '1' } : {} })
  assert.equal((await routes.GET(req('lens=replies', false))).status, 401)
  assert.equal((await routes.GET(req('lens=nope'))).status, 400)
  assert.equal((await routes.GET(req('lens=replies&range=90d'))).status, 400)
  const [a, b] = await Promise.all([routes.GET(req('lens=replies&range=7d')), routes.GET(req('lens=replies&range=7d'))])
  assert.equal(a.status, 200); assert.equal(b.status, 200)
  assert.equal(reads, 1)
  fail = true
  const bad = await routes.GET(req('lens=failed&range=7d'))
  assert.equal(bad.status, 500)
  assert.equal((await bad.json()).retryable, true)
})
