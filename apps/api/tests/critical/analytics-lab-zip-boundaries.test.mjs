/**
 * ANALYTICS LAB — ZIP outlines read (injected client, no network).
 * Both legs: the function exists (outlines, bounded input, cache) and the
 * function is missing / failing (available:false, never throws).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_ZIPS, createZipBoundaryReader, normalizeZips } from '../../src/lib/domain/analytics/lab/zip-boundaries.js'

const square = (lng, lat, d = 0.01) => ({ type: 'Polygon', coordinates: [[[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]]] })
function client(reply) {
  const calls = []
  return {
    calls,
    rpc: async (fn, args) => { calls.push({ fn, args }); return typeof reply === 'function' ? reply(fn, args) : reply },
  }
}

test('zip outlines: only well-formed 5-digit ZIPs, de-duplicated, sorted, at most 400', () => {
  assert.deepEqual(normalizeZips(' 55412,55411,5541,abcde,55411,554110, 55430 '), ['55411', '55412', '55430'])
  assert.deepEqual(normalizeZips(['55405', null, 55412, '']), ['55405', '55412'])
  const many = Array.from({ length: 450 }, (_, i) => String(10000 + i))
  assert.equal(normalizeZips(many).length, MAX_ZIPS)
})

test('zip outlines (function present): returns outlines for the ZIPs asked, names the missing, caches per set', async () => {
  let now = 1_000
  const c = client((fn, { p_zips }) => ({
    data: [
      { zip: '55411', geojson: square(-93.3, 45.0) },
      { zip: '55412', geojson: { type: 'MultiPolygon', coordinates: [square(-93.31, 45.02).coordinates] } },
      { zip: '99999', geojson: square(-90, 40) }, // not asked: never passed through
      { zip: '55430', geojson: { type: 'Point', coordinates: [-93.3, 45.06] } }, // not an outline
    ].filter((r) => r.zip === '99999' || p_zips.includes(r.zip)),
    error: null,
  }))
  const reader = createZipBoundaryReader({ supabase: c, clock: () => now })
  const r = await reader.read('55430,55412,55411,55405')
  assert.equal(c.calls.length, 1)
  assert.equal(c.calls[0].fn, 'analytics_zip_boundaries')
  assert.deepEqual(c.calls[0].args, { p_zips: ['55405', '55411', '55412', '55430'] })
  assert.equal(r.available, true)
  assert.equal(r.source, 'US Census ZCTA')
  assert.deepEqual(Object.keys(r.zips).sort(), ['55411', '55412'])
  assert.deepEqual(r.missing, ['55405', '55430'])
  // the same set in another order is one cache entry
  await reader.read(['55411', '55405', '55412', '55430'])
  assert.equal(c.calls.length, 1)
  assert.equal(reader.stats.cacheHits, 1)
  // outlines are static but the cache is still brief: after 10 minutes it reads again
  now += 10 * 60_000 + 1
  await reader.read('55411,55412,55430,55405')
  assert.equal(c.calls.length, 2)
  // at most 400 ZIPs ever reach the function
  await reader.read(Array.from({ length: 450 }, (_, i) => String(20000 + i)))
  assert.equal(c.calls[2].args.p_zips.length, 400)
})

test('zip outlines (function missing): PGRST202 / 404 answers available:false, cached briefly, never throws', async () => {
  let now = 0
  const c = client({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.analytics_zip_boundaries(p_zips) in the schema cache' }, status: 404 })
  const reader = createZipBoundaryReader({ supabase: c, clock: () => now })
  assert.deepEqual(await reader.read('55411,55412'), { available: false, reason: 'not_installed' })
  await reader.read('55412,55411')
  assert.equal(c.calls.length, 1, 'a missing function is not asked again inside a minute')
  now += 60_001
  await reader.read('55411,55412')
  assert.equal(c.calls.length, 2, 'and is asked again after it, so outlines appear soon after the migration lands')
  // a bare 404 without the PostgREST code is the same answer
  const c404 = client({ data: null, error: { message: 'Not Found' }, status: 404 })
  assert.deepEqual(await createZipBoundaryReader({ supabase: c404 }).read('55411'), { available: false, reason: 'not_installed' })
})

test('zip outlines (function failing): any error or a thrown client answers available:false; an empty request never calls', async () => {
  const denied = client({ data: null, error: { code: '42501', message: 'permission denied for function analytics_zip_boundaries' }, status: 401 })
  assert.deepEqual(await createZipBoundaryReader({ supabase: denied }).read('55411'), { available: false, reason: 'unavailable' })
  const throwing = { rpc: async () => { throw new Error('fetch failed') } }
  assert.deepEqual(await createZipBoundaryReader({ supabase: throwing }).read('55411'), { available: false, reason: 'unavailable' })
  const none = client({ data: [], error: null })
  assert.deepEqual(await createZipBoundaryReader({ supabase: none }).read('abc,12'), { available: false, reason: 'no_zips' })
  assert.equal(none.calls.length, 0)
})
