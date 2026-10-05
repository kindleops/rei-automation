/**
 * Map overlays expansion (2026-10-05): camera provider classification and
 * gating, live-video allowlist, new adapters on real record shapes, crime
 * taxonomy, time windows, category filters, bbox/zoom bounds and caching.
 * No network, no database: every fetch is injected.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { CAMERA_ACCESS_PENDING, CAMERA_PROVIDERS, LIVE_VIDEO_PROVIDERS, effectiveProvider, validateProvider, videoAllowed } from '@/lib/domain/map/cameras/camera-provider-registry.js'
import { CAMERA_ADAPTERS } from '@/lib/domain/map/cameras/camera-adapters.js'
import { getCameraDetail, getCamerasInView, pendingInView } from '@/lib/domain/map/cameras/camera-network-service.js'
import { _resetCameraMemoryStore } from '@/lib/domain/map/cameras/camera-memory-store.js'
import { idotGatewayAdapter, mdotChartAdapter, modotTravelerAdapter, parseWsdotKml, wsdotKmlAdapter } from '@/lib/domain/map/cameras/adapters/state-public-feeds.js'
import { ibi511Adapter } from '@/lib/domain/map/cameras/adapters/keyed-511.js'
import { CRIME_CATS, classifyCrime, parseCats } from '@/lib/domain/map/crime/crime-taxonomy.js'
import { CITY_CRIME_SOURCES, lapdWords } from '@/lib/domain/map/crime/crime-sources-cities.js'
import { CRIME_SOURCES, _resetCrimeCache, crimeCounts, getCrimeInView, parseCrimeRequest } from '@/lib/domain/map/crime/crime-service.js'

const NOW = Date.parse('2026-10-05T18:00:00Z')
const json = (body) => ({ ok: true, status: 200, url: '', headers: { get: () => null }, text: async () => JSON.stringify(body) })
const text = (body) => ({ ok: true, status: 200, url: '', headers: { get: () => null }, text: async () => body })
const byId = (id) => CAMERA_PROVIDERS.find((p) => p.provider_id === id)

/* ── camera provider classification + gating ──────────────────────────── */

test('every registered camera provider is valid and has an adapter', () => {
  for (const p of CAMERA_PROVIDERS) {
    assert.deepEqual(validateProvider(p), [], p.provider_id)
    assert.ok(CAMERA_ADAPTERS[p.adapter_type], `${p.provider_id} adapter`)
  }
})

test('classification gates the map: GO draws, NEEDS-KEY stays off without a key, NEEDS-PERMISSION stays off', () => {
  const env = {}
  for (const id of ['il_idot_gateway', 'wa_wsdot', 'md_mdot_chart', 'mo_modot_traveler']) {
    assert.equal(byId(id).access, 'public', id)
    assert.equal(effectiveProvider(byId(id), env).enabled, true, `${id} GO is on`)
  }
  for (const id of ['fl_fl511', 'ga_511ga', 'nc_drivenc', 'az_az511', 'oh_ohgo']) {
    const p = effectiveProvider(byId(id), env)
    assert.equal(byId(id).access, 'needs_key', id)
    assert.equal(p.enabled, false, `${id} without a key is off`)
    assert.equal(p.disabled_reason, 'api_key_not_configured')
    assert.match(byId(id).signup_url, /^https:\/\//, `${id} names where the owner registers`)
    assert.equal(effectiveProvider(byId(id), { [byId(id).api_key_env]: 'k' }).enabled, true, `${id} turns on once the key exists`)
  }
  const ia = effectiveProvider(byId('ia_iowa_dot'), env)
  assert.equal(ia.enabled, false, 'Iowa is built but held for the agency')
  assert.ok(CAMERA_ACCESS_PENDING.some((x) => x.state === 'TN' && x.access === 'needs_permission'))
  assert.ok(CAMERA_ACCESS_PENDING.some((x) => x.state === 'MI' && x.access === 'not_permitted'))
  // no key value or env name ever leaves the registry in a pending line
  const pending = pendingInView(CAMERA_PROVIDERS.map((p) => effectiveProvider(p, env)), { west: -82.8, south: 27.7, east: -82.2, north: 28.2 })
  assert.deepEqual(pending, [{ provider: 'FL511', state: 'FL', access: 'needs_key' }])
  assert.ok(!JSON.stringify(pending).includes('API_KEY'))
  assert.deepEqual(pendingInView([], { west: -125, south: 24, east: -66, north: 49 }), [], 'a continent lists nothing')
})

test('live video is MnDOT + Caltrans only — a new provider with a stream never plays it', async () => {
  assert.deepEqual([...LIVE_VIDEO_PROVIDERS].sort(), ['ca_caltrans_cwwp2', 'mn_mndot_iris'])
  assert.equal(videoAllowed(byId('mn_mndot_iris')), true)
  assert.equal(videoAllowed(byId('il_idot_gateway')), false)
  // A synthetic provider whose adapter DOES emit an HLS stream: served as a still, no stream.
  _resetCameraMemoryStore()
  const prov = { ...byId('il_idot_gateway'), provider_id: 'zz_streamy', adapter_type: 'zz', image_hosts: ['cam.example.gov'], metadata_hosts: ['feed.example.gov'], bounds: { west: -1, south: -1, east: 1, north: 1 } }
  const adapter = { listRaw: async () => [{}], normalize: () => ({ external_camera_id: 'A1', name: 'A1', latitude: 0.1, longitude: 0.1, status: 'LIVE', feed_type: 'HLS', still_url: 'https://cam.example.gov/a.jpg', stream_url: 'https://cam.example.gov/a/playlist.m3u8' }) }
  const deps = { store: 'memory', registry: [prov], adapters: { zz: adapter }, env: {}, now: NOW, supabase: {} }
  const r = await getCamerasInView({ bbox: '-0.5,-0.5,0.5,0.5', zoom: 12 }, deps)
  assert.equal(r.cameras.length, 1)
  assert.equal(r.cameras[0].video, false)
  const d = await getCameraDetail(r.cameras[0].id, deps)
  assert.equal(d.media.stream, null)
})

test('IDOT Gateway: snapshot file name is the key; stills from cctv.travelmidwest.com only', () => {
  const n = idotGatewayAdapter.normalize({ attributes: { OBJECTID: 1, CameraLocation: 'Hillside Tower Camera 9', CameraDirection: 'NONE', SnapShot: 'https://cctv.travelmidwest.com/snapshots/IL-IDOTD1_1_Cook_WB_Albin_4188597_-8791483_2_NONE.jpg', ImgPath: 'https://travelmidwest.com/showCamera?id=IL-IDOTD1-IK14B&direction=NONE', TooOld: 'false' }, geometry: { x: -87.91483, y: 41.88597 } })
  assert.equal(n.external_camera_id, 'IL-IDOTD1_1_Cook_WB_Albin_4188597_-8791483_2_NONE')
  assert.equal(n.feed_type, 'REFRESHING_STILL')
  assert.equal(n.direction, null)
  assert.equal(n.stream_url, undefined)
  const bad = idotGatewayAdapter.normalize({ attributes: { SnapShot: 'http://elsewhere.com/x.jpg' }, geometry: { x: -87, y: 41 } })
  assert.equal(bad, null, 'no trusted snapshot → no key → not drawn')
})

test('WSDOT KML: placemarks parse to id, name, still and point', async () => {
  const kml = '<kml><Document><Folder><Placemark id="ID 4010"><name><![CDATA[2nd / Monroe (Spokane)]]></name><description><![CDATA[<div><img src="https://images.wsdot.wa.gov/spokane/cos_2nd_monroe.jpg"></div>]]></description><Point><coordinates>-117.42651,47.65449</coordinates></Point></Placemark></Folder></Document></kml>'
  const rows = parseWsdotKml(kml)
  assert.deepEqual(rows, [{ id: '4010', name: '2nd / Monroe (Spokane)', img: 'https://images.wsdot.wa.gov/spokane/cos_2nd_monroe.jpg', lng: -117.42651, lat: 47.65449 }])
  const n = wsdotKmlAdapter.normalize(rows[0])
  assert.equal(n.still_url, 'https://images.wsdot.wa.gov/spokane/cos_2nd_monroe.jpg')
  const got = await wsdotKmlAdapter.listRaw({ fetch: { text: async () => kml } })
  assert.equal(got.length, 1)
})

test('CHART + MoDOT publish video only → positions + the agency page, never a still or a stream', () => {
  const md = mdotChartAdapter.normalize({ id: '7a00a1dc', name: 'I-270 & Old Hundred Rd (MD 109)', lat: 39.2773, lon: -77.3236, opStatus: 'OK', commMode: 'ONLINE', publicVideoURL: 'https://chart.maryland.gov/Video/GetVideo/7a00a1dc', routePrefix: 'IS', routeNumber: 270, milePost: 22.29, cctvIp: 'strmr5.sha.maryland.gov' })
  assert.equal(md.feed_type, 'PROVIDER_PAGE_ONLY')
  assert.equal(md.still_url, null)
  assert.equal(md.provider_page_url, 'https://chart.maryland.gov/Video/GetVideo/7a00a1dc')
  assert.ok(!JSON.stringify(md).includes('strmr5'), 'the stream host is never carried')
  const mo = modotTravelerAdapter.normalize({ location: '141 AT 21, MM 27.1', x: -90.424496, y: 38.4623, rtmp: null, html: 'https://sfs02-traveler.modot.mo.gov/rtplive/MODOT_CAM_209/playlist.m3u8' })
  assert.equal(mo.external_camera_id, 'MODOT_CAM_209')
  assert.equal(mo.feed_type, 'PROVIDER_PAGE_ONLY')
  assert.equal(mo.stream_url, undefined)
})

test('IBI 511 (keyed): refuses to run without a key; one camera per view; stills only from the site itself', async () => {
  await assert.rejects(() => ibi511Adapter.listRaw({ fetch: { json: async () => [] }, provider: byId('fl_fl511'), apiKey: null }), /api_key_not_configured/)
  const seen = []
  const raw = await ibi511Adapter.listRaw({ fetch: { json: async (u) => { seen.push(u); return [{ Id: 9, Name: 'I-4 at Ivanhoe', Roadway: 'I-4', Direction: 'Eastbound', Latitude: 28.56, Longitude: -81.37, Views: [{ Id: 1, Url: 'https://fl511.com/map/Cctv/9', Status: 'Enabled' }, { Id: 2, Url: 'https://evil.example/x.jpg', Status: 'Enabled' }] }] } }, provider: byId('fl_fl511'), apiKey: 'K' })
  assert.match(seen[0], /^https:\/\/fl511\.com\/api\/v2\/get\/cameras\?key=K&format=json$/)
  assert.equal(raw.length, 2)
  const a = ibi511Adapter.normalize(raw[0], { provider: byId('fl_fl511') })
  const b = ibi511Adapter.normalize(raw[1], { provider: byId('fl_fl511') })
  assert.equal(a.external_camera_id, '9-1')
  assert.equal(a.still_url, 'https://fl511.com/map/Cctv/9')
  assert.equal(b.still_url, null, 'an off-site image URL is never trusted')
})

/* ── crime taxonomy ───────────────────────────────────────────────────── */

test('crime taxonomy: the city\'s words → one glyph type + one filter category; specific before general', () => {
  const t = (category, offense = null, family = 'other') => classifyCrime({ category, offense, family })
  assert.deepEqual(t('Theft', 'Theft From Motor Vehicle'), { type: 'vehicle', cat: 'property' })
  assert.deepEqual(t('Burglary Of Motor Vehicle'), { type: 'vehicle', cat: 'property' })
  assert.deepEqual(t('Grand Theft Auto'), { type: 'vehicle', cat: 'property' })
  assert.deepEqual(t('Robbery', 'Carjacking'), { type: 'robbery', cat: 'violent' })
  assert.deepEqual(t('Aggravated Assault'), { type: 'assault', cat: 'violent' })
  assert.deepEqual(t('Burglary/Breaking & Entering'), { type: 'burglary', cat: 'property' })
  assert.deepEqual(t('Shoplifting'), { type: 'theft', cat: 'property' })
  assert.deepEqual(t('Destruction/Damage/Vandalism Of Property'), { type: 'vandalism', cat: 'property' })
  assert.deepEqual(t('Drug/Narcotic Violations'), { type: 'drugs', cat: 'drugs' })
  assert.deepEqual(t('Weapon Law Violations'), { type: 'weapons', cat: 'other' })
  assert.deepEqual(t('Disturbing The Peace'), { type: 'other', cat: 'other' })
  assert.deepEqual(t('Criminal Trespass', null, 'property'), { type: 'other', cat: 'property' }, 'unmatched words fall back to the city\'s own family')
  assert.deepEqual(t('Something New', null, 'person'), { type: 'assault', cat: 'violent' })
  assert.equal(lapdWords('459 - PC - F - BFMV- Burglary From Motor Vehicle  - 23F'), 'Burglary From Motor Vehicle')
  assert.equal(parseCats('violent,drugs,bogus').size, 2)
  assert.equal(parseCats(CRIME_CATS.join(',')), null, 'all four = no filter')
  assert.equal(parseCats(''), null)
})

/* ── crime windows, filters, bounds ───────────────────────────────────── */

test('crime windows: 7 / 14 / 30 / all; anything else is 30', () => {
  const p = (days) => parseCrimeRequest({ bbox: '0,0,1,1', days }).days
  assert.equal(p('7'), 7)
  assert.equal(p('14'), 14)
  assert.equal(p('30'), 30)
  assert.equal(p('all'), 'all')
  assert.equal(p('ALL'), 'all')
  assert.equal(p('45'), 30)
})

const MPLS = '-93.30,44.94,-93.24,44.99'
const D = 86_400_000
const feat = (id, cat, off, against, ago, x, y) => ({ attributes: { OBJECTID: id, Offense_Category: cat, Offense: off, Occurred_Date: NOW - ago * D, NIBRS_Crime_Against: against }, geometry: { x, y } })
const body = { features: [
  feat(1, 'Theft', 'Theft From Motor Vehicle', 'Property', 1, -93.27, 44.96),
  feat(2, 'Assault', 'Aggravated Assault', 'Person', 2, -93.26, 44.97),
  feat(3, 'Narcotics', 'Drug Possession', 'Society', 3, -93.25, 44.98),
  feat(4, 'Theft', 'Shoplifting', 'Property', 4, -93.255, 44.975),
  feat(5, 'Theft', 'Future typo', 'Property', -400, -93.256, 44.976),
] }

test('category filter is server-side on the cached read: one city query, counts stay for every category', async () => {
  _resetCrimeCache()
  const calls = []
  const fetchImpl = async (u) => { calls.push(u); return json(body) }
  const all = await getCrimeInView({ bbox: MPLS, zoom: 13, days: '14' }, { now: NOW, fetchImpl })
  assert.equal(all.window_days, 14)
  assert.equal(all.incidents.length, 4, 'a future-dated record is a data error, never drawn')
  const v = await getCrimeInView({ bbox: MPLS, zoom: 13, days: '14', cats: 'violent' }, { now: NOW, fetchImpl })
  assert.equal(calls.length, 1, 'a category toggle never re-reads the city')
  assert.deepEqual(v.cats_filter, ['violent'])
  assert.deepEqual(v.incidents.map((i) => i.type), ['assault'])
  assert.deepEqual(v.counts.cats, { violent: 1, property: 2, drugs: 1, other: 0 }, 'counts are before the filter')
  assert.equal(v.in_view, 4)
  for (const i of v.incidents) assert.deepEqual(Object.keys(i).sort(), ['cat', 'category', 'family', 'id', 'lat', 'lng', 'occurred_at', 'occurred_on', 'offense', 'source_id', 'type'])
  // a different window is a different read
  await getCrimeInView({ bbox: MPLS, zoom: 13, days: 'all' }, { now: NOW, fetchImpl })
  assert.equal(calls.length, 2)
  assert.ok(!/TIMESTAMP/.test(decodeURIComponent(calls[1])), "'all' sends no date bound")
  assert.match(decodeURIComponent(calls[1]), /resultRecordCount=2000/, "'all' keeps the row cap")
})

test('crime is bounded by zoom and box size before any upstream call', async () => {
  _resetCrimeCache()
  const fetchImpl = async () => { throw new Error('must not fetch') }
  const low = await getCrimeInView({ bbox: MPLS, zoom: 10.9 }, { now: NOW, fetchImpl })
  assert.equal(low.mode, 'zoom_in')
  const big = await getCrimeInView({ bbox: '-93.6,44.7,-92.9,45.2', zoom: 13 }, { now: NOW, fetchImpl })
  assert.equal(big.mode, 'zoom_in', 'a box over 0.6° is refused even at street zoom')
})

test('the viewport, not the snapped cache box, bounds what is drawn and counted', async () => {
  _resetCrimeCache()
  const fetchImpl = async () => json(body)
  const r = await getCrimeInView({ bbox: '-93.274,44.955,-93.265,44.965', zoom: 15 }, { now: NOW, fetchImpl })
  assert.equal(r.incidents.length, 1)
  assert.equal(crimeCounts(r.incidents).cats.property, 1)
})

test('a city split across layers (Houston) is a bounded few queries, each tagged with its NIBRS group', async () => {
  _resetCrimeCache()
  const hou = CITY_CRIME_SOURCES.find((s) => s.source_id === 'tx_houston_hpd')
  const calls = []
  const fetchImpl = async (u) => {
    calls.push(u)
    const layer = /FeatureServer\/(\d)\//.exec(u)[1]
    return json({ features: [{ attributes: { OBJECTID: 7, USER_RMSOccurrenceDate: Date.parse('2026-10-04T00:00:00Z'), USER_RMSOccurrenceHour: 20, USER_NIBRSDescription: layer === '0' ? 'Simple Assault' : 'Theft' }, geometry: { x: -95.39, y: 29.77 } }] })
  }
  const r = await getCrimeInView({ bbox: '-95.42,29.75,-95.36,29.80', zoom: 14, days: '7' }, { now: NOW, fetchImpl, sources: [hou] })
  assert.equal(calls.length, 3)
  assert.equal(r.incidents.length, 3, 'the same OBJECTID in two layers is two incidents')
  const a = r.incidents.find((i) => i.type === 'assault')
  assert.equal(a.family, 'person')
  assert.equal(a.occurred_on, '2026-10-04')
  assert.equal(a.occurred_at, '2026-10-04T20:00')
})

test('every new city rounds points to ~100 m and never outputs an address or case number', () => {
  for (const s of CITY_CRIME_SOURCES) {
    assert.ok(s.location_note && s.attribution && s.licence && s.dataset_url, s.source_id)
    assert.ok(s.bounds.west < s.bounds.east && s.bounds.south < s.bounds.north, s.source_id)
  }
  const atl = CITY_CRIME_SOURCES.find((s) => s.source_id === 'ga_atlanta_apd')
  const n = atl.normalize({ attributes: { OBJECTID: 5, OccurredFromDate: NOW - D, Crime_Against: 'Person', NIBRS_Offense: 'Aggravated Assault', Latitude: 33.7551234, Longitude: -84.4291234, StreetAddress: '123 MAIN ST', IncidentNumber: 'A-1' }, geometry: {} })
  assert.equal(n.lat, 33.755)
  assert.equal(n.lng, -84.429)
  assert.ok(!JSON.stringify(n).includes('MAIN ST') && !JSON.stringify(n).includes('A-1'))
  const masked = CITY_CRIME_SOURCES.find((s) => s.source_id === 'wa_seattle_spd').normalize({ offense_id: '1', offense_date: '2026-10-03T22:11:00.000', nibrs_offense_code_description: 'Aggravated Assault', latitude: '-1.0', longitude: '-1.0' })
  assert.equal(masked, null, 'a masked (-1, -1) record is not drawn')
  assert.ok(CRIME_SOURCES.length >= 27)
})
