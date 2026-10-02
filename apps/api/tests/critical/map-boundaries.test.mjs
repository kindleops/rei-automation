/**
 * MAP 8.2 — boundary overlay read (injected client, no network).
 * Request limits, the primary function, the ZIP fallback while it is not
 * installed, refusals, caching, and "never throws".
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_FEATURES, ZIP_MIN_ZOOM, createMapBoundaryReader, normalizeBoundaryRequest, toleranceFor } from '../../src/lib/domain/map/map-boundaries-service.js'

const square = (lng, lat, d = 0.01) => ({ type: 'Polygon', coordinates: [[[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]]] })
const MISSING = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.map_boundaries_in_bbox' }, status: 404 }

/** A fake supabase client: rpc(fn) → handlers[fn], from(table) → a chainable query resolving to handlers.from. */
function client(handlers) {
  const calls = []
  const query = (table) => {
    const q = { table, filters: [] }
    const chain = {
      select: (c) => { q.select = c; return chain },
      eq: (k, v) => { q.filters.push(['eq', k, v]); return chain },
      lte: (k, v) => { q.filters.push(['lte', k, v]); return chain },
      gte: (k, v) => { q.filters.push(['gte', k, v]); return chain },
      limit: (n) => { q.limit = n; calls.push({ from: table, q }); return Promise.resolve(typeof handlers.from === 'function' ? handlers.from(q) : handlers.from) },
    }
    return chain
  }
  return {
    calls,
    rpc: async (fn, args) => { calls.push({ fn, args }); const h = handlers[fn]; if (h instanceof Error) throw h; return typeof h === 'function' ? h(args) : h },
    from: query,
  }
}

test('boundaries request: levels, bbox, zoom and ZIP limits are enforced before any read', () => {
  assert.equal(normalizeBoundaryRequest({ level: 'county', bbox: '-94,44,-93,45', zoom: 10 }).reason, 'no_source')
  assert.equal(normalizeBoundaryRequest({ level: 'market', bbox: '-94,44,-93,45', zoom: 10 }).reason, 'no_source')
  assert.equal(normalizeBoundaryRequest({ level: 'parcel', bbox: '-94,44,-93,45', zoom: 10 }).reason, 'bad_level')
  assert.equal(normalizeBoundaryRequest({ level: 'zip', bbox: '-93,44,-94,45', zoom: 10 }).reason, 'bad_bbox')
  assert.equal(normalizeBoundaryRequest({ level: 'zip', bbox: '-94,44,-93', zoom: 10 }).reason, 'bad_bbox')
  assert.equal(normalizeBoundaryRequest({ level: 'zip', bbox: '-94,44,-93,45', zoom: 'x' }).reason, 'bad_zoom')
  assert.equal(normalizeBoundaryRequest({ level: 'zip', bbox: '-94,44,-93,45', zoom: ZIP_MIN_ZOOM - 0.5 }).reason, 'zoom_out')
  assert.equal(normalizeBoundaryRequest({ level: 'zip', bbox: '-100,40,-93,45', zoom: 9.5 }).reason, 'too_large')
  const ok = normalizeBoundaryRequest({ level: 'ZIP', bbox: '-93.41,44.91,-93.12,45.07', zoom: 11.4 })
  assert.equal(ok.ok, true)
  assert.equal(ok.level, 'zip')
  assert.deepEqual(ok.bbox, [-93.5, 44.75, -93, 45.25]) // snapped outward to the 0.25° grid
  assert.equal(ok.tolerance, toleranceFor('zip', 11.4))
  const nation = normalizeBoundaryRequest({ level: 'state', bbox: '-170,10,-50,72', zoom: 3.2 })
  assert.equal(nation.ok, true, 'any box is fine for 33 states')
  assert.ok(toleranceFor('state', 3) > toleranceFor('state', 10))
})

test('boundaries (function present): one GiST read, a FeatureCollection, cached per snapped box', async () => {
  let now = 1_000
  const c = client({
    map_boundaries_in_bbox: ({ p_level }) => ({
      data: [
        { geo_id: 'state:MN', level: p_level, label: 'MN', geojson: square(-97, 43, 4) },
        { geo_id: 'state:WI', level: p_level, label: 'WI', geojson: square(-92, 42, 4) },
        { geo_id: 'state:XX', level: p_level, label: 'XX', geojson: { type: 'Point', coordinates: [0, 0] } },
      ],
      error: null,
    }),
  })
  const reader = createMapBoundaryReader({ supabase: c, clock: () => now })
  const r = await reader.read({ level: 'state', bbox: '-95.1,43.2,-91.7,46.4', zoom: 6.2 })
  assert.equal(r.available, true)
  assert.equal(r.via, 'map_boundaries_in_bbox')
  assert.equal(r.source, 'US Census states')
  assert.deepEqual(r.data.features.map((f) => f.properties.key), ['MN', 'WI'], 'non-outlines are dropped')
  assert.equal(c.calls[0].args.p_level, 'state')
  assert.equal(c.calls[0].args.p_tolerance, toleranceFor('state', 6.2))
  // a small pan inside the same snapped cell is a cache hit
  await reader.read({ level: 'state', bbox: '-95.0,43.3,-91.8,46.3', zoom: 6.4 })
  assert.equal(reader.stats.rpcCalls, 1)
  assert.equal(reader.stats.cacheHits, 1)
  now += 31 * 60_000
  await reader.read({ level: 'state', bbox: '-95.0,43.3,-91.8,46.3', zoom: 6.4 })
  assert.equal(reader.stats.rpcCalls, 2, 'expired after 30 min')
})

test('boundaries (function not installed): ZIP falls back to the RC 7.1 outlines; state says not_installed', async () => {
  const c = client({
    map_boundaries_in_bbox: MISSING,
    from: { data: [{ key: '55411' }, { key: '55412' }, { key: 'bad' }, { key: '55411' }], error: null },
    analytics_zip_boundaries: ({ p_zips }) => ({ data: p_zips.map((z, i) => ({ zip: z, geojson: square(-93.3 + i * 0.02, 45) })), error: null }),
  })
  const reader = createMapBoundaryReader({ supabase: c })
  const zip = await reader.read({ level: 'zip', bbox: '-93.4,44.9,-93.1,45.1', zoom: 12 })
  assert.equal(zip.available, true)
  assert.equal(zip.via, 'analytics_zip_boundaries')
  assert.deepEqual(zip.data.features.map((f) => f.properties.key), ['55411', '55412'])
  assert.deepEqual(zip.coverage, { zips_in_view: 2, outlined: 2 })
  const areaQuery = c.calls.find((x) => x.from === 'mv_map_search_areas').q
  assert.deepEqual(areaQuery.filters[0], ['eq', 'kind', 'zip'])
  assert.equal(areaQuery.limit, MAX_FEATURES)
  const state = await reader.read({ level: 'state', bbox: '-97,43,-90,47', zoom: 6 })
  assert.deepEqual({ available: state.available, reason: state.reason }, { available: false, reason: 'not_installed' })
})

test('boundaries: refusals and failures answer available:false and never throw', async () => {
  const boom = createMapBoundaryReader({ supabase: client({ map_boundaries_in_bbox: new Error('socket hang up') }) })
  const a = await boom.read({ level: 'zip', bbox: '-93.4,44.9,-93.1,45.1', zoom: 12 })
  assert.deepEqual({ available: a.available, reason: a.reason }, { available: false, reason: 'unavailable' })
  const failing = createMapBoundaryReader({ supabase: client({ map_boundaries_in_bbox: { data: null, error: { code: '57014', message: 'statement timeout' } } }) })
  const b = await failing.read({ level: 'state', bbox: '-97,43,-90,47', zoom: 6 })
  assert.equal(b.reason, 'unavailable')
  const c = client({})
  const refused = await createMapBoundaryReader({ supabase: c }).read({ level: 'zip', bbox: '-97,43,-90,47', zoom: 6 })
  assert.equal(refused.reason, 'zoom_out')
  assert.equal(c.calls.length, 0, 'a refusal reads nothing')
})
