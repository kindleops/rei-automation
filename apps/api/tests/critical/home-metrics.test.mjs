/**
 * HOME METRICS — Home's period figures with the Analytics bundle's exact rules,
 * without the bundle. No network: an in-memory PostgREST surface.
 *   totals per period (sent / delivered / distinct conversations / failed /
 *   opt-out / positive / stage history) · prior period split · rates and
 *   comparisons via the Analytics functions · UTC date_trunc buckets (incl.
 *   Monday weeks) · market scoping incl. reply attribution · active markets ·
 *   counted paging · route validation, single-flight and 30s TTL.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { bucketStarts, getHomeMetrics, isOptOut, periodTotals, truncUtc } from '../../src/lib/domain/home/home-metrics-service.js'
import { createHomeMetricsRoutes } from '../../src/lib/domain/home/home-metrics-routes.js'
import { createReadCache, pagedRange } from '../../src/lib/domain/home/home-read-kit.js'
import { compareRate } from '../../src/lib/domain/analytics/analytics-performance-service.js'

const NOW = Date.parse('2026-10-03T12:00:00Z')
const at = (daysAgo) => new Date(NOW - daysAgo * 86_400_000).toISOString().replace('Z', '+00:00')

function fakeDb(tables, { pageCap = 1000 } = {}) {
  const requests = []
  const from = (table) => {
    const q = { table, filters: [], range: null, count: false, inner: false }
    const api = {
      select(cols, opts) { q.inner = String(cols).includes('!inner'); q.count = opts?.count === 'exact'; return api },
      eq(k, v) { q.filters.push((r) => r[k] === v); return api },
      in(k, vs) { const set = new Set(vs.map(String)); q.filters.push((r) => set.has(String(r[k]))); return api },
      gte(k, v) { q.filters.push((r) => Date.parse(r[k]) >= Date.parse(v)); return api },
      lt(k, v) { q.filters.push((r) => Date.parse(r[k]) < Date.parse(v)); return api },
      order(k) { q.order = k; return api },
      range(a, b) { q.range = [a, b]; return api },
      limit() { return api },
      then(res, rej) {
        requests.push(q)
        let rows = (tables[table] ?? []).filter((r) => q.filters.every((f) => f(r)) && (!q.inner || r.opp))
        const count = rows.length
        if (q.order) rows = [...rows].sort((x, y) => String(x[q.order]).localeCompare(String(y[q.order])))
        const [a, b] = q.range ?? [0, rows.length]
        rows = rows.slice(a, Math.min(b + 1, a + pageCap))
        return Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null, count: q.count ? count : null }).then(res, rej)
      },
    }
    return api
  }
  return { from, rpc: async () => ({ data: null, error: { code: 'PGRST202' } }), requests }
}

const props = [
  { property_id: 'p1', property_address_zip: '75201', latitude: 32.78, longitude: -96.8, canonical_market_id: 'dallas' },
  { property_id: 'p2', property_address_zip: '55401', latitude: 44.98, longitude: -93.27, canonical_market_id: 'minneapolis' },
  { property_id: 'p9', property_address_zip: '99999', latitude: 1, longitude: 1, canonical_market_id: 'not-a-market' },
]
const markets = [{ id: 'dallas', display_name: 'Dallas, TX', state: 'TX' }, { id: 'minneapolis', display_name: 'Minneapolis, MN', state: 'MN' }]

function world() {
  return {
    send_queue: [
      { id: 's1', created_at: at(1), queue_status: 'delivered', thread_key: 't1', property_id: 'p1' },
      { id: 's2', created_at: at(1), queue_status: 'sent', sent_at: at(1), delivery_confirmed: 'DELIVERED', thread_key: 't1', property_id: 'p1' },
      { id: 's3', created_at: at(2), queue_status: 'failed', thread_key: 't2', property_id: 'p2' },
      { id: 's4', created_at: at(2), queue_status: 'delivered', thread_key: null, property_id: 'p2' }, // delivered, no conversation
      { id: 's5', created_at: at(3), queue_status: 'delivered', thread_key: 't5', property_id: 'p2', source: 'internal_canary' },
      { id: 's6', created_at: at(3), queue_status: 'delivered', thread_key: 't6', property_id: 'p2', md_kpi: 'True' },
      { id: 's7', created_at: at(9), queue_status: 'delivered', thread_key: 't7', property_id: 'p1' }, // prior period
      { id: 's8', created_at: at(2), queue_status: 'sent', thread_key: 't8', property_id: 'p9' }, // non-canonical market
    ],
    message_events: [
      { id: 'm1', direction: 'inbound', created_at: at(0.5), thread_key: 't1', property_id: null, detected_intent: 'Seller_Interested' },
      { id: 'm2', direction: 'inbound', created_at: at(0.4), thread_key: 't1', property_id: null, detected_intent: null, opt_out_keyword: '' },
      { id: 'm3', direction: 'inbound', created_at: at(1.5), thread_key: 't2', property_id: 'p2', detected_intent: 'STOP' },
      { id: 'm4', direction: 'inbound', created_at: at(1.5), thread_key: null, property_id: 'p2' },
      { id: 'm5', direction: 'outbound', created_at: at(1.5), thread_key: 't2', property_id: 'p2' },
      { id: 'm6', direction: 'inbound', created_at: at(8), thread_key: 't7', property_id: 'p1' },
    ],
    acquisition_opportunity_history: [
      { id: 'h1', event_type: 'stage_transition', created_at: at(1), opportunity_id: 'o1', actor: 'seller_engine', reason: '', opp: { primary_property_id: 'p1' } },
      { id: 'h2', event_type: 'stage_transition', created_at: at(1), opportunity_id: 'o1', actor: 'probe', reason: '', opp: { primary_property_id: 'p1' } },
      { id: 'h3', event_type: 'stage_transition', created_at: at(1), opportunity_id: 'gone', actor: 'op', reason: '', opp: null }, // no opportunity: inner join drops it
      { id: 'h4', event_type: 'opportunity_created', created_at: at(2), opportunity_id: 'o2', actor: 'op', reason: '', opp: { primary_property_id: 'p2' } },
    ],
    properties: props,
    canonical_markets: markets,
  }
}

test('opt-out: flag, any keyword (even empty, as SQL `is not null`) or opt-out intent', () => {
  assert.equal(isOptOut({ is_opt_out: true }), true)
  assert.equal(isOptOut({ opt_out_keyword: '' }), true)
  assert.equal(isOptOut({ detected_intent: 'Unsubscribe' }), true)
  assert.equal(isOptOut({ detected_intent: 'interested', opt_out_keyword: null }), false)
})

test('date_trunc in UTC: hour, day and Monday weeks; series spans start bucket to end - 1s', () => {
  assert.equal(new Date(truncUtc(Date.parse('2026-10-01T13:45:00Z'), 'week')).toISOString(), '2026-09-28T00:00:00.000Z')
  assert.equal(new Date(truncUtc(Date.parse('2026-09-28T00:00:00Z'), 'week')).toISOString(), '2026-09-28T00:00:00.000Z')
  assert.equal(new Date(truncUtc(Date.parse('2026-10-04T23:59:00Z'), 'week')).toISOString(), '2026-09-28T00:00:00.000Z')
  assert.equal(bucketStarts('2026-09-26T12:00:00.000Z', '2026-10-03T12:00:00.000Z', 'day').length, 8)
  assert.equal(bucketStarts('2026-10-03T00:00:00.000Z', '2026-10-03T12:00:00.000Z', 'hour').length, 12)
})

test('totals, prior period, rates and comparisons follow the bundle', async () => {
  const d = await getHomeMetrics({ range: '7d' }, { supabase: fakeDb(world()), now: NOW })
  assert.deepEqual(d.totals.cur, {
    send_rows: 5, sent: 4, delivered: 3, delivered_conversations: 1, failed: 1,
    reply_messages: 4, replied_conversations: 2, positive_conversations: 1, opt_out_conversations: 2,
    opportunities_created: 1, stage_advancements: 1,
  })
  assert.equal(d.totals.prev.send_rows, 1)
  assert.equal(d.totals.prev.replied_conversations, 1)
  assert.equal(d.priorHasData, true)
  assert.deepEqual(d.rates.delivery_rate, compareRate(3, 4, 1, 1))
  assert.deepEqual(d.compare.delivered, { cur: 3, prev: 1, delta: 2, pct: null, basis: 'absolute' })
  assert.equal(d.markets, null) // not requested → no property reads
  assert.equal(d.series.length, 8)
  assert.equal(d.series.reduce((n, s) => n + s.delivered, 0), 3)
  assert.equal(d.series.reduce((n, s) => n + s.replied, 0), 2)
  assert.equal(d.series.reduce((n, s) => n + s.advancements, 0), 1)
  assert.ok(d.metrics.replied_conversations && d.metrics.reply_rate)
})

test('market scope: sends and history by property, replies by message property else the prompting send', async () => {
  const d = await getHomeMetrics({ range: '7d', market: 'dallas' }, { supabase: fakeDb(world()), now: NOW })
  assert.equal(d.scope.marketName, 'Dallas, TX')
  assert.equal(d.totals.cur.send_rows, 2)
  assert.equal(d.totals.cur.replied_conversations, 1) // t1 attributed through s1/s2 (p1)
  assert.equal(d.totals.cur.stage_advancements, 1)
  assert.equal(d.totals.cur.opportunities_created, 0)
  assert.equal(d.totals.prev.send_rows, 1)
})

test('active markets: canonical markets only, current-period sends', async () => {
  const d = await getHomeMetrics({ range: '7d', withMarkets: true }, { supabase: fakeDb(world()), now: NOW })
  assert.deepEqual(d.markets.map((m) => [m.id, m.cur.delivered, m.cur.failed]), [['dallas', 2, 0], ['minneapolis', 1, 1]])
})

test('no prior traffic → no comparison', () => {
  const zero = periodTotals({ sends: [], inbound: [], hist: [] })
  assert.equal(zero.send_rows + zero.reply_messages, 0)
})

test('paging: counted first page, the rest in parallel, every row once', async () => {
  const rows = Array.from({ length: 2345 }, (_, i) => ({ id: `r${String(i).padStart(5, '0')}`, created_at: at(1) }))
  const db = fakeDb({ t: rows })
  const got = await pagedRange((first) => db.from('t').select('id', first ? { count: 'exact' } : undefined), 't')
  assert.equal(got.length, 2345)
  assert.equal(new Set(got.map((r) => r.id)).size, 2345)
})

test('read cache: single-flight, 30s TTL, failures are not cached', async () => {
  let t = 0
  let n = 0
  const cache = createReadCache({ ttlMs: 30_000, now: () => t })
  const read = async () => { n += 1; return n }
  assert.deepEqual(await Promise.all([cache('k', read), cache('k', read)]), [1, 1])
  t = 29_000; assert.equal(await cache('k', read), 1)
  t = 31_000; assert.equal(await cache('k', read), 2)
  await assert.rejects(cache('bad', async () => { throw new Error('x') }))
  assert.equal(await cache('bad', async () => 'ok'), 'ok')
})

test('route: auth, range validation, params, shared read', async () => {
  const seen = []
  const routes = createHomeMetricsRoutes({
    authorize: (req) => (req.headers.get('x-ok') ? { ok: true } : { ok: false, response: { status: 401 } }),
    cors: () => ({}),
    read: async (p) => { seen.push(p); return { ok: 1 } },
  })
  const req = (qs, ok = true) => new Request(`http://x/api/cockpit/home/metrics?${qs}`, { headers: ok ? { 'x-ok': '1' } : {} })
  assert.equal((await routes.GET(req('range=7d', false))).status, 401)
  assert.equal((await routes.GET(req('range=ytd'))).status, 400)
  await Promise.all([routes.GET(req('range=30d&markets=1')), routes.GET(req('range=30d&markets=1'))])
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0], { range: '30d', start: null, market: null, withMarkets: true })
  await routes.GET(req('range=7d&market=dallas'))
  assert.equal(seen[1].market, 'dallas')
})
