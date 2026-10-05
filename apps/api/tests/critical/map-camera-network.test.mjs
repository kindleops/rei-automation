import test from 'node:test'
import assert from 'node:assert/strict'

import { cameraFreshness, cameraIdFor, canonicalRoad, corridorKeyFor, finalizeCamera, normalizeDirection, normalizeStatus, orderCorridor, providerOfCameraId } from '@/lib/domain/map/cameras/camera-model.js'
import { coverageByState, effectiveProvider, publicProvider, validateProvider } from '@/lib/domain/map/cameras/camera-provider-registry.js'
import { isSameDevice, pickPrimary, resolveDuplicates } from '@/lib/domain/map/cameras/camera-dedupe.js'
import { hostAllowed, validateUpstreamUrl, _resetSnapshotCache, snapshotTtlSec } from '@/lib/domain/map/cameras/camera-media.js'
import { fetchCameraSnapshot, getCameraDetail, getCameraHealth, getCameraProviders, getCamerasInView, getNearbyCameras, parseBbox, refreshCameraProviders, timezoneForCamera, viewportMode } from '@/lib/domain/map/cameras/camera-network-service.js'
import { backoffMs } from '@/lib/domain/map/world-providers/provider-runtime.js'
import { makeClosingDb } from '../helpers/closing-db-mock.mjs'

const NOW = Date.parse('2026-09-30T15:00:00Z')
const SECRET = 'sk-test-secret-value-123'

const PROVIDER = {
  domain: 'cameras', provider_id: 'zz_test_dot', name: 'Test DOT', state: 'MN', region: null, provider_type: 'state_dot', adapter_type: 'test_json',
  coverage_status: 'FULL', enabled_by_default: true, requires_api_key: false, image_policy: 'proxy',
  image_hosts: ['images.test-dot.gov'], metadata_hosts: ['data.test-dot.gov'], refresh_interval_sec: 900, snapshot_cadence_sec: 60,
  attribution: 'Test DOT / 511', terms_url: 'https://test-dot.gov/terms', priority: 10,
}
const KEYED = {
  ...PROVIDER, provider_id: 'zz_keyed_511', name: 'Keyed 511', state: 'FL', adapter_type: 'keyed_json', requires_api_key: true, api_key_env: 'ZZ_KEYED_KEY',
  image_hosts: ['cams.keyed511.org'], metadata_hosts: ['api.keyed511.org'], priority: 20,
}
const REGISTRY = [PROVIDER, KEYED]

const RAW = [
  { id: 'C101', lat: 44.93, lon: -93.28, roadway: 'I 35W', dir: 'Northbound', mm: 12.4, img: 'https://images.test-dot.gov/cam/C101.jpg', updated: '2026-09-30T14:59:20Z', status: 'Active', extra: { weird: [1, 2] } },
  { id: 'C102', lat: 44.95, lon: -93.28, roadway: 'Interstate 35W', dir: 'NB', mm: 13.1, img: 'https://images.test-dot.gov/cam/C102.jpg', updated: '2026-09-30T14:30:00Z', status: 'Active' },
  { id: 'C103', lat: 44.97, lon: -93.27, roadway: 'I-35W', dir: 'N', mm: 14.0, img: 'https://images.test-dot.gov/cam/C103.jpg', updated: '2026-09-30T14:59:50Z', status: 'Out of service' },
  { id: 'C104', lat: 'not-a-number', lon: -93.2, roadway: 'I-94' }, // unplaceable → dropped
  { id: 'C 105/A', lat: 44.98, lon: -93.25, roadway: 'US Hwy 169', dir: 225, img: 'https://evil.example.com/x.jpg', updated: null, status: '???' },
]
const TEST_ADAPTER = {
  listRaw: async ({ fetch }) => fetch.json('https://data.test-dot.gov/cameras.json'),
  normalize: (r) => ({ external_camera_id: r.id, name: `${r.roadway} @ MM ${r.mm ?? '?'}`, latitude: r.lat, longitude: r.lon, road: r.roadway, direction: normalizeDirection(r.dir), mile_marker: r.mm, still_url: r.img, feed_type: 'REFRESHING_STILL', status: normalizeStatus(r.status), provider_updated_at: r.updated }),
}
const KEYED_ADAPTER = {
  listRaw: async ({ fetch, apiKey }) => fetch.json(`https://api.keyed511.org/cams?key=${apiKey}`),
  normalize: (r) => ({ external_camera_id: r.id, latitude: r.lat, longitude: r.lon, road: r.road, feed_type: 'REFRESHING_STILL', status: 'LIVE', provider_updated_at: r.updated }),
  snapshotRequest: (cam, { apiKey }) => ({ url: `https://cams.keyed511.org/img/${cam.external_camera_id}.jpg?key=${apiKey}` }),
}
const ADAPTERS = { test_json: TEST_ADAPTER, keyed_json: KEYED_ADAPTER }

const jsonRes = (body, status = 200) => ({ ok: status < 300, status, url: '', headers: new Map([['content-type', 'application/json']]), text: async () => JSON.stringify(body), arrayBuffer: async () => Buffer.from(JSON.stringify(body)) })
const imgRes = (bytes = Buffer.alloc(2048, 7), headers = {}) => {
  const h = new Map(Object.entries({ 'content-type': 'image/jpeg', 'last-modified': 'Wed, 30 Sep 2026 14:59:40 GMT', ...headers }))
  return { ok: true, status: 200, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, body: null, arrayBuffer: async () => bytes }
}
const hdr = (m) => ({ get: (k) => m.get(k.toLowerCase()) ?? null })
const wrap = (r) => ({ ...r, headers: r.headers instanceof Map ? hdr(r.headers) : r.headers })

/** In-memory PostGIS stand-ins with the same contracts as the migration's functions. */
const km = (a, b, c, d) => { const r = Math.PI / 180; const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)) }
const active = (st) => st.map_cameras.filter((c) => !c.retired_at && !c.duplicate_of)
const RPC = {
  map_cameras_in_bbox: ({ p_west, p_south, p_east, p_north, p_limit }, st) => ({ data: active(st).filter((c) => c.longitude >= p_west && c.longitude <= p_east && c.latitude >= p_south && c.latitude <= p_north).slice(0, Math.min(p_limit, 5000)), error: null }),
  map_camera_grid: ({ p_west, p_south, p_east, p_north, p_cell_deg }, st) => {
    const cells = new Map()
    for (const c of active(st)) {
      if (c.longitude < p_west || c.longitude > p_east || c.latitude < p_south || c.latitude > p_north) continue
      const k = `${Math.floor(c.longitude / p_cell_deg)}:${Math.floor(c.latitude / p_cell_deg)}`
      const cell = cells.get(k) || { lng: 0, lat: 0, cameras: 0, live: 0 }
      cell.lng += c.longitude; cell.lat += c.latitude; cell.cameras += 1; if (c.status === 'LIVE') cell.live += 1
      cells.set(k, cell)
    }
    return { data: [...cells.values()].map((c) => ({ ...c, lng: c.lng / c.cameras, lat: c.lat / c.cameras })), error: null }
  },
  map_cameras_nearby: ({ p_lat, p_lng, p_radius_m, p_limit }, st) => ({ data: active(st).map((c) => ({ ...c, distance_m: km(p_lat, p_lng, c.latitude, c.longitude) * 1000 })).filter((c) => c.distance_m <= p_radius_m).sort((a, b) => a.distance_m - b.distance_m).slice(0, p_limit), error: null }),
  map_camera_duplicate_pairs: ({ p_provider_id }, st) => {
    const out = []
    for (const a of st.map_cameras.filter((c) => c.provider_id === p_provider_id && !c.retired_at)) {
      for (const b of st.map_cameras.filter((c) => c.provider_id !== p_provider_id && !c.retired_at)) {
        const d = km(a.latitude, a.longitude, b.latitude, b.longitude) * 1000
        if (d <= 40) out.push({ camera_id: a.camera_id, provider_id: a.provider_id, name: a.name, road: a.road, direction: a.direction, feed_type: a.feed_type, status: a.status, provider_updated_at: a.provider_updated_at, other_camera_id: b.camera_id, other_provider_id: b.provider_id, other_name: b.name, other_road: b.road, other_direction: b.direction, other_feed_type: b.feed_type, other_status: b.status, other_provider_updated_at: b.provider_updated_at, distance_m: d })
      }
    }
    return { data: out, error: null }
  },
}
const AREAS = [
  { kind: 'zip', key: '55411', label: '55411', state: 'MN', n: 100, center_lat: 44.999, center_lng: -93.303, min_lat: 44.97, max_lat: 45.03, min_lng: -93.33, max_lng: -93.27 },
  { kind: 'zip', key: '32501', label: '32501', state: 'FL', n: 100, center_lat: 30.42, center_lng: -87.22, min_lat: 30.39, max_lat: 30.45, min_lng: -87.25, max_lng: -87.19 },
  { kind: 'zip', key: '33101', label: '33101', state: 'FL', n: 100, center_lat: 25.77, center_lng: -80.19, min_lat: 25.74, max_lat: 25.8, min_lng: -80.22, max_lng: -80.16 },
]
const newDb = () => makeClosingDb({ map_world_providers: [], map_world_provider_runs: [], map_cameras: [], mv_map_search_areas: AREAS }, { rpc: RPC })
const deps = (db, extra = {}) => ({ supabase: db, registry: REGISTRY, adapters: ADAPTERS, env: { ZZ_KEYED_KEY: SECRET }, now: NOW, ...extra })

async function seeded(extra = {}) {
  const db = newDb()
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.startsWith('https://data.test-dot.gov/')) return wrap(jsonRes(RAW))
    if (url.startsWith('https://api.keyed511.org/')) return wrap(jsonRes([{ id: 'K1', lat: 25.771, lon: -80.191, road: 'I-95', updated: '2026-09-30T14:59:00Z' }]))
    if (url.startsWith('https://images.test-dot.gov/') || url.startsWith('https://cams.keyed511.org/')) return imgRes()
    throw new Error(`unexpected fetch ${url}`)
  }
  const res = await refreshCameraProviders({ force: true }, deps(db, { fetchImpl, ...extra }))
  return { db, res, calls, fetchImpl }
}

/* ── canonical model ─────────────────────────────────────────────────────── */

test('camera ids are stable, URL-safe and round-trip to their provider', () => {
  assert.equal(cameraIdFor('zz_test_dot', 'C101'), 'zz_test_dot:C101')
  assert.equal(cameraIdFor('zz_test_dot', 'C101'), cameraIdFor('zz_test_dot', ' C101 '))
  const odd = cameraIdFor('zz_test_dot', 'C 105/A')
  assert.match(odd, /^zz_test_dot:[A-Za-z0-9._~-]+$/)
  assert.equal(encodeURIComponent(odd.split(':')[1]), odd.split(':')[1])
  assert.equal(providerOfCameraId(odd), 'zz_test_dot')
  assert.equal(cameraIdFor('Bad Provider', 'x'), null)
  assert.equal(cameraIdFor('zz_test_dot', ''), null)
})

test('direction, status and road normalise; unknowns stay unknown', () => {
  assert.equal(normalizeDirection('Northbound'), 'N')
  assert.equal(normalizeDirection('EB'), 'E')
  assert.equal(normalizeDirection(225), 'SW')
  assert.equal(normalizeDirection('Inner Loop'), null)
  assert.equal(normalizeStatus('Active'), 'LIVE')
  assert.equal(normalizeStatus('Out of service'), 'OFFLINE')
  assert.equal(normalizeStatus('Under maintenance'), 'MAINTENANCE')
  assert.equal(normalizeStatus('Blocked for incident'), 'BLOCKED_BY_PROVIDER')
  assert.equal(normalizeStatus('???'), 'UNKNOWN')
  assert.equal(normalizeStatus(''), 'UNKNOWN')
  assert.equal(canonicalRoad('Interstate 35W'), 'I-35W')
  assert.equal(canonicalRoad('IH-35'), 'I-35')
  assert.equal(canonicalRoad('US Hwy 169'), 'US-169')
  assert.equal(corridorKeyFor({ state: 'MN', road: 'I 94' }), 'MN|I-94')
})

test('finalize drops unplaceable rows, ignores unknown fields, never invents', () => {
  const ok = finalizeCamera(PROVIDER, { external_camera_id: 'A', latitude: '44.9', longitude: '-93.2', surprise: { deep: true }, feed_type: 'NOT_A_FEED', status: 'nonsense' })
  assert.equal(ok.feed_type, 'UNAVAILABLE')
  assert.equal(ok.status, 'UNKNOWN')
  assert.equal(ok.direction, null)
  assert.equal(ok.road, null)
  assert.equal(ok.provider_updated_at, null)
  assert.equal('surprise' in ok, false)
  assert.equal(finalizeCamera(PROVIDER, { external_camera_id: 'B', latitude: 0, longitude: 0 }), null)
  assert.equal(finalizeCamera(PROVIDER, { external_camera_id: 'C', latitude: 91, longitude: 0 }), null)
  assert.equal(finalizeCamera(PROVIDER, { latitude: 44.9, longitude: -93.2 }), null)
})

test('freshness follows each provider cadence — never one universal rule', () => {
  const at = new Date(NOW - 150_000).toISOString() // 2.5 min old
  assert.equal(cameraFreshness({ capturedAt: at, cadenceSec: 20, status: 'LIVE', now: NOW }).state, 'stale') // 20 s cadence → stale after 110 s
  assert.equal(cameraFreshness({ capturedAt: at, cadenceSec: 300, status: 'LIVE', now: NOW }).state, 'fresh') // 5 min cadence
  assert.equal(cameraFreshness({ capturedAt: at, cadenceSec: 60, status: 'OFFLINE', now: NOW }).state, 'offline')
  assert.equal(cameraFreshness({ capturedAt: null, cadenceSec: 60, status: 'LIVE', now: NOW }).state, 'unknown')
})

test('corridor order uses mile markers when published, else the road geometry', () => {
  const mm = orderCorridor([{ camera_id: 'b', latitude: 45, longitude: -93, mile_marker: 20 }, { camera_id: 'a', latitude: 44.9, longitude: -93, mile_marker: 10 }, { camera_id: 'c', latitude: 45.1, longitude: -93, mile_marker: 30 }])
  assert.equal(mm.basis, 'mile_marker')
  assert.deepEqual(['a', 'b', 'c'].map((k) => mm.ranks.get(k)), [1, 2, 3])
  // a curve: geometry chain visits neighbours in road order, not a zig-zag
  const geo = orderCorridor([
    { camera_id: 'p1', latitude: 44.90, longitude: -93.30 }, { camera_id: 'p3', latitude: 44.96, longitude: -93.26 },
    { camera_id: 'p2', latitude: 44.93, longitude: -93.29 }, { camera_id: 'p4', latitude: 44.97, longitude: -93.21 },
  ])
  assert.equal(geo.basis, 'geometry')
  const order = [...geo.ranks.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k)
  assert.deepEqual(order, ['p1', 'p2', 'p3', 'p4'])
})

/* ── registry ─────────────────────────────────────────────────────────────── */

test('registry invariants: keyed providers must proxy; bad entries fail loudly', () => {
  assert.deepEqual(validateProvider(PROVIDER), [])
  assert.deepEqual(validateProvider(KEYED), [])
  assert.ok(validateProvider({ ...KEYED, image_policy: 'direct' }).some((p) => /must proxy/.test(p)))
  assert.ok(validateProvider({ ...PROVIDER, provider_id: 'Bad-Id' }).some((p) => /snake_case/.test(p)))
  assert.ok(validateProvider({ ...PROVIDER, refresh_interval_sec: 60 }).some((p) => /300/.test(p)))
})

test('a keyed provider without its key is disabled, not half-working', () => {
  assert.equal(effectiveProvider(KEYED, {}).enabled, false)
  assert.equal(effectiveProvider(KEYED, {}).disabled_reason, 'api_key_not_configured')
  assert.equal(effectiveProvider(KEYED, { ZZ_KEYED_KEY: SECRET }).enabled, true)
  assert.equal(effectiveProvider(PROVIDER, { WORLD_PROVIDERS_DISABLED: 'zz_test_dot' }).disabled_reason, 'disabled_by_operator')
})

test('coverage never reads "0 cameras" for a state we have not connected', () => {
  const cov = coverageByState([effectiveProvider(PROVIDER, {})], { zz_test_dot: { item_count: 3 } })
  assert.equal(cov.MN.connected, true)
  assert.equal(cov.MN.camera_count, 3)
  assert.equal(cov.WI.connected, false)
  assert.equal(cov.WI.camera_count, null)
  assert.equal(cov.WI.label, '511WI needs agency permission', 'a state awaiting agency permission says so')
  assert.equal(cov.WY.label, 'No public camera source connected')
})

/* ── security ─────────────────────────────────────────────────────────────── */

test('the upstream allowlist rejects everything that is not the provider’s own host', () => {
  assert.equal(hostAllowed('images.test-dot.gov', ['images.test-dot.gov']), true)
  assert.equal(hostAllowed('a.cams.test.gov', ['.cams.test.gov']), true)
  assert.equal(hostAllowed('evilcams.test.gov', ['.cams.test.gov']), false)
  assert.equal(hostAllowed('images.test-dot.gov.evil.com', ['images.test-dot.gov']), false)
  for (const bad of [
    'http://169.254.169.254/latest/meta-data', 'https://127.0.0.1/x.jpg', 'https://localhost/x.jpg', 'https://[::1]/x.jpg',
    'https://user:pw@images.test-dot.gov/x.jpg', 'https://images.test-dot.gov:8443/x.jpg', 'http://images.test-dot.gov/x.jpg',
    'file:///etc/passwd', 'https://evil.example.com/x.jpg', 'javascript:alert(1)',
  ]) assert.equal(validateUpstreamUrl(bad, PROVIDER).ok, false, bad)
  assert.equal(validateUpstreamUrl('https://images.test-dot.gov/cam/C101.jpg', PROVIDER).ok, true)
})

test('snapshot proxy: canonical id only; a stored off-allowlist URL is refused; redirects off-list refused', async () => {
  _resetSnapshotCache()
  const { db } = await seeded()
  // C 105/A carries an evil still_url in the provider data — it must never be fetched
  const evilId = cameraIdFor('zz_test_dot', 'C 105/A')
  let fetched = []
  const fetchImpl = async (url) => { fetched.push(url); return imgRes() }
  const bad = await fetchCameraSnapshot(evilId, deps(db, { fetchImpl }))
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'host_not_allowed')
  assert.deepEqual(fetched, [])
  // allowlisted host → served, with capture time from upstream Last-Modified
  const good = await fetchCameraSnapshot('zz_test_dot:C101', deps(db, { fetchImpl }))
  assert.equal(good.ok, true)
  assert.equal(good.content_type, 'image/jpeg')
  assert.equal(good.captured_basis, 'upstream_last_modified')
  // second open within the cadence is served from memory (one upstream request)
  const again = await fetchCameraSnapshot('zz_test_dot:C101', deps(db, { fetchImpl }))
  assert.equal(again.from_cache, true)
  assert.equal(fetched.length, 1)
  // redirect to another host is refused
  _resetSnapshotCache()
  const redirecting = async () => ({ ok: false, status: 302, headers: hdr(new Map([['location', 'https://evil.example.com/steal.jpg']])) })
  const r = await fetchCameraSnapshot('zz_test_dot:C102', deps(db, { fetchImpl: redirecting }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /redirect_host_not_allowed/)
  // an HTML placeholder page is not an image
  _resetSnapshotCache()
  const html = async () => ({ ok: true, status: 200, headers: hdr(new Map([['content-type', 'text/html']])), arrayBuffer: async () => Buffer.from('<html>') })
  assert.equal((await fetchCameraSnapshot('zz_test_dot:C102', deps(db, { fetchImpl: html }))).reason, 'upstream_not_an_image')
})

test('provider secrets never reach a client payload (detail, view, providers, health, errors)', async () => {
  _resetSnapshotCache()
  const { db, res } = await seeded()
  const keyedId = cameraIdFor('zz_keyed_511', 'K1')
  const payloads = [
    res,
    await getCameraDetail(keyedId, deps(db)),
    await getCamerasInView({ bbox: '-81,25,-80,26', zoom: 12 }, deps(db)),
    await getCameraProviders(deps(db)),
    await getCameraHealth(deps(db)),
  ]
  for (const p of payloads) {
    const s = JSON.stringify(p)
    assert.equal(s.includes(SECRET), false)
    assert.equal(s.includes('ZZ_KEYED_KEY'), false)
    assert.equal(s.includes('api.keyed511.org'), false)
  }
  // the keyed still is served by id, the key added server-side
  const detail = await getCameraDetail(keyedId, deps(db))
  assert.equal(detail.media.still.kind, 'proxy')
  assert.equal(detail.media.still.path, `/api/cockpit/map/cameras/${encodeURIComponent(keyedId)}/snapshot`)
  // a stored keyed URL must never be persisted with the key either
  assert.equal(JSON.stringify(db.state.map_cameras).includes(SECRET), false)
})

/* ── viewport, detail, nearby ─────────────────────────────────────────────── */

test('viewport is bounded and semantic: none → coverage → points', async () => {
  assert.equal(parseBbox('-200,20,-60,50'), null) // not a place
  assert.equal(parseBbox('a,b,c,d'), null)
  assert.equal(parseBbox('-93,45,-94,44'), null) // inverted
  assert.deepEqual(viewportMode(4), { mode: 'none' })
  assert.equal(viewportMode(6.5).mode, 'coverage')
  assert.equal(viewportMode(11).mode, 'points')
  const { db } = await seeded()
  const national = await getCamerasInView({ bbox: '-100,30,-80,48', zoom: 4 }, deps(db))
  assert.equal(national.mode, 'none')
  assert.equal(national.cameras.length, 0)
  const state = await getCamerasInView({ bbox: '-97,43,-89,49', zoom: 6 }, deps(db))
  assert.equal(state.mode, 'coverage')
  assert.ok(state.cells.length >= 1)
  assert.equal(state.cameras.length, 0)
  const continent = await getCamerasInView({ bbox: '-130,20,-60,50', zoom: 9 }, deps(db))
  assert.equal(continent.mode, 'coverage') // never a continent of points, whatever the zoom claims
  assert.equal(continent.cameras.length, 0)
  const metro = await getCamerasInView({ bbox: '-93.4,44.85,-93.1,45.05', zoom: 11 }, deps(db))
  assert.equal(metro.mode, 'points')
  assert.equal(metro.cameras.length, 4) // C104 unplaceable, all others placed
  assert.deepEqual(metro.attributions, [{ provider: 'Test DOT', text: 'Test DOT / 511' }])
  assert.equal(metro.cameras.find((c) => c.id === 'zz_test_dot:C103').freshness, 'offline')
})

test('detail: freshness, local timezone, corridor position, attribution, honest media', async () => {
  const { db } = await seeded()
  const d = await getCameraDetail('zz_test_dot:C102', deps(db))
  assert.equal(d.ok, true)
  assert.equal(d.camera.road, 'I-35W')
  assert.equal(d.camera.direction, 'N')
  assert.equal(d.camera.timezone, 'America/Chicago')
  assert.equal(d.camera.freshness.state, 'stale') // 30 min old at a 60 s cadence
  assert.equal(d.provider.attribution, 'Test DOT / 511')
  assert.deepEqual([d.corridor.index, d.corridor.total], [2, 3])
  assert.equal(d.corridor.prev.id, 'zz_test_dot:C101')
  assert.equal(d.corridor.next.id, 'zz_test_dot:C103')
  assert.equal(d.media.still.kind, 'proxy')
  assert.equal(d.media.stream, null) // a refreshing still is never presented as video
  assert.equal((await getCameraDetail('zz_test_dot:NOPE', deps(db))).status, 404)
  assert.equal((await getCameraDetail('not-an-id', deps(db))).status, 404)
})

test('link-only providers expose no media URL; the Map links to the official page instead', async () => {
  const linkOnly = [{ ...PROVIDER, image_policy: 'link_only' }, KEYED]
  const { db } = await seeded({ registry: linkOnly })
  const d = await getCameraDetail('zz_test_dot:C101', deps(db, { registry: linkOnly }))
  assert.equal(d.media.still, null)
  assert.equal(d.media.stream, null)
})

test('nearby cameras for a property: true distance, bounded, only connected providers', async () => {
  const { db } = await seeded()
  const n = await getNearbyCameras({ lat: 44.935, lng: -93.28, radiusM: 5000, limit: 2 }, deps(db))
  assert.equal(n.ok, true)
  assert.equal(n.cameras.length, 2)
  assert.equal(n.cameras[0].id, 'zz_test_dot:C101')
  assert.ok(n.cameras[0].distance_m < n.cameras[1].distance_m)
  assert.equal((await getNearbyCameras({ lat: 'x', lng: 1 }, deps(db))).status, 400)
})

/* ── dedupe ───────────────────────────────────────────────────────────────── */

test('one physical device, one icon — official owner wins, lineage kept', () => {
  const a = { camera_id: 'dot:1', provider_id: 'dot', name: 'I-94 @ Hennepin Ave', road: 'I-94', direction: 'E', feed_type: 'REFRESHING_STILL', status: 'LIVE', provider_updated_at: '2026-09-30T14:59:00Z' }
  const b = { camera_id: 'city:9', provider_id: 'city', name: 'I94 at Hennepin', road: 'Interstate 94', direction: 'E', feed_type: 'HLS', status: 'LIVE', provider_updated_at: '2026-09-30T14:59:30Z' }
  assert.equal(isSameDevice(a, b, 12), true)
  assert.equal(isSameDevice(a, { ...b, direction: 'W' }, 12), false) // two views of one pole = two cameras
  assert.equal(isSameDevice(a, { ...b, road: 'US-169' }, 12), false)
  assert.equal(isSameDevice(a, b, 80), false)
  const prio = (id) => ({ dot: 10, city: 50 })[id]
  assert.equal(pickPrimary(a, b, prio).camera_id, 'dot:1')
  const pairs = [{ ...a, other_camera_id: b.camera_id, other_provider_id: b.provider_id, other_name: b.name, other_road: b.road, other_direction: b.direction, other_feed_type: b.feed_type, other_status: b.status, other_provider_updated_at: b.provider_updated_at, distance_m: 12 }]
  const out = resolveDuplicates(pairs, prio)
  assert.deepEqual(out.find((x) => x.camera_id === 'city:9'), { camera_id: 'city:9', duplicate_of: 'dot:1' })
  assert.deepEqual(out.find((x) => x.camera_id === 'dot:1'), { camera_id: 'dot:1', duplicate_of: null })
})

test('a camera published by two providers is drawn once', async () => {
  const twin = { ...PROVIDER, provider_id: 'zz_city_cams', name: 'City Cams', adapter_type: 'twin', priority: 50, metadata_hosts: ['data.city.gov'], image_hosts: ['img.city.gov'] }
  const reg = [PROVIDER, twin]
  const adapters = { ...ADAPTERS, twin: { listRaw: async () => [{ id: 'T1', lat: 44.93001, lon: -93.28001, roadway: 'I-35W', dir: 'N' }], normalize: (r) => ({ external_camera_id: r.id, name: 'I-35W @ MM 12.4', latitude: r.lat, longitude: r.lon, road: r.roadway, direction: r.dir, feed_type: 'REFRESHING_STILL', status: 'LIVE' }) } }
  const db = newDb()
  const fetchImpl = async () => wrap(jsonRes(RAW))
  await refreshCameraProviders({ force: true }, deps(db, { registry: reg, adapters, fetchImpl }))
  const metro = await getCamerasInView({ bbox: '-93.4,44.85,-93.1,45.05', zoom: 12 }, deps(db, { registry: reg, adapters }))
  const near = metro.cameras.filter((c) => Math.abs(c.lat - 44.93) < 0.001)
  assert.equal(near.length, 1)
  assert.equal(near[0].id, 'zz_test_dot:C101')
  assert.equal(db.state.map_cameras.find((c) => c.camera_id === 'zz_city_cams:T1').duplicate_of, 'zz_test_dot:C101')
})

/* ── refresh lifecycle ────────────────────────────────────────────────────── */

test('refresh: heartbeat + ledger; keyed provider pulled with its key; nothing leaks', async () => {
  const { db, res, calls } = await seeded()
  assert.equal(res.ok, true)
  const t = res.results.find((r) => r.provider_id === 'zz_test_dot')
  assert.equal(t.ok, true)
  assert.equal(t.cameras, 4)
  const hb = db.state.map_world_providers.find((p) => p.provider_id === 'zz_test_dot')
  assert.equal(hb.domain, 'cameras')
  assert.equal(hb.item_count, 4)
  assert.equal(hb.consecutive_failures, 0)
  assert.equal(hb.lease_until, null)
  assert.equal(hb.next_refresh_at, new Date(NOW + 900_000).toISOString())
  const run = db.state.map_world_provider_runs.find((r) => r.provider_id === 'zz_test_dot')
  assert.equal(run.ok, true)
  assert.equal(run.items_received, 5)
  assert.equal(run.items_normalized, 4)
  assert.ok(calls.some((u) => u.startsWith('https://api.keyed511.org/cams?key=')))
})

test('refresh honours cadence: a provider that is not due is not pulled', async () => {
  const { db } = await seeded()
  let pulled = 0
  const fetchImpl = async () => { pulled += 1; return wrap(jsonRes(RAW)) }
  const again = await refreshCameraProviders({}, deps(db, { fetchImpl, now: NOW + 60_000 }))
  assert.equal(again.results.find((r) => r.provider_id === 'zz_test_dot').skipped, 'not_due')
  assert.equal(pulled, 0)
})

test('a failed pull keeps the inventory, backs off, and never marks cameras missing', async () => {
  const { db } = await seeded()
  const before = db.state.map_cameras.filter((c) => c.provider_id === 'zz_test_dot' && !c.retired_at).length
  const down = async (url) => (url.startsWith('https://data.test-dot.gov/') ? wrap(jsonRes({ error: 'boom' }, 503)) : wrap(jsonRes([])))
  const r = await refreshCameraProviders({ force: true, providerIds: ['zz_test_dot'] }, deps(db, { fetchImpl: down, now: NOW + 3_600_000 }))
  const f = r.results[0]
  assert.equal(f.ok, false)
  assert.match(f.error, /source_http_503/)
  const hb = db.state.map_world_providers.find((p) => p.provider_id === 'zz_test_dot')
  assert.equal(hb.health_state, 'failing')
  assert.equal(hb.consecutive_failures, 1)
  assert.equal(hb.next_refresh_at, new Date(NOW + 3_600_000 + backoffMs(1, 900)).toISOString())
  assert.equal(db.state.map_cameras.filter((c) => c.provider_id === 'zz_test_dot' && !c.retired_at && !c.missing_since).length, before)
  assert.ok(backoffMs(1, 900) < backoffMs(3, 900))
  assert.ok(backoffMs(20, 900) <= 6 * 3_600_000)
})

test('a camera absent from a good pull is marked missing, then retired after 72 h — never deleted', async () => {
  const { db } = await seeded()
  const without = async () => wrap(jsonRes(RAW.filter((r) => r.id !== 'C102')))
  await refreshCameraProviders({ force: true, providerIds: ['zz_test_dot'] }, deps(db, { fetchImpl: without, now: NOW + 3_600_000 }))
  const c = db.state.map_cameras.find((x) => x.camera_id === 'zz_test_dot:C102')
  assert.ok(c.missing_since)
  assert.equal(c.retired_at ?? null, null)
  await refreshCameraProviders({ force: true, providerIds: ['zz_test_dot'] }, deps(db, { fetchImpl: without, now: NOW + 80 * 3_600_000 }))
  const c2 = db.state.map_cameras.find((x) => x.camera_id === 'zz_test_dot:C102')
  assert.ok(c2.retired_at)
  assert.equal(db.state.map_cameras.some((x) => x.camera_id === 'zz_test_dot:C102'), true)
})

test('camera-local timezone comes from our geography, never a guess', () => {
  assert.equal(timezoneForCamera({ state: 'MN', latitude: 44.9, longitude: -93.2 }, AREAS), 'America/Chicago')
  assert.equal(timezoneForCamera({ state: 'FL', latitude: 30.42, longitude: -87.22 }, AREAS), 'America/Chicago') // Pensacola: Central
  assert.equal(timezoneForCamera({ state: 'FL', latitude: 25.77, longitude: -80.19 }, AREAS), 'America/New_York')
  assert.equal(timezoneForCamera({ state: 'FL', latitude: 28.0, longitude: -82.4 }, AREAS), null) // split state, no nearby ZIP → unknown, not a guess
})

test('a still is held about one cadence — never shorter than 10 s nor longer than 2 min', () => {
  assert.equal(snapshotTtlSec(20), 10)
  assert.equal(snapshotTtlSec(120), 60)
  assert.equal(snapshotTtlSec(3600), 120)
  assert.equal(snapshotTtlSec(null), 30)
})

test('the public provider view carries attribution and terms, never hosts or env names', () => {
  const v = publicProvider(effectiveProvider(KEYED, { ZZ_KEYED_KEY: SECRET }), { item_count: 1 })
  assert.equal(v.attribution, 'Test DOT / 511')
  assert.equal(JSON.stringify(v).includes('ZZ_KEYED_KEY'), false)
  assert.equal(JSON.stringify(v).includes('keyed511.org'), false)
})
