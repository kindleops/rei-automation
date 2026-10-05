/**
 * Map context layers: crime (city open data), investor presence (two separate
 * components) and the ACS census read model. No network, no database: every
 * fetch / query / client is injected.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { chicagoFamily, cityDay, familyFromCrimeAgainst } from '@/lib/domain/map/crime/crime-sources.js'
import { CRIME_SOURCES, _resetCrimeCache, getCrimeInView, parseCrimeRequest, snapBox } from '@/lib/domain/map/crime/crime-service.js'
import { _resetPresenceCache, getInvestorPresence, presenceGrid, shapeCells } from '@/lib/domain/map/investor-presence-service.js'
import { _resetCensusCache, getCensusCells, shapeCensusCell } from '@/lib/domain/map/census-cells-service.js'

const NOW = Date.parse('2026-10-03T20:00:00Z')
const src = (id) => CRIME_SOURCES.find((s) => s.source_id === id)
const json = (body) => ({ ok: true, status: 200, url: '', headers: { get: () => null }, text: async () => JSON.stringify(body) })

/* ── crime: normalizers on real record shapes ─────────────────────────── */

test('Minneapolis ArcGIS feature → category, offense, NIBRS family, city day; nothing else', () => {
  const n = src('mn_minneapolis_mpd').normalize({
    attributes: { OBJECTID: 381427, Offense_Category: 'Shots Fired Calls', Offense: 'Sound of Shots Fired (P)', Occurred_Date: 1790983348000, NIBRS_Crime_Against: 'Non NIBRS Data', Address: '0005XX CHICAGO AVE', Case_Number: 'MP-2026-1' },
    geometry: { x: -93.26030178380324, y: 44.97356388804399 },
  })
  assert.deepEqual(Object.keys(n).sort(), ['category', 'family', 'key', 'lat', 'lng', 'occurred_at', 'occurred_on', 'offense'])
  assert.equal(n.occurred_at, '2026-10-02T18:22', 'the city clock (CDT), not UTC 23:22')
  assert.equal(n.category, 'Shots Fired Calls')
  assert.equal(n.family, 'other')
  assert.equal(n.occurred_on, '2026-10-02')
  assert.ok(!JSON.stringify(n).includes('CHICAGO AVE') && !JSON.stringify(n).includes('MP-2026'))
})

test('Dallas Socrata row → title-cased NIBRS category, address-level point rounded to ~100 m, no names', () => {
  const n = src('tx_dallas_dpd').normalize({
    incidentnum: '145423-2026', date1: '2026-10-03 00:00:00.0000000', nibrs_crime_category: 'PUBLIC INTOXICATION', nibrs_crime: 'PUBLIC INTOXICATION', nibrs_crimeagainst: 'SOCIETY',
    geocoded_column: { latitude: '32.78632', longitude: '-96.78736', human_address: '{"address": "2625 FLOYD ST"}' }, ro1name: 'OFFICER,NAME',
  })
  assert.equal(n.category, 'Public Intoxication')
  assert.equal(n.family, 'society')
  assert.equal(n.occurred_on, '2026-10-03')
  assert.equal(n.lat, 32.786)
  assert.equal(n.lng, -96.787)
  assert.ok(!JSON.stringify(n).includes('FLOYD') && !JSON.stringify(n).includes('OFFICER'))
})

test('Chicago Socrata row → IUCR primary type with its family; families are labels, not scores', () => {
  const n = src('il_chicago_cpd').normalize({ id: '14339976', date: '2026-09-26T00:00:00.000', primary_type: 'BURGLARY', description: 'FORCIBLE ENTRY', block: '015XX N LEAVITT ST', latitude: '41.909573692', longitude: '-87.68232531' })
  assert.equal(n.category, 'Burglary')
  assert.equal(n.family, 'property')
  assert.equal(n.occurred_on, '2026-09-26')
  assert.equal(chicagoFamily('BATTERY'), 'person')
  assert.equal(chicagoFamily('SOMETHING NEW'), 'other')
  assert.equal(familyFromCrimeAgainst('PERSON'), 'person')
  assert.equal(cityDay(null, 'America/Chicago'), null)
  assert.equal(src('il_chicago_cpd').normalize({ id: '1', primary_type: 'THEFT' }), null, 'no location → not drawn')
})

test('every crime query targets only its own host and carries the window + box', () => {
  const box = { west: -93.3, south: 44.94, east: -93.24, north: 44.99 }
  assert.ok(CRIME_SOURCES.length >= 27, 'the 2026-10-05 expansion is connected')
  for (const s of CRIME_SOURCES) {
    const q = { box, sinceMs: NOW - 30 * 86_400_000, limit: 2000 }
    const urls = typeof s.urls === 'function' ? s.urls(q).map((x) => x.url) : [s.url(q)]
    for (const raw of urls) {
      const u = new URL(raw)
      assert.ok(s.metadata_hosts.includes(u.hostname), s.source_id)
      assert.equal(u.protocol, 'https:', s.source_id)
      assert.ok(/2026-09-03/.test(decodeURIComponent(u.search)), `${s.source_id} window`)
      // 'all' drops only the date bound — the box and the row cap stay
      const all = decodeURIComponent(new URL(typeof s.urls === 'function' ? s.urls({ ...q, sinceMs: null })[0].url : s.url({ ...q, sinceMs: null })).search)
      assert.ok(!/2026-09-03/.test(all), `${s.source_id} all-window has no date bound`)
      assert.ok(/-93\.3|93\.30000|-93\.30000/.test(all), `${s.source_id} all-window keeps the box`)
    }
  }
})

/* ── crime: the service ───────────────────────────────────────────────── */

const MPLS_BOX = '-93.30,44.94,-93.24,44.99'
const mplsBody = { features: [
  { attributes: { OBJECTID: 1, Offense_Category: 'Theft', Offense: 'Theft From Motor Vehicle', Occurred_Date: NOW - 86_400_000, NIBRS_Crime_Against: 'Property' }, geometry: { x: -93.27, y: 44.96 } },
  { attributes: { OBJECTID: 2, Offense_Category: 'Assault', Offense: 'Aggravated Assault', Occurred_Date: NOW - 2 * 86_400_000, NIBRS_Crime_Against: 'Person' }, geometry: { x: -93.26, y: 44.97 } },
  { attributes: { OBJECTID: 2, Offense_Category: 'Assault', Offense: 'Aggravated Assault', Occurred_Date: NOW - 2 * 86_400_000, NIBRS_Crime_Against: 'Person' }, geometry: { x: -93.26, y: 44.97 } },
  { attributes: { OBJECTID: 3, Offense_Category: 'Theft', Offense: 'Shoplifting', Occurred_Date: NOW - 3 * 86_400_000, NIBRS_Crime_Against: 'Property' }, geometry: { x: -93.25, y: 44.98 } },
] }

test('crime in a covered city: incidents, category counts, source + newest day — and no score anywhere', async () => {
  _resetCrimeCache()
  const calls = []
  const fetchImpl = async (u) => { calls.push(u); return json(mplsBody) }
  const r = await getCrimeInView({ bbox: MPLS_BOX, zoom: 13, days: 30 }, { now: NOW, fetchImpl })
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'incidents')
  assert.equal(r.covered, true)
  assert.equal(r.incidents.length, 3, 'duplicate records collapse')
  assert.equal(r.categories.reduce((a, c) => a + c.count, 0), 3)
  assert.deepEqual(r.counts.cats, { violent: 1, property: 2, drugs: 0, other: 0 })
  assert.equal(r.counts.types.vehicle, 1, '"Theft From Motor Vehicle" is a vehicle break-in')
  assert.equal(r.counts.types.theft, 1)
  assert.equal(r.counts.types.assault, 1)
  assert.equal(r.per_source[0].city, 'Minneapolis')
  assert.equal(r.per_source[0].latest_on, '2026-10-02')
  assert.equal(r.scoring, 'none')
  assert.ok(!/score|safe|unsafe|index/i.test(JSON.stringify(r).replace('"scoring":"none"', '')))
  assert.ok(r.incidents.every((i) => /^[0-9a-f]{14}$/.test(i.id)), 'opaque ids, never case numbers')
  // cached: the same pan does not re-query the city
  await getCrimeInView({ bbox: MPLS_BOX, zoom: 13.4, days: 30 }, { now: NOW + 1000, fetchImpl })
  assert.equal(calls.length, 1)
})

test('crime outside every connected city is "not covered" (never zero); zoomed out asks to zoom in', async () => {
  _resetCrimeCache()
  const fetchImpl = async () => { throw new Error('should not fetch') }
  const sat = await getCrimeInView({ bbox: '-98.55,29.38,-98.45,29.48', zoom: 13 }, { now: NOW, fetchImpl })
  assert.equal(sat.covered, false)
  assert.equal(sat.mode, 'not_covered')
  assert.deepEqual(sat.not_covered.map((c) => c.city), ['San Antonio'], 'the city in view, with why')
  assert.match(sat.not_covered[0].reason, /no coordinates/)
  const nowhere = await getCrimeInView({ bbox: '-100.5,40.5,-100.4,40.6', zoom: 13 }, { now: NOW, fetchImpl })
  assert.equal(nowhere.mode, 'not_covered')
  assert.ok(nowhere.not_covered.some((c) => c.city === 'Houston'), 'nothing in view: the full checked list')
  const wide = await getCrimeInView({ bbox: '-93.6,44.7,-92.9,45.2', zoom: 9 }, { now: NOW, fetchImpl })
  assert.equal(wide.mode, 'zoom_in')
  assert.equal(wide.covered, true)
})

test('a city feed that fails is reported unavailable — not an empty, "safe" map', async () => {
  _resetCrimeCache()
  const r = await getCrimeInView({ bbox: MPLS_BOX, zoom: 13 }, { now: NOW, fetchImpl: async () => { throw new Error('down https://services.arcgis.com/x') } })
  assert.equal(r.ok, true)
  assert.equal(r.incidents.length, 0)
  assert.equal(r.unavailable[0].city, 'Minneapolis')
  assert.ok(!JSON.stringify(r).includes('services.arcgis.com/x'))
})

test('crime request parsing + snapping', () => {
  assert.equal(parseCrimeRequest({ bbox: 'x' }).ok, false)
  assert.equal(parseCrimeRequest({ bbox: '1,1,0,0' }).ok, false)
  assert.equal(parseCrimeRequest({ bbox: '0,0,1,1', days: 45 }).days, 30)
  assert.deepEqual(snapBox({ west: -93.27, south: 44.94, east: -93.24, north: 44.99 }), { west: -93.3, south: 44.9, east: -93.2, north: 45 })
})

/* ── investor presence ────────────────────────────────────────────────── */

test('investor presence: purchases and entity ownership come back as two separate counts per cell', async () => {
  _resetPresenceCache()
  const seen = []
  const query = async (sql, params) => {
    seen.push({ sql, params })
    return { rows: [
      { lat: 44.95, lng: -93.25, sales: 40, investor_purchases: 6, entity_owned: 3, latest_sale_on: '2026-08-19' },
      { lat: 44.96, lng: -93.26, sales: 12, investor_purchases: 0, entity_owned: 0, latest_sale_on: '2026-07-01' },
      { lat: 44.97, lng: -93.27, sales: 5, investor_purchases: 0, entity_owned: 4, latest_sale_on: '2026-06-01' },
    ] }
  }
  const r = await getInvestorPresence({ bbox: '-93.30,44.94,-93.24,44.99', zoom: 12, months: 24 }, { now: NOW, query })
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'cells')
  assert.equal(r.cells.length, 2, 'a cell with neither signal is not drawn')
  assert.deepEqual(r.totals, { sales_in_window: 45, investor_purchases: 6, entity_owned: 7 })
  assert.equal(r.latest_sale_on, '2026-08-19')
  assert.equal(r.scoring, 'none')
  assert.ok(r.cells.every((c) => !('score' in c) && !('composite' in c)), 'no blended number')
  assert.match(seen[0].sql, /mv_map_market_sales/)
  assert.match(seen[0].sql, /is_investor/)
  assert.match(seen[0].sql, /investor_inferred_current_owner/)
  assert.equal(seen[0].params[5], '2024-10-03', '24-month window')
  assert.equal(seen[0].params[4], presenceGrid(12))
})

test('investor presence: zoomed out asks to zoom in; a failed read is unavailable, never zero', async () => {
  _resetPresenceCache()
  const wide = await getInvestorPresence({ bbox: '-98,40,-90,46', zoom: 6 }, { now: NOW, query: async () => { throw new Error('no') } })
  assert.equal(wide.mode, 'zoom_in')
  const bad = await getInvestorPresence({ bbox: '-93.30,44.94,-93.24,44.99', zoom: 12 }, { now: NOW, query: async () => { throw new Error('timeout') } })
  assert.equal(bad.mode, 'unavailable')
  assert.deepEqual(bad.cells, [])
  assert.equal(shapeCells([{ lat: 'x', lng: 1, investor_purchases: 3 }]).cells.length, 0)
})

/* ── census read model ────────────────────────────────────────────────── */

function fakeCensusDb(rows) {
  const calls = []
  const builder = (table) => {
    const filters = []
    const q = {
      select: () => q,
      eq: (k, v) => { filters.push(['eq', k, v]); return q },
      gte: (k, v) => { filters.push(['gte', k, v]); return q },
      lte: (k, v) => { filters.push(['lte', k, v]); return q },
      limit: async (n) => {
        calls.push({ table, filters, n })
        const data = rows.filter((r) => filters.every(([op, k, v]) => (op === 'eq' ? r[k] === v : op === 'gte' ? Number(r[k]) >= v : Number(r[k]) <= v))).slice(0, n)
        return { data, error: null }
      },
    }
    return q
  }
  return { calls, from: builder }
}
const CELL = { geo_id: 'zip5:55411', geo_level: 'zip5', geo_name: '55411', census_geoid: '55411', state_code: 'MN', centroid_lat: '44.999', centroid_lng: '-93.303', dataset: 'acs/acs5', vintage: 2024, population: '28000', median_household_income: '52000', median_household_income_moe: '4100', vacancy_rate: '0.071', renter_share: '0.48' }

test('census: a ZIP reads exchange_market_fundamentals_cells (never census_geo_metrics), with MOE and no grade', async () => {
  _resetCensusCache()
  const db = fakeCensusDb([CELL])
  const r = await getCensusCells({ zip: '55411' }, { supabase: db, now: NOW })
  assert.equal(r.ok, true)
  assert.equal(r.cell.median_household_income, 52000)
  assert.equal(r.cell.median_household_income_moe, 4100)
  assert.equal(r.cell.level, 'zip')
  assert.equal(r.cell.source.vintage, 2024)
  assert.equal(db.calls[0].table, 'exchange_market_fundamentals_cells')
  assert.ok(!('investor_opportunity_score' in r.cell) && !('grade' in r.cell))
  const miss = await getCensusCells({ zip: '99999' }, { supabase: db, now: NOW })
  assert.equal(miss.covered, false)
  assert.equal(miss.cell, null)
})

test('census: nearest ZCTA to a point; viewport cells by level; bad input refused', async () => {
  _resetCensusCache()
  const db = fakeCensusDb([CELL, { ...CELL, geo_id: 'zip5:55412', census_geoid: '55412', centroid_lat: '45.03', centroid_lng: '-93.30' }])
  const p = await getCensusCells({ lat: 45.0, lng: -93.30 }, { supabase: db, now: NOW })
  assert.equal(p.cell.census_geoid, '55411')
  const v = await getCensusCells({ bbox: '-93.4,44.9,-93.2,45.1', level: 'zip' }, { supabase: db, now: NOW })
  assert.equal(v.cells.length, 2)
  assert.equal((await getCensusCells({ zip: '5541' }, { supabase: db, now: NOW })).ok, false)
  assert.equal((await getCensusCells({}, { supabase: db, now: NOW })).ok, false)
  assert.equal(shapeCensusCell(null), null)
})
