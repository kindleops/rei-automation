import test from 'node:test'
import assert from 'node:assert/strict'

import { contactWindowState, getMapWorld, getMapWorldZones, resolvePlace, _resetAreaCache, US_ZONES } from '@/lib/domain/map/map-world-service.js'
import { CONTACT_WINDOW_POLICY_VERSION } from '@/lib/domain/campaigns/contact-window-timezone.js'
import { makeClosingDb } from '../helpers/closing-db-mock.mjs'

const WINDOW = { start: '08:00', end: '21:00' }
const area = (kind, key, label, state, lat, lng, n = 100, pad = 0.03) => ({ kind, key, label, state, n, center_lat: lat, center_lng: lng, min_lat: lat - pad, max_lat: lat + pad, min_lng: lng - pad, max_lng: lng + pad })
const AREAS = [
  area('zip', '55411', '55411', 'MN', 44.999, -93.303),
  area('city', 'MN:minneapolis', 'Minneapolis, MN', 'MN', 44.98, -93.27, 5000, 0.12),
  area('market', 'Minneapolis, MN', 'Minneapolis, MN', 'MN', 44.97, -93.29, 9000, 0.5),
  area('state', 'MN', 'MN', 'MN', 45.5, -93.9, 9000, 3),
  area('zip', '79901', '79901', 'TX', 31.759, -106.487),
  area('state', 'TX', 'TX', 'TX', 31.0, -99.0, 9000, 8),
  area('zip', '85004', '85004', 'AZ', 33.451, -112.07),
]
const db = () => makeClosingDb({
  mv_map_search_areas: AREAS,
  system_control: [{ key: 'queue_contact_window_start', value: '08:00' }, { key: 'queue_contact_window_end', value: '21:00' }],
})

test('contact window: open with the canonical close instant; closed with the next opening', () => {
  // 19:42 CDT
  const open = contactWindowState(Date.parse('2026-09-29T00:42:00Z'), 'America/Chicago', WINDOW)
  assert.equal(open.open, true)
  assert.equal(open.closes_at, '2026-09-29T02:00:00.000Z')
  assert.equal(open.policy_version, CONTACT_WINDOW_POLICY_VERSION)
  // 22:14 CDT → next open 08:00 CDT tomorrow
  const after = contactWindowState(Date.parse('2026-09-29T03:14:00Z'), 'America/Chicago', WINDOW)
  assert.equal(after.open, false)
  assert.equal(after.reason, 'after_window')
  assert.equal(after.next_open_at, '2026-09-29T13:00:00.000Z')
  // 06:00 CDT → opens today
  const before = contactWindowState(Date.parse('2026-09-29T11:00:00Z'), 'America/Chicago', WINDOW)
  assert.equal(before.reason, 'before_window')
  assert.equal(before.next_open_at, '2026-09-29T13:00:00.000Z')
})

test('contact window: Arizona does not observe DST; the day DST ends still closes at local 21:00', () => {
  // 21:14 MST (UTC-7) — Denver is 22:14 MDT at the same instant
  const az = contactWindowState(Date.parse('2026-09-29T04:14:00Z'), 'America/Phoenix', WINDOW)
  assert.equal(az.open, false)
  assert.equal(az.next_open_at, '2026-09-29T15:00:00.000Z')
  // Chicago on 2026-11-01 (CDT → CST at 02:00): 21:00 CST = 03:00Z next day
  const dst = contactWindowState(Date.parse('2026-11-01T20:00:00Z'), 'America/Chicago', WINDOW)
  assert.equal(dst.open, true)
  assert.equal(dst.closes_at, '2026-11-02T03:00:00.000Z')
})

test('contact window: no zone or no operator window → unknown, never a guess', () => {
  assert.equal(contactWindowState(Date.now(), null, WINDOW), null)
  assert.equal(contactWindowState(Date.now(), 'America/Chicago', null), null)
})

test('place: nearest real property ZIP drives the canonical timezone (split states by ZIP)', () => {
  const mpls = resolvePlace(AREAS, 45.0, -93.3)
  assert.equal(mpls.zip, '55411')
  assert.equal(mpls.state, 'MN')
  assert.equal(mpls.city, 'Minneapolis')
  assert.equal(mpls.market, 'Minneapolis, MN')
  assert.equal(mpls.basis, 'nearest_property_zip')
  const far = resolvePlace(AREAS, 40.0, -100.0)
  assert.equal(far.zip, null)
  assert.equal(far.basis, 'outside_leadcommand_geography')
})

test('world: Minneapolis → America/Chicago + window; El Paso → Mountain; nowhere → honest unknown', async () => {
  _resetAreaCache()
  const d = db()
  const at = Date.parse('2026-09-29T00:42:00Z')
  const mpls = await getMapWorld({ lat: 45.0, lng: -93.3, now: at }, { supabase: d })
  assert.equal(mpls.timezone.iana, 'America/Chicago')
  assert.equal(mpls.timezone.abbr, 'CT')
  assert.equal(mpls.contact_window.open, true)
  assert.equal(mpls.contact_window.window, '08:00–21:00')

  const elPaso = await getMapWorld({ lat: 31.76, lng: -106.49, now: at }, { supabase: d })
  assert.equal(elPaso.timezone.iana, 'America/Denver', 'TX ZIP 799xx is Mountain by the canonical split-state rule')

  const ocean = await getMapWorld({ lat: 30.0, lng: -60.0, now: at }, { supabase: d })
  assert.equal(ocean.timezone.iana, null)
  assert.equal(ocean.contact_window, null)

  // Texas with no nearby property ZIP is a split state: fail closed, no guessed zone.
  const texasNoZip = await getMapWorld({ lat: 33.5, lng: -100.5, now: at }, { supabase: d })
  assert.equal(texasNoZip.place.state, 'TX')
  assert.equal(texasNoZip.timezone.iana, null)
  assert.equal(texasNoZip.timezone.reason, 'timezone_ambiguous_for_geography')

  assert.equal((await getMapWorld({ lat: 'x', lng: 1 }, { supabase: d })).error, 'lat_lng_required')
})

test('zones: every US zone has a clock + window state; markets carry their canonical zone', async () => {
  _resetAreaCache()
  const r = await getMapWorldZones({ now: Date.parse('2026-09-29T04:14:00Z') }, { supabase: db() })
  assert.equal(r.zones.length, US_ZONES.length)
  const denver = r.zones.find((z) => z.iana === 'America/Denver')
  const phoenix = r.zones.find((z) => z.iana === 'America/Phoenix')
  assert.equal(denver.contact_window.open, false) // 22:14 MDT
  assert.equal(phoenix.contact_window.open, false) // 21:14 MST
  assert.notEqual(denver.contact_window.next_open_at, phoenix.contact_window.next_open_at, 'DST offset differs')
  const m = r.markets.find((x) => x.market === 'Minneapolis, MN')
  assert.equal(m.iana, 'America/Chicago')
  assert.equal(m.abbr, 'CT')
  assert.ok(m.contact_window)
})

test('areas load past the PostgREST 1000-row page (the tail of the country is not dropped)', async () => {
  _resetAreaCache()
  const many = Array.from({ length: 2400 }, (_, i) => area('zip', String(10000 + i), String(10000 + i), 'NY', 40 + (i % 50) * 0.01, -74 - Math.floor(i / 50) * 0.01))
  // the ZIP that matters sorts LAST
  const d = makeClosingDb({ mv_map_search_areas: [...many, area('zip', '99999', '99999', 'MN', 44.999, -93.303)], system_control: [] })
  const r = await getMapWorld({ lat: 45.0, lng: -93.3, now: Date.parse('2026-09-29T15:00:00Z') }, { supabase: d })
  assert.equal(r.place.zip, '99999')
  assert.equal(r.timezone.iana, 'America/Chicago')
})
