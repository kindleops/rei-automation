/**
 * MN + TX camera adapters on real official-response fixtures, the registry
 * entries that use them, and the in-memory inventory the Map reads until
 * public.map_cameras is applied. No network: every fetch is injected.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { finalizeCamera } from '@/lib/domain/map/cameras/camera-model.js'
import { CAMERA_PROVIDERS, publicProvider, validateProvider } from '@/lib/domain/map/cameras/camera-provider-registry.js'
import { CAMERA_ADAPTERS } from '@/lib/domain/map/cameras/camera-adapters.js'
import { mndotDirection, mndotMilePost, mndotRoad } from '@/lib/domain/map/cameras/adapters/mndot-iris.js'
import { flattenTxdotDistrict, txdotStatus } from '@/lib/domain/map/cameras/adapters/txdot-its.js'
import { _resetCameraMemoryStore, boxesOverlap } from '@/lib/domain/map/cameras/camera-memory-store.js'
import { _resetSnapshotCache } from '@/lib/domain/map/cameras/camera-media.js'
import { fetchCameraSnapshot, getCameraDetail, getCameraProviders, getCamerasInView, getNearbyCameras } from '@/lib/domain/map/cameras/camera-network-service.js'

const fx = (p) => JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/cameras/${p}`, import.meta.url)), 'utf8'))
const MN_PUB = fx('mn_mndot_iris/camera_pub.json')
const TX_DAL = fx('tx_txdot_its/cctv_status_list_dal.json')
const AUSTIN = fx('tx_austin_mobility/traffic_cameras_b4k4-adkb.json')
const NOW = Date.parse('2026-10-03T20:00:00Z')
const prov = (id) => CAMERA_PROVIDERS.find((p) => p.provider_id === id)
const normalizeAll = (id, rows) => {
  const p = prov(id)
  const a = CAMERA_ADAPTERS[p.adapter_type]
  return rows.map((r) => finalizeCamera(p, a.normalize(r, { provider: p, now: NOW }), { refreshedAt: new Date(NOW).toISOString() })).filter(Boolean)
}

test('registry: MN + TX entries are valid, have adapters, and no secret or host reaches a client', () => {
  for (const id of ['mn_mndot_iris', 'tx_txdot_its', 'tx_austin_mobility']) {
    const p = prov(id)
    assert.ok(p, id)
    assert.deepEqual(validateProvider(p), [], id)
    assert.ok(CAMERA_ADAPTERS[p.adapter_type], `${id} adapter`)
    // attribution / terms_url are the agency's own required credit; everything else must carry no host.
    const { attribution: _a, terms_url: _t, ...rest } = publicProvider({ ...p, enabled: true })
    const pub = JSON.stringify(rest)
    for (const h of [...p.image_hosts, ...p.metadata_hosts]) assert.ok(!pub.includes(h), `${id} leaks ${h}`)
  }
  // TxDOT imagery: internal-use pass-through only (no cache), labelled as such.
  assert.equal(prov('tx_txdot_its').image_policy, 'proxy')
  assert.equal(prov('tx_txdot_its').adapter_config.no_cache, true)
  assert.equal(prov('tx_txdot_its').adapter_config.internal_use, true)
  assert.match(prov('tx_txdot_its').attribution, /internal use, pending TxDOT data-sharing agreement/)
  assert.deepEqual(prov('tx_txdot_its').adapter_config.districts, ['DAL', 'FTW', 'HOU', 'SAT', 'AUS'])
})

test('MnDOT: only publish:true cameras with coordinates; roads, directions and mile posts as MnDOT writes them', () => {
  const cams = normalizeAll('mn_mndot_iris', MN_PUB)
  const expected = MN_PUB.filter((c) => c.publish === true && c.lat !== undefined && c.lon !== undefined).length
  assert.equal(cams.length, expected)
  assert.ok(!cams.some((c) => c.external_camera_id === 'C027'), 'publish:false is never drawn')
  const c001 = cams.find((c) => c.external_camera_id === 'C001')
  assert.equal(c001.road, 'MN-36')
  assert.equal(c001.direction, 'W')
  assert.equal(c001.still_url, 'https://video.dot.state.mn.us/video/image/metro/C001')
  assert.equal(c001.status, 'UNKNOWN', 'no public health flag → never assumed LIVE')
  assert.equal(c001.camera_id, 'mn_mndot_iris:C001')
  assert.equal(mndotRoad('T.H.52'), 'MN-52')
  assert.equal(mndotRoad('U.S.63'), 'U.S.63') // canonicalRoad finishes it → US-63
  assert.equal(mndotMilePost('T.H.52 NB @ 75th St NW (MP 61.7)'), 61.7)
  assert.equal(mndotDirection('N-S'), 'BOTH')
  assert.equal(mndotDirection(''), null)
})

test('TxDOT ITS: district lists flatten, composite ids, status as TxDOT reports it, TxDOT page link — no image URL', () => {
  const rows = flattenTxdotDistrict(TX_DAL, 'DAL')
  assert.equal(rows.length, 6)
  const cams = normalizeAll('tx_txdot_its', rows)
  assert.equal(cams.length, 6)
  const c = cams[0]
  assert.match(c.camera_id, /^tx_txdot_its:DAL-/)
  assert.equal(c.road, 'I-20')
  assert.equal(c.direction, 'E')
  assert.equal(c.status, 'LIVE')
  assert.equal(c.feed_type, 'REFRESHING_STILL')
  assert.equal(c.still_url, null, 'TxDOT publishes no image URL')
  assert.equal(c.metadata.icd_id, 'IH20 @ Dallas-Tarrant CL')
  assert.equal(c.provider_page_url, 'https://its.txdot.gov/its/District/DAL/cameras')
  assert.equal(txdotStatus('Device Offline'), 'OFFLINE')
  assert.equal(txdotStatus('something else'), 'UNKNOWN')
  assert.deepEqual(flattenTxdotDistrict({ nope: 1 }, 'DAL'), [])
})

test('City of Austin: TURNED_ON only (VOID serves years-old images), GeoJSON point order respected', () => {
  const cams = normalizeAll('tx_austin_mobility', AUSTIN)
  assert.equal(cams.length, AUSTIN.filter((r) => r.camera_status === 'TURNED_ON').length)
  const one = cams.find((c) => c.external_camera_id === '1')
  assert.ok(one.latitude > 30 && one.latitude < 31 && one.longitude < -97)
  assert.equal(one.still_url, 'https://cctv.austinmobility.io/image/1.jpg')
})

/* ── memory store (the live read path until map_cameras is applied) ───── */

const jsonRes = (body) => ({ ok: true, status: 200, url: '', headers: { get: () => null }, text: async () => JSON.stringify(body) })
const imgRes = () => ({ ok: true, status: 200, headers: { get: (k) => ({ 'content-type': 'image/jpeg', 'last-modified': 'Sat, 03 Oct 2026 19:59:50 GMT' })[k.toLowerCase()] ?? null }, body: null, arrayBuffer: async () => Buffer.alloc(1024, 3) })

function harness() {
  _resetCameraMemoryStore()
  _resetSnapshotCache()
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.startsWith('https://data.dot.state.mn.us/iris/camera_pub')) return jsonRes(MN_PUB)
    if (url.startsWith('https://its.txdot.gov/its/DistrictIts/GetCctvStatusListByDistrict?districtCode=DAL')) return jsonRes(TX_DAL)
    if (url.startsWith('https://its.txdot.gov/')) return jsonRes({ roadwayCctvStatuses: {} })
    if (url.startsWith('https://data.austintexas.gov/')) return jsonRes(AUSTIN)
    if (url.startsWith('https://video.dot.state.mn.us/')) return imgRes()
    throw new Error(`unexpected fetch ${url}`)
  }
  return { calls, deps: { store: 'memory', fetchImpl, env: {}, now: NOW } }
}
const MSP = '-93.6,44.7,-92.9,45.2'
const DFW = '-97.3,32.5,-96.5,33.1'

test('memory view: a Twin Cities viewport pulls MnDOT only, draws points, and says who covers it', async () => {
  const { calls, deps } = harness()
  const v = await getCamerasInView({ bbox: MSP, zoom: 11 }, deps)
  assert.equal(v.ok, true)
  assert.equal(v.mode, 'points')
  assert.ok(v.cameras.length > 0)
  assert.ok(v.cameras.every((c) => c.provider === 'MnDOT' && c.media === 'still'))
  assert.ok(calls.every((u) => u.startsWith('https://data.dot.state.mn.us/')), 'a MN view never pulls Texas')
  assert.deepEqual(v.coverage.map((c) => c.provider), ['MnDOT'])
  assert.ok(v.attributions[0].text.includes('MnDOT'))
  // second read inside the cadence: no new pull
  const n = calls.length
  await getCamerasInView({ bbox: MSP, zoom: 12 }, deps)
  assert.equal(calls.length, n)
})

test('memory view: Dallas shows TxDOT cameras; a viewport nobody covers says so', async () => {
  const { deps } = harness()
  const v = await getCamerasInView({ bbox: DFW, zoom: 11 }, deps)
  assert.ok(v.cameras.length > 0)
  assert.ok(v.cameras.every((c) => c.media === 'still'))
  assert.ok(v.coverage.some((c) => c.provider === 'TxDOT ITS'))
  const none = await getCamerasInView({ bbox: '-84.6,33.5,-84.1,34.0', zoom: 11 }, deps) // Atlanta
  assert.equal(none.cameras.length, 0)
  assert.deepEqual(none.coverage, [])
  assert.equal(none.note, 'no_provider_in_view')
})

test('memory detail + snapshot: MnDOT still is proxied by canonical id; TxDOT detail is an internal-use pass-through with its own page', async () => {
  const { deps } = harness()
  const d = await getCameraDetail('mn_mndot_iris:C001', deps)
  assert.equal(d.ok, true)
  assert.equal(d.media.still.kind, 'proxy')
  // C001 is IRIS-streamable: the official MnDOT HLS URL, for the browser to open on click
  assert.deepEqual(d.media.stream, { type: 'HLS', url: 'https://video.dot.state.mn.us/public/C001.stream/playlist.m3u8' })
  assert.equal(d.provider.image_policy, 'proxy')
  const s = await fetchCameraSnapshot('mn_mndot_iris:C001', deps)
  assert.equal(s.ok, true)
  assert.equal(s.content_type, 'image/jpeg')
  assert.equal(s.captured_at, '2026-10-03T19:59:50.000Z')

  const tx = (await getCamerasInView({ bbox: DFW, zoom: 11 }, deps)).cameras[0]
  const td = await getCameraDetail(tx.id, deps)
  assert.equal(td.ok, true)
  assert.equal(td.media.still.kind, 'proxy')
  assert.equal(td.media.still.passthrough, true)
  assert.equal(td.provider.internal_use, true)
  assert.match(td.media.provider_page_url, /^https:\/\/its\.txdot\.gov\/its\/District\/DAL\/cameras$/)
})

test('memory: a failed pull keeps nothing invented — the viewport reports the provider unavailable', async () => {
  _resetCameraMemoryStore()
  const deps = { store: 'memory', env: {}, now: NOW, fetchImpl: async () => { throw new Error('boom https://data.dot.state.mn.us/secret') } }
  const v = await getCamerasInView({ bbox: MSP, zoom: 11 }, deps)
  assert.equal(v.ok, true)
  assert.equal(v.cameras.length, 0)
  assert.deepEqual(v.unavailable, ['MnDOT'])
  const p = await getCameraProviders(deps)
  const mn = p.providers.find((x) => x.provider_id === 'mn_mndot_iris')
  assert.equal(mn.health_state, 'failing')
  assert.ok(!JSON.stringify(p).includes('secret'))
})

test('memory nearby: true distance from a property, connected providers only', async () => {
  const { deps } = harness()
  const r = await getNearbyCameras({ lat: 44.97, lng: -93.25, radiusM: 20_000, limit: 3 }, deps)
  assert.equal(r.ok, true)
  assert.ok(r.cameras.length >= 1)
  for (let i = 1; i < r.cameras.length; i += 1) assert.ok(r.cameras[i].distance_m >= r.cameras[i - 1].distance_m)
})

test('boxesOverlap', () => {
  assert.equal(boxesOverlap({ west: 0, south: 0, east: 1, north: 1 }, { west: 0.5, south: 0.5, east: 2, north: 2 }), true)
  assert.equal(boxesOverlap({ west: 0, south: 0, east: 1, north: 1 }, { west: 2, south: 2, east: 3, north: 3 }), false)
  assert.equal(boxesOverlap(undefined, { west: 2, south: 2, east: 3, north: 3 }), true)
})

/* ── live video (owner-approved 2026-10-03): MnDOT streamable + Caltrans ── */

import { caltransPageUrl, caltransStatus, caltransStream } from '@/lib/domain/map/cameras/adapters/caltrans-cwwp2.js'

const CA_ALL = Array.from({ length: 12 }, (_, i) => i + 1).flatMap((n) => fx(`ca_caltrans_d${n}/cctv_status_d${String(n).padStart(2, '0')}.json`).data.map((r) => ({ ...r.cctv, __district: n })))

test('MnDOT: HLS only for cameras IRIS marks streamable, at MnDOT’s own server', () => {
  const cams = normalizeAll('mn_mndot_iris', MN_PUB)
  for (const c of cams) {
    const raw = MN_PUB.find((r) => r.name === c.external_camera_id)
    if (raw.streamable === true) {
      assert.equal(c.feed_type, 'HLS')
      assert.equal(c.stream_url, `https://video.dot.state.mn.us/public/${raw.name}.stream/playlist.m3u8`)
    } else {
      assert.equal(c.stream_url, null)
      assert.equal(c.feed_type, 'REFRESHING_STILL')
    }
  }
  assert.ok(cams.some((c) => c.stream_url) && cams.some((c) => !c.stream_url))
})

test('Caltrans CWWP2: 12 district fixtures normalise; official HLS only; status, direction, cadence and page as published', () => {
  const p = prov('ca_caltrans_cwwp2')
  assert.deepEqual(validateProvider(p), [])
  const cams = normalizeAll('ca_caltrans_cwwp2', CA_ALL)
  assert.equal(cams.length, CA_ALL.length)
  const d7 = cams.find((c) => c.external_camera_id === 'D7-1')
  assert.equal(d7.name, 'I-110 : (196) Avenue 26 Off Ramp')
  assert.equal(d7.road, 'I-110')
  assert.equal(d7.direction, 'S')
  assert.equal(d7.feed_type, 'HLS')
  assert.equal(d7.stream_url, 'https://wzmedia.dot.ca.gov/D7/CCTV-196.stream/playlist.m3u8')
  assert.equal(d7.snapshot_cadence_sec, 120)
  assert.equal(d7.provider_page_url, 'https://cwwp2.dot.ca.gov/vm/loc/d7/i110196avenue26offramp.htm')
  assert.equal(d7.county, null, 'county is unreliable in the feed — not carried')
  const withStream = cams.filter((c) => c.stream_url)
  assert.equal(withStream.length, CA_ALL.filter((r) => /^https:/.test(r.imageData?.streamingVideoURL || '')).length)
  assert.ok(withStream.every((c) => /^https:\/\/wzmedia\.dot\.ca\.gov\/[^:]/.test(c.stream_url)), ':443 is normalised away')
  assert.ok(cams.filter((c) => !c.stream_url).every((c) => c.feed_type === 'REFRESHING_STILL'))
  assert.ok(cams.some((c) => c.status === 'OFFLINE'), 'inService=false is offline')
  assert.ok(cams.some((c) => c.direction === null), '"" / "Median" is no direction')
  assert.equal(caltransStatus('Not Reported'), 'UNKNOWN')
  assert.equal(caltransStream('https://evil.example.com/x.m3u8'), null)
  assert.equal(caltransStream('http://wzmedia.dot.ca.gov/D7/x.stream/playlist.m3u8'), null)
  assert.equal(caltransPageUrl(7, ''), 'https://cwwp2.dot.ca.gov/vm/streamlist.htm')
})

test('memory: Los Angeles pulls Caltrans only; live cameras are flagged; detail exposes the official stream URL, never a proxy', async () => {
  _resetCameraMemoryStore()
  const calls = []
  const deps = {
    store: 'memory', env: {}, now: NOW,
    fetchImpl: async (url) => {
      calls.push(url)
      const m = /\/data\/d(\d+)\/cctv\/cctvStatusD\d+\.json$/.exec(url)
      if (m) return jsonRes(fx(`ca_caltrans_d${m[1]}/cctv_status_d${m[1].padStart(2, '0')}.json`))
      throw new Error(`unexpected fetch ${url}`)
    },
  }
  const v = await getCamerasInView({ bbox: '-118.6,33.7,-117.9,34.3', zoom: 11 }, deps)
  assert.ok(v.cameras.length > 0)
  assert.ok(v.cameras.every((c) => c.provider === 'Caltrans'))
  assert.ok(calls.every((u) => u.startsWith('https://cwwp2.dot.ca.gov/data/')), 'metadata only — no stream or still is requested by a view')
  const live = v.cameras.find((c) => c.video)
  assert.ok(live, 'a live camera is flagged')
  const d = await getCameraDetail(live.id, deps)
  assert.equal(d.media.stream.type, 'HLS')
  assert.match(d.media.stream.url, /^https:\/\/wzmedia\.dot\.ca\.gov\/D7\/.+\.m3u8$/)
  assert.equal(d.media.still.kind, 'proxy')
  assert.match(d.provider.attribution, /Caltrans/)
  assert.ok(!calls.some((u) => u.includes('wzmedia')), 'no stream is opened server-side')
})
