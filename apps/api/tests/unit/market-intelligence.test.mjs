import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { miAssetOf, isPricePerUnitEvidence, ASSET_CODE, isGenericMultiLabel } from '../../src/lib/domain/market-intelligence/mi-asset-classes.js'
import { deriveCoverage, growthWindows, completeMonthsIn, dayOfDate, monthOfDay, periodWindow } from '../../src/lib/domain/market-intelligence/mi-periods.js'
import { createSalesIndexBuilder, F, medianOf } from '../../src/lib/domain/market-intelligence/mi-sales-index.js'
import { percentileDisc } from '../../src/lib/domain/market-intelligence/mi-agg.js'
import { createAssetClassifier, MI_ASSETS } from '../../src/lib/domain/market-intelligence/mi-asset-classes.js'
import { dateOfDay, firstDayOfMonth } from '../../src/lib/domain/market-intelligence/mi-periods.js'
import { buildGeographyCatalog, factsFromIndex, searchGeographies, parseGeoId } from '../../src/lib/domain/market-intelligence/mi-geography.js'
import { METRICS, METRIC_BY_ID, UNSUPPORTED } from '../../src/lib/domain/market-intelligence/mi-metric-registry.js'
import { rankRows, passesFilters } from '../../src/lib/domain/market-intelligence/mi-metric-values.js'
import { loadAllowed, missingSummaryColumns, SUMMARY_COLUMNS } from '../../src/lib/domain/market-intelligence/mi-loader.js'
import { shapeUniverse, summarizeUniverse } from '../../src/lib/domain/market-intelligence/mi-universe.js'
import { createMarketIntelService, devRawAllowed, SUMMARY_MISSING_MESSAGE } from '../../src/lib/domain/market-intelligence/mi-service.js'

// ── fixtures ───────────────────────────────────────────────────────────────
const Q = F.QUALIFIED | F.PRICED
const GEO = {
  '75217': { state: 'TX', city: 'dallas', lat: 32.71, lng: -96.68 },
  '75227': { state: 'TX', city: 'dallas', lat: 32.77, lng: -96.68 },
  '77002': { state: 'TX', city: 'houston', lat: 29.75, lng: -95.36 },
  '55411': { state: 'MN', city: 'minneapolis', lat: 45.0, lng: -93.3 },
}
/** One extract row in EXTRACT_COLUMNS order. */
function sale({ date = '2026-05-15', price = 200000, ppsf = 150, units = 1, sqft = 1300, type = 'Single Family', zip = '75217', flags = Q, buyer = null, cls = 'unknown' } = {}) {
  const g = GEO[zip]
  return [dayOfDate(date), price, ppsf, units, sqft, type, g.state, zip, g.city, g.lat, g.lng, flags, buyer, cls]
}
function months(from, to) {
  const out = []
  const [fy, fm] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y += 1, m = 1) : (m += 1)) out.push(`${y}-${String(m).padStart(2, '0')}`)
  return out
}
/** A corpus shaped like prod: sparse before 2025-09, dense after, a lagging last month. */
function corpus() {
  const rows = []
  for (const m of months('2024-01', '2025-08')) rows.push(sale({ date: `${m}-10`, zip: '75217' }))
  for (const m of months('2025-09', '2026-07')) for (let k = 0; k < 20; k += 1) rows.push(sale({ date: `${m}-${String(1 + k).padStart(2, '0')}`, zip: k % 2 ? '75227' : '75217', price: 100000 + k * 10000 }))
  for (let k = 0; k < 6; k += 1) rows.push(sale({ date: `2026-08-0${1 + k}`, zip: '75217' }))
  // Houston: investors, cash evidence, one unpriced activity sale, a lender and a person-named "company".
  for (let k = 0; k < 30; k += 1) rows.push(sale({ date: '2026-06-10', zip: '77002', price: 300000, flags: Q | F.BUYER_KNOWN | F.CASH_KNOWN | (k < 12 ? F.INVESTOR | F.CASH : 0), buyer: k < 10 ? 'ACME HOMES LLC' : k < 12 ? 'FANNIE MAE' : null, cls: k < 12 ? 'llc_investor' : 'individual' }))
  rows.push(sale({ date: '2026-06-11', zip: '77002', price: null, ppsf: null, flags: F.INVESTOR | F.BUYER_KNOWN, buyer: 'WILLIAMS,MICHAEL' }))
  // Minneapolis: multifamily evidence.
  rows.push(sale({ date: '2026-04-01', zip: '55411', price: 400000, units: 4, sqft: 3600, type: 'Multi-Family' }))
  rows.push(sale({ date: '2026-04-02', zip: '55411', price: 600000, units: 8, sqft: 7000, type: 'Apartment' }))
  rows.push(sale({ date: '2026-04-03', zip: '55411', price: 300000, units: 4, sqft: 800, type: 'Multi-Family' })) // 200 sf/unit → no PPU
  rows.push(sale({ date: '2026-04-04', zip: '55411', price: 350000, units: null, sqft: null, type: 'Multi-Family' }))
  rows.push(sale({ date: '2026-04-05', zip: '55411', price: 250000, flags: Q | F.ENTITY }))
  return rows
}
const AUX = {
  searchAreas: [
    { kind: 'state', key: 'TX', label: 'TX', state: 'TX', n: 900, min_lat: 26, max_lat: 36, min_lng: -106, max_lng: -93, center_lat: 31, center_lng: -99 },
    { kind: 'state', key: 'MN', label: 'MN', state: 'MN', n: 300, min_lat: 43, max_lat: 49, min_lng: -97, max_lng: -89, center_lat: 45, center_lng: -93 },
    { kind: 'market', key: 'Dallas, TX', label: 'Dallas, TX', state: 'TX', n: 500, min_lat: 32.5, max_lat: 33.1, min_lng: -97.1, max_lng: -96.5, center_lat: 32.78, center_lng: -96.8 },
    { kind: 'county', key: 'TX:dallas', label: 'Dallas County, TX', state: 'TX', n: 450, min_lat: 32.5, max_lat: 33, min_lng: -97, max_lng: -96.5, center_lat: 32.77, center_lng: -96.77 },
    { kind: 'city', key: 'TX:dallas', label: 'Dallas, TX', state: 'TX', n: 400, min_lat: 32.6, max_lat: 33, min_lng: -96.9, max_lng: -96.6, center_lat: 32.8, center_lng: -96.78 },
    { kind: 'zip', key: '75217', label: '75217', state: 'TX', n: 120, min_lat: 32.68, max_lat: 32.74, min_lng: -96.72, max_lng: -96.64, center_lat: 32.71, center_lng: -96.68 },
    { kind: 'zip', key: '55411', label: '55411', state: 'MN', n: 381, min_lat: 44.98, max_lat: 45.02, min_lng: -93.32, max_lng: -93.28, center_lat: 45.0, center_lng: -93.3 },
  ],
  markets: [{ id: 'dallas-tx', display_name: 'Dallas, TX', state: 'TX' }, { id: 'houston-tx', display_name: 'Houston, TX', state: 'TX' }, { id: 'minneapolis-mn', display_name: 'Minneapolis, MN', state: 'MN' }],
  zipMarket: [{ zip5: '75217', state: 'TX', canonical_market_id: 'dallas-tx' }, { zip5: '75227', state: 'TX', canonical_market_id: 'dallas-tx' }, { zip5: '77002', state: 'TX', canonical_market_id: 'houston-tx' }, { zip5: '55411', state: 'MN', canonical_market_id: 'minneapolis-mn' }],
  aliases: [{ alias: 'Saint Paul', state: 'MN', canonical_market_id: 'minneapolis-mn' }],
  census: [
    { geo_id: 'zip5:55411', geo_level: 'zip5', state_code: 'MN', county_name: 'Hennepin', county_geo_id: 'county:MN:hennepin', vintage: 2024, population: 30000, households: 9000, housing_units: 10000, median_household_income: 52000, renter_share: 0.55 },
    { geo_id: 'zip5:75217', geo_level: 'zip5', state_code: 'TX', county_name: 'Dallas', county_geo_id: 'county:TX:dallas', vintage: 2024, population: 80000, households: 22000, housing_units: 24000, median_household_income: 48000 },
    { geo_id: 'state:MN', geo_level: 'state', state_code: 'MN', vintage: 2024, population: 5700000, median_household_income: 87000 },
  ],
  outlined: [{ geo_level: 'zip5', k: '55411' }, { geo_level: 'zip5', k: '75217' }, { geo_level: 'state', k: 'TX' }, { geo_level: 'state', k: 'MN' }],
  areaStats: [{ kind: 'zip', key: '55411', n: 381, equity: 81.3, value: 259000, year_built: 1923, motivation: 43, distress: 39, tax_delinquent: 0, free_clear: 0.5 }],
  graphCoverage: [{ measured_at: '2026-10-04 06:49:00+00', coverage: { phone_type: 0.83 } }],
  parcelZipCounty: [{ zip: '75227', state: 'TX', county: 'DALLAS', n: 40 }, { zip: '77002', state: 'TX', county: 'Harris', n: 50 }],
}
const UNIVERSE = {
  TX: [['p1', '75217', 'dallas', 'dallas', 'Dallas, TX', 'Single Family', 1, true, true, false, true, false, false, false, false, true, false, 3, 2, 1400, 1960, 6000, 0, 10, 100, 200000, 'mobile'],
    ['p2', '75217', 'dallas', 'dallas', 'Dallas, TX', 'Single Family', 1, false, false, false, true, true, false, true, false, false, true, 3, 1, 1200, 1955, 5000, 50000, 20, 60, 180000, null]],
  MN: [['p3', '55411', 'minneapolis', 'hennepin', 'Minneapolis, MN', 'Multi-Family', 4, true, true, true, true, false, false, false, false, true, false, 8, 4, 3600, 1915, 5000, 0, 30, 100, 400000, 'landline']],
}

// ── the summary, built from the same fixture rows by a JS reference of the SQL contract ──
// (PROPOSED_20261004150000_market_intel_geo_rollup.sql: same windows, filters, qualified rule,
// exact medians, percentile_disc deciles, buckets). The SQL itself was dry-run on prod read-only:
// ZIP 55411 / 1y / all reproduced the API's numbers exactly (audit, section I).
const AS_OF_FIX = '2026-08-06'
const DAYS = { '30d': 30, '90d': 90, '6m': 182, '1y': 365, '3y': 1095, all: null }
const FILTERS = [['all', () => true], ['sfr', (s) => s.asset === 'sfr'], ['mf_2_4', (s) => s.asset === 'mf_2_4'], ['mf_5_plus', (s) => s.asset === 'mf_5_plus'],
  ['land', (s) => s.asset === 'land'], ['commercial', (s) => s.asset === 'commercial'], ['mf', (s) => s.isMf]]
const isoMonthOf = (d) => dateOfDay(firstDayOfMonth(Math.floor(new Date(Date.UTC(2000, 0, 1) + d * 86400000).getUTCFullYear() * 12 + new Date(Date.UTC(2000, 0, 1) + d * 86400000).getUTCMonth())))
function referenceSummary(rows) {
  const classify = createAssetClassifier()
  const fin = (v) => (v === null || v === undefined ? NaN : Number(v))
  const S = rows.map((r) => {
    const asset = MI_ASSETS[classify(r[5], Number.isFinite(fin(r[3])) ? fin(r[3]) : null)]
    const zip = /^\d{5}$/.test(r[7]) && r[7] !== '00000' ? r[7] : null
    return { d: r[0], price: fin(r[1]) > 0 ? fin(r[1]) : null, ppsf: fin(r[2]), units: fin(r[3]), sqft: fin(r[4]), type: r[5], state: r[6], zip, cityKey: r[8] ? `${r[6]}:${r[8]}` : null,
      lat: r[9], lng: r[10], f: r[11], buyer: r[12], asset, isMf: ['mf_2_4', 'mf_5_plus', 'mf_unknown'].includes(asset) }
  })
  const census = new Map(AUX.census.filter((c) => c.geo_level === 'zip5').map((c) => [c.geo_id.slice(5), c]))
  const parcel = new Map(AUX.parcelZipCounty.map((p) => [p.zip, p]))
  const market = new Map(AUX.zipMarket.map((m) => [m.zip5, m.canonical_market_id]))
  const zips = [...new Set([...S.map((s) => s.zip).filter(Boolean), ...census.keys(), ...parcel.keys(), ...market.keys()])]
  const maj = (list) => { const m = new Map(); for (const k of list) if (k) m.set(k, (m.get(k) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null }
  const zipGeo = zips.map((zip) => {
    const rs = S.filter((s) => s.zip === zip)
    const c = census.get(zip); const p = parcel.get(zip)
    return { zip, state: maj(rs.map((s) => s.state)), city_key: maj(rs.map((s) => s.cityKey)),
      county_key: c ? c.county_geo_id.replace('county:', '') : p ? `${p.state}:${p.county.toLowerCase()}` : null,
      county_name: c ? c.county_name : p ? p.county[0] + p.county.slice(1).toLowerCase() : null, county_via: c ? 'census' : p ? 'parcel_majority' : null,
      market_key: market.get(zip) ?? null, sales_n: rs.length,
      min_lat: rs.length ? Math.min(...rs.map((s) => s.lat)) : null, max_lat: rs.length ? Math.max(...rs.map((s) => s.lat)) : null,
      min_lng: rs.length ? Math.min(...rs.map((s) => s.lng)) : null, max_lng: rs.length ? Math.max(...rs.map((s) => s.lng)) : null }
  })
  const zg = new Map(zipGeo.map((z) => [z.zip, z]))
  const KEY = { nation: () => 'US', state: (s) => s.state, zip: (s) => s.zip, city: (s) => s.cityKey, county: (s) => zg.get(s.zip)?.county_key ?? null, market: (s) => zg.get(s.zip)?.market_key ?? null }
  const asOf = Math.max(...S.map((s) => s.d))
  const Q = (s) => Boolean(s.f & F.QUALIFIED)
  const period = []
  const month = []
  for (const [level, keyOf] of Object.entries(KEY)) {
    for (const [asset, pass] of FILTERS) {
      const groups = new Map()
      for (const s of S) { if (!pass(s)) continue; const k = keyOf(s); if (!k) continue; const l = groups.get(k) || []; l.push(s); groups.set(k, l) }
      for (const [k, rs] of groups) {
        for (const [pid, days] of Object.entries(DAYS)) {
          const w = rs.filter((s) => days === null || s.d > asOf - days)
          const ent = rs.filter((s) => s.f & F.ENTITY).length
          if (!w.length && !ent) continue
          const q = w.filter(Q)
          const ppu = q.filter((s) => (s.asset === 'mf_2_4' || s.asset === 'mf_5_plus') && s.units > 0 && (!(s.sqft > 0) || s.sqft / s.units >= 350))
          const mf = w.filter((s) => s.isMf)
          const ur = (s) => (s.units > 1 ? Math.round(s.units) : null)
          const cnt = (fn, list = w) => list.filter(fn).length
          const sorted = q.map((s) => s.price).sort((a, b) => a - b)
          period.push({ geo_level: level, geo_key: k, period: pid, asset,
            sale_count: w.length, priced_sale_count: cnt((s) => s.f & F.PRICED), qualified_sale_count: q.length, mls_count: cnt((s) => s.f & F.MLS), mf_sale_count: mf.length,
            investor_count: cnt((s) => s.f & F.INVESTOR), buyer_known_count: cnt((s) => s.f & F.BUYER_KNOWN), cash_known_count: cnt((s) => s.f & F.CASH_KNOWN), cash_count: cnt((s) => s.f & F.CASH),
            entity_owned_count: ent, latest_sale: w.length ? dateOfDay(Math.max(...w.map((s) => s.d))) : null,
            median_price: medianOf(q.map((s) => s.price)), median_ppsf: medianOf(q.filter((s) => s.ppsf > 0).map((s) => s.ppsf)), ppsf_n: q.filter((s) => s.ppsf > 0).length,
            median_ppu: medianOf(ppu.map((s) => s.price / s.units)), ppu_n: ppu.length,
            median_inv_price: medianOf(q.filter((s) => s.f & F.INVESTOR).map((s) => s.price)), inv_price_n: q.filter((s) => s.f & F.INVESTOR).length,
            price_deciles: sorted.length ? [0.1, 0.25, 0.5, 0.75, 0.9].map((x) => percentileDisc(sorted, x)) : null,
            ...Object.fromEntries(['sfr', 'mf_2_4', 'mf_5_plus', 'mf_unknown', 'land', 'commercial', 'other_res', 'unknown'].map((a) => [`n_${a}`, cnt((s) => s.asset === a)])),
            u_2: cnt((s) => ur(s) === 2, mf), u_3: cnt((s) => ur(s) === 3, mf), u_4: cnt((s) => ur(s) === 4, mf), u_5_9: cnt((s) => ur(s) >= 5 && ur(s) <= 9, mf),
            u_10_19: cnt((s) => ur(s) >= 10 && ur(s) <= 19, mf), u_20_49: cnt((s) => ur(s) >= 20 && ur(s) <= 49, mf), u_50p: cnt((s) => ur(s) >= 50, mf), u_unrec: cnt((s) => !(ur(s) >= 2), mf),
            s_lt2k: cnt((s) => s.sqft > 0 && s.sqft < 2000, mf), s_2_4k: cnt((s) => s.sqft >= 2000 && s.sqft < 4000, mf), s_4_8k: cnt((s) => s.sqft >= 4000 && s.sqft < 8000, mf),
            s_8_20k: cnt((s) => s.sqft >= 8000 && s.sqft < 20000, mf), s_20kp: cnt((s) => s.sqft >= 20000, mf), s_unrec: cnt((s) => !(s.sqft > 0), mf) })
        }
        const byMonth = new Map()
        for (const s of rs) { const m = isoMonthOf(s.d); const l = byMonth.get(m) || []; l.push(s); byMonth.set(m, l) }
        for (const [m, ms] of byMonth) {
          const q = ms.filter(Q)
          month.push({ geo_level: level, geo_key: k, asset, month: m, sales: ms.length, investor: ms.filter((s) => s.f & F.INVESTOR).length, buyer_known: ms.filter((s) => s.f & F.BUYER_KNOWN).length,
            cash: ms.filter((s) => s.f & F.CASH).length, cash_known: ms.filter((s) => s.f & F.CASH_KNOWN).length, price_n: q.length, median_price: medianOf(q.map((s) => s.price)),
            ppsf_n: q.filter((s) => s.ppsf > 0).length, median_ppsf: medianOf(q.filter((s) => s.ppsf > 0).map((s) => s.ppsf)) })
        }
      }
    }
  }
  const buyers = S.filter((s) => s.buyer).map((s, i) => ({ comp_id: `t:${i}`, d: s.d, zip: s.zip, state: s.state, city_key: s.cityKey, property_type: s.type, units: Number.isFinite(s.units) ? s.units : null, price: s.price, qualified: Q(s), is_investor: Boolean(s.f & F.INVESTOR), buyer: s.buyer }))
  const build = { build_id: 7, source_as_of: dateOfDay(asOf), source_first: dateOfDay(Math.min(...S.map((s) => s.d))), source_rows: S.length, ready_at: '2026-10-05 10:52:13+00', started_at: '2026-10-05 10:45:01+00', finished_at: null, db_ms: 301000, ticks: 47, rows_written: period.length + month.length, notes: { unmapped_types: [] } }
  return { build, zipGeo, period, month, buyers }
}

function fakeSummaryLoader({ summary = referenceSummary(corpus()), schemaMissing = [], ready = true } = {}) {
  const calls = { schema: 0, summary: 0, stream: 0, universe: 0, byName: {} }
  return {
    calls,
    guard: async () => ({ ok: true }),
    freshness: async () => ({ max_sold_on: summary.build.source_as_of, est_rows: summary.build.source_rows }),
    streamSales: async () => { calls.stream += 1; throw new Error('the full sales stream must not run') },
    aux: async (name) => AUX[name] || [],
    universeForState: async (st) => { calls.universe += 1; return UNIVERSE[st] || [] },
    summarySchema: async () => { calls.schema += 1; return schemaMissing },
    summary: async (name, params = []) => {
      calls.summary += 1
      calls.byName[name] = (calls.byName[name] || 0) + 1
      const [, a, b, c] = params
      switch (name) {
        case 'ready': return ready ? [summary.build] : []
        case 'building': return ready ? [] : [{ build_id: 8, cursor: 12, units: 49, next_unit: 'p:zip:90d', attempts: 0, last_error: null }]
        case 'zipGeo': return summary.zipGeo
        case 'slice': return summary.period.filter((r) => r.geo_level === a && r.period === b && r.asset === c)
        case 'assets': return summary.period.filter((r) => r.geo_level === 'nation' && r.period === 'all')
        case 'geoMonths': return summary.month.filter((r) => r.geo_level === a && r.geo_key === b && r.asset === c).sort((x, y) => (x.month < y.month ? -1 : 1))
        case 'buyers': return summary.buyers
        case 'monthSums': {
          const [, level, asset, rf, rt, cf, ct, pf, pt] = params
          const out = new Map()
          for (const r of summary.month) {
            if (r.geo_level !== level || r.asset !== asset) continue
            const o = out.get(r.geo_key) || { geo_key: r.geo_key, rate_sum: 0, cur_sum: 0, prior_sum: 0 }
            if (r.month >= rf && r.month <= rt) o.rate_sum += r.sales
            if (r.month >= cf && r.month <= ct) o.cur_sum += r.sales
            if (r.month >= pf && r.month <= pt) o.prior_sum += r.sales
            out.set(r.geo_key, o)
          }
          return [...out.values()]
        }
        default: throw new Error(`unexpected summary read ${name}`)
      }
    },
  }
}

/** The dev-only raw stream (the old path) over the same fixture rows. */
function fakeRawLoader({ busy = false } = {}) {
  const calls = { guard: 0, freshness: 0, stream: 0, aux: 0, universe: 0 }
  return {
    calls,
    guard: async () => { calls.guard += 1; return busy ? { ok: false, reason: 'database busy (20 active sessions)' } : { ok: true } },
    freshness: async () => { calls.freshness += 1; return { max_sold_on: AS_OF_FIX, est_rows: 300 } },
    streamSales: async (onRows, onProgress) => { calls.stream += 1; const rows = corpus(); onRows(rows.slice(0, 100)); onProgress(100); onRows(rows.slice(100)); onProgress(rows.length); return rows.length },
    aux: async (name) => { calls.aux += 1; return AUX[name] || [] },
    universeForState: async (st) => { calls.universe += 1; return UNIVERSE[st] || [] },
    summarySchema: async () => ['mi_rollup_builds.build_id'],
    summary: async () => { throw new Error('no summary in the raw test') },
  }
}
const BOUNDARIES = async (req) => ({ available: true, source: 'US Census ZCTA', data: { features: ['55411', '75217', '99999'].map((key) => ({ type: 'Feature', properties: { key }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } })) }, _req: req })
const DEV = { MI_DEV_RAW_FALLBACK: '1', NODE_ENV: 'development' }

/** The production path: the summary. */
async function readyService(opts = {}) {
  const loader = opts.loader || fakeSummaryLoader(opts)
  const boundaryCalls = []
  const svc = createMarketIntelService({ loader, warmWaitMs: 5000, universeWaitMs: 2000, prewarm: false, env: {}, readBoundaries: async (req) => { boundaryCalls.push(req); return BOUNDARIES(req) } })
  const st = await svc.run('status')
  return { svc, loader, boundaryCalls, st }
}
async function rawService(opts = {}) {
  const loader = fakeRawLoader(opts)
  const svc = createMarketIntelService({ loader, warmWaitMs: 5000, universeWaitMs: 2000, prewarm: false, env: DEV, readBoundaries: BOUNDARIES })
  const st = await svc.run('status')
  return { svc, loader, st }
}

// ── asset classes (§46, §49) ───────────────────────────────────────────────
test('asset model defers to the canonical taxonomy; unit count governs; generic MF without units is its own bucket', () => {
  assert.equal(miAssetOf('Single Family', 1), 'sfr')
  assert.equal(miAssetOf('Single Family', 3), 'mf_2_4')
  assert.equal(miAssetOf('Multi-Family', 3), 'mf_2_4')
  assert.equal(miAssetOf('Multi-Family', 8), 'mf_5_plus')
  assert.equal(miAssetOf('Multi-Family', null), 'mf_unknown')
  assert.equal(miAssetOf('Apartment', null), 'mf_5_plus')
  assert.equal(miAssetOf('Other', 2), 'mf_2_4')
  assert.equal(miAssetOf('Other', null), 'unknown')
  assert.equal(miAssetOf('Vacant Land', 3), 'land')
  assert.equal(miAssetOf('Townhouse', 1), 'other_res')
  assert.equal(isGenericMultiLabel('Duplex'), false)
})

test('price per unit needs price > 0, a positive unit count, an MF class and a credible size', () => {
  const mf = ASSET_CODE.mf_2_4
  assert.equal(isPricePerUnitEvidence({ price: 400000, units: 4, sqft: 3600, assetCode: mf }), true)
  assert.equal(isPricePerUnitEvidence({ price: 0, units: 4, sqft: 3600, assetCode: mf }), false)
  assert.equal(isPricePerUnitEvidence({ price: 400000, units: 0, sqft: 3600, assetCode: mf }), false)
  assert.equal(isPricePerUnitEvidence({ price: 400000, units: NaN, sqft: null, assetCode: mf }), false)
  assert.equal(isPricePerUnitEvidence({ price: 300000, units: 4, sqft: 800, assetCode: mf }), false)
  assert.equal(isPricePerUnitEvidence({ price: 300000, units: 4, sqft: null, assetCode: ASSET_CODE.sfr }), false)
})

// ── periods / coverage (§14, §50) ──────────────────────────────────────────
test('coverage window and growth baselines are derived from the data', () => {
  const counts = new Map()
  const prodShape = { '2025-07': 302, '2025-08': 318, '2025-09': 36378, '2025-10': 55043, '2025-11': 46474, '2025-12': 61126, '2026-01': 44821, '2026-02': 47137, '2026-03': 58093, '2026-04': 62532, '2026-05': 66230, '2026-06': 68906, '2026-07': 63821, '2026-08': 41340, '2026-09': 2284 }
  for (const [k, n] of Object.entries(prodShape)) { const [y, m] = k.split('-').map(Number); counts.set(y * 12 + m - 1, n) }
  const cov = deriveCoverage(counts, dayOfDate('2026-09-10'))
  const lab = (m) => `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`
  assert.equal(lab(cov.coverage_start_month), '2025-09')
  assert.equal(lab(cov.complete_through_month), '2026-07')
  assert.equal(cov.months.find((x) => x.label === '2025-08').status, 'pre_coverage')
  assert.equal(cov.months.find((x) => x.label === '2026-08').status, 'incomplete')
  assert.equal(cov.months.find((x) => x.label === '2026-09').status, 'partial')
  const g90 = growthWindows('90d', cov)
  assert.equal(g90.valid, true)
  assert.equal(g90.current.label, '2026-05–2026-07')
  assert.equal(g90.prior.label, '2026-02–2026-04')
  assert.equal(growthWindows('1y', cov).valid, false)
  assert.match(growthWindows('6m', cov).reason, /before sales coverage begins/)
  assert.equal(growthWindows('all', cov).valid, false)
  assert.equal(completeMonthsIn(dayOfDate('2026-06-15'), dayOfDate('2026-09-10'), cov).length, 1)
})

// ── geography (§5, §6, §51) ────────────────────────────────────────────────
function catalogFixture() {
  const b = createSalesIndexBuilder()
  b.ingest(corpus())
  const index = b.finish()
  const outlined = { zip: new Set(['55411', '75217']), state: new Set(['TX', 'MN']) }
  const censusZipCounty = AUX.census.filter((c) => c.geo_level === 'zip5').map((c) => ({ zip: c.geo_id.slice(5), state: c.state_code, county_key: c.county_geo_id.replace('county:', ''), county_name: c.county_name }))
  return { index, catalog: buildGeographyCatalog(factsFromIndex(index), { ...AUX, censusZipCounty, outlined }) }
}

test('ZIP / city / county / market / state lookups resolve to stable ids with lineage', () => {
  const { catalog } = catalogFixture()
  const z = catalog.get('zip:75227')
  assert.equal(z.parents.market, 'market:dallas-tx')
  assert.equal(z.parents.county, 'county:TX:dallas') // parcel-majority county (no census cell)
  assert.equal(z.county_via, 'parcel_majority')
  assert.equal(catalog.get('zip:55411').county_via, 'census')
  assert.equal(catalog.get('zip:55411').geometry, 'census_zcta')
  assert.equal(catalog.get('county:TX:dallas').geometry, 'none')
  assert.equal(catalog.get('county:TX:harris').label, 'Harris County, TX')
  assert.equal(catalog.get('market:houston-tx').coverage.sales, 31)
  assert.equal(catalog.get('state:TX').name, 'Texas')
  assert.deepEqual(parseGeoId('county:TX:dallas'), { level: 'county', key: 'TX:dallas', state: 'TX', name: 'dallas' })
  assert.equal(parseGeoId('Dallas'), null)
})

test('search: ZIP, state name, county, "city st", aliases; an ambiguous name lists every level', () => {
  const { catalog } = catalogFixture()
  assert.equal(searchGeographies(catalog, '55411').results[0].id, 'zip:55411')
  assert.equal(searchGeographies(catalog, 'Texas').results[0].id, 'state:TX')
  assert.equal(searchGeographies(catalog, 'tx').results[0].id, 'state:TX')
  assert.equal(searchGeographies(catalog, 'Harris County').results[0].id, 'county:TX:harris')
  const dallas = searchGeographies(catalog, 'Dallas')
  assert.equal(dallas.ambiguous, true)
  const ids = dallas.results.map((r) => r.id)
  assert.ok(ids.includes('market:dallas-tx') && ids.includes('city:TX:dallas') && ids.includes('county:TX:dallas'))
  assert.equal(dallas.results[0].id, 'market:dallas-tx')
  assert.equal(searchGeographies(catalog, 'dallas tx').state_hint, 'TX')
  assert.equal(searchGeographies(catalog, 'saint paul').results[0].id, 'market:minneapolis-mn')
  assert.equal(searchGeographies(catalog, '').results.length, 0)
})

// ── metrics (§45, §47, §48, §49) ───────────────────────────────────────────
test('registry: every metric has the required fields; unsupported asks are explicit', () => {
  for (const m of METRICS) for (const k of ['id', 'label', 'description', 'formula', 'source', 'unit', 'levels', 'assets', 'min_sample', 'freshness', 'aggregation']) assert.ok(m[k] !== undefined, `${m.id}.${k}`)
  assert.ok(UNSUPPORTED.cap_rate && UNSUPPORTED.noi)
  assert.equal(METRIC_BY_ID.investor_purchase_share.sample, 'buyer_known_count')
  assert.equal(METRIC_BY_ID.entity_owned_count.windowed, false)
})

test('median is exact (percentile_cont semantics)', () => {
  assert.equal(medianOf([3, 1, 2]), 2)
  assert.equal(medianOf([4, 1, 3, 2]), 2.5)
  assert.equal(medianOf([]), null)
})

test('dossier: priced vs activity sales, investor share over recorded buyers, entity separate, cash share, price per unit', async () => {
  const { svc, st } = await readyService()
  assert.equal(st.status, 'ready')
  assert.equal(st.mode, 'summary')
  const h = await svc.run('dossier', { id: 'market:houston-tx', period: '1y' })
  assert.equal(h.ok, true)
  assert.equal(h.values.sales_count.value, 31) // the unpriced sale is activity
  assert.equal(h.values.priced_sale_count.value, 30)
  assert.equal(h.values.median_sale_price.value, 300000)
  assert.equal(h.values.investor_purchase_count.value, 13)
  assert.equal(h.values.investor_purchase_share.n, 31)
  assert.ok(Math.abs(h.values.investor_purchase_share.value - 13 / 31) < 1e-9)
  assert.ok(Math.abs(h.values.cash_purchase_share.value - 12 / 30) < 1e-9)
  assert.equal(h.values.entity_owned_count.value, 0)
  // Privacy: only the displayable company is listed; the lender and the personal name are not.
  assert.deepEqual(h.investors.top_buyers.map((b) => b.name), ['ACME HOMES LLC'])
  assert.equal(h.investors.buyer_kinds.lender_or_agency, 2)
  const m = await svc.run('dossier', { id: 'zip:55411', period: '1y' })
  assert.equal(m.values.entity_owned_count.value, 1)
  assert.equal(m.values.mf_sale_count.value, 4)
  assert.equal(m.values.median_price_per_unit.status, 'insufficient') // 2 valid of 5 needed
  assert.equal(m.values.median_price_per_unit.n, 2)
  assert.equal(m.values.median_sale_price.status, 'insufficient')
  assert.equal(m.values.population.value, 30000)
  assert.equal(m.values.avg_year_built.value, 1923)
  assert.equal(m.values.sms_eligible_count.value, 1) // MN universe loaded for the dossier
  assert.ok(m.brief.every((s) => s.text && s.metrics.length))
  const mfu = m.multifamily.unit_distribution
  assert.equal(mfu.find((x) => x.label === '4').n, 2)
  assert.equal(mfu.find((x) => x.label === 'not recorded').n, 1)
})

test('market demographics sum ZIP cells; medians are not invented for markets', async () => {
  const { svc } = await readyService()
  const d = await svc.run('dossier', { id: 'market:minneapolis-mn' })
  assert.equal(d.values.population.value, 30000)
  assert.equal(d.values.median_household_income.status, 'unavailable')
})

test('growth only on a valid baseline', async () => {
  const { svc } = await readyService()
  const y = await svc.run('dossier', { id: 'market:dallas-tx', period: '1y' })
  assert.equal(y.values.sales_growth.status, 'unavailable')
  const q = await svc.run('dossier', { id: 'market:dallas-tx', period: '90d' })
  assert.equal(q.values.sales_growth.status, 'ok')
  assert.equal(q.values.sales_growth.value, 0) // 60 vs 60 complete-month sales
})

// ── rankings (§9, §10) ─────────────────────────────────────────────────────
test('rank engine: competition ranks, ties, missing data unranked', () => {
  const r = (id, v, status = 'ok') => ({ id, label: id, values: { m: { value: v, n: 10, status }, sales_count: { value: 1 } } })
  const { ranked, unranked } = rankRows([r('a', 5), r('b', 9), r('c', 9), r('d', 1), r('e', null, 'insufficient')], 'm')
  assert.deepEqual(ranked.map((x) => [x.id, x.rank]), [['b', 1], ['c', 1], ['a', 3], ['d', 4]])
  assert.deepEqual(unranked.map((x) => x.id), ['e'])
  assert.deepEqual(rankRows([r('a', 5), r('b', 9)], 'm', 'asc').ranked.map((x) => x.id), ['a', 'b'])
})

test('rank op: ZIPs in Texas by investor purchases; thresholds; unsupported levels refused', async () => {
  const { svc } = await readyService()
  const res = await svc.run('rank', { level: 'zip', within: 'state:TX', metric: 'investor_purchase_count' })
  assert.equal(res.ok, true)
  assert.equal(res.rows[0].id, 'zip:77002')
  assert.equal(res.rows[0].rank, 1)
  const thr = await svc.run('rank', { level: 'zip', within: 'state:TX', metric: 'sales_count', min_sales: 100 })
  assert.ok(thr.rows.every((x) => x.values.sales_count.value >= 100))
  const bad = await svc.run('rank', { level: 'state', within: 'zip:55411', metric: 'sales_count' })
  assert.equal(bad.ok, false)
  const mkt = await svc.run('rank', { level: 'market', within: 'nation:US', metric: 'median_household_income' })
  assert.equal(mkt.ok, false) // ACS medians are not defined for markets
  const cov = await svc.run('rank', { level: 'zip', within: 'nation:US', metric: 'buyer_evidence_coverage' })
  assert.equal(cov.error, 'metric_not_rankable')
})

// ── screener (§24) ─────────────────────────────────────────────────────────
test('screener: AND / OR, empty results, unavailable metric, rejected filters', async () => {
  const { svc } = await readyService()
  const and = await svc.run('screen', { level: 'zip', within: 'state:TX', filters: JSON.stringify([{ metric: 'sales_count', op: 'gte', value: 25 }, { metric: 'investor_purchase_share', op: 'gte', value: 0.15 }]) })
  assert.deepEqual(and.rows.map((x) => x.id), ['zip:77002'])
  const or = await svc.run('screen', { level: 'zip', within: 'state:TX', match: 'any', filters: JSON.stringify([{ metric: 'sales_count', op: 'gte', value: 25 }, { metric: 'investor_purchase_share', op: 'gte', value: 0.15 }]) })
  assert.ok(or.rows.length >= 3)
  const none = await svc.run('screen', { level: 'zip', within: 'state:TX', filters: JSON.stringify([{ metric: 'sales_count', op: 'gte', value: 1e6 }]) })
  assert.equal(none.total, 0)
  const bad = await svc.run('screen', { level: 'market', within: 'nation:US', filters: JSON.stringify([{ metric: 'median_gross_rent', op: 'lte', value: 1500 }]) })
  assert.equal(bad.error, 'metric_unsupported')
  const rej = await svc.run('screen', { level: 'zip', within: 'state:TX', filters: JSON.stringify([{ metric: 'cap_rate', op: 'gte', value: 0.08 }]) })
  assert.equal(rej.rejected[0].metric, 'cap_rate')
  assert.equal(passesFilters({ values: { x: { status: 'insufficient', value: null } } }, [{ metric: 'x', op: 'gte', value: 0 }]), false)
})

// ── compare (§23, §50) ─────────────────────────────────────────────────────
test('compare: one window and one rule set for every geography; 2–6 ids', async () => {
  const { svc } = await readyService()
  const c = await svc.run('compare', { ids: 'market:dallas-tx,market:houston-tx,zip:55411', period: '6m', asset: 'all' })
  assert.equal(c.ok, true)
  assert.equal(c.items.length, 3)
  assert.ok(c.items.every((i) => i.window.from === c.window.from && i.window.to === c.window.to && i.window.asset === 'all'))
  assert.equal(c.series.length, 3)
  assert.equal((await svc.run('compare', { ids: 'market:dallas-tx' })).error, 'compare_needs_two')
  assert.equal((await svc.run('compare', { ids: 'market:dallas-tx,market:nowhere' })).error, 'unknown_geography')
})

// ── heat (§11, §12) ────────────────────────────────────────────────────────
test('heat: values join owned outlines, ZIP below z9 refused, quantile t, honest tooltip', async () => {
  const { svc, boundaryCalls } = await readyService()
  const h = await svc.run('heat', { metric: 'sales_count', bbox: '-97,32,-93,46', zoom: '9.5' })
  assert.equal(h.level, 'zip')
  assert.equal(boundaryCalls.length, 1)
  assert.deepEqual(h.rows.map((r) => r.key).sort(), ['55411', '75217'])
  assert.equal(h.without_value, 1) // 99999 has an outline but no sales
  assert.ok(h.rows.every((r) => r.t >= 0 && r.t <= 1))
  assert.match(h.rows.find((r) => r.key === '75217').tip, /^75217 · \d+ sales · 0 investor purchases/)
  const st = await svc.run('heat', { metric: 'sales_count', bbox: '-125,24,-66,50', zoom: '4' })
  assert.equal(st.level, 'state')
  assert.equal((await svc.run('heat', { metric: 'priced_sale_count', bbox: '-97,32,-93,46', zoom: '9.5' })).error, 'metric_not_heatable')
})

// ── safety / performance (§41, §42, §51) ───────────────────────────────────
test('load guard defers on a busy database', () => {
  assert.equal(loadAllowed({ active: 13, longest: 0 }).ok, false)
  assert.equal(loadAllowed({ active: 4, longest: 11 }).ok, false)
  assert.equal(loadAllowed({ active: 4, longest: 2 }).ok, true)
})

test('dev raw fallback: a busy database defers the stream, honest status', async () => {
  const loader = fakeRawLoader({ busy: true })
  const svc = createMarketIntelService({ loader, warmWaitMs: 200, env: DEV, readBoundaries: async () => ({ available: false }) })
  const r = await svc.run('dossier', { id: 'zip:55411' })
  assert.equal(r.ok, true)
  assert.equal(r.status, 'deferred')
  assert.match(r.error, /busy/)
  assert.equal(loader.calls.stream, 0)
})

test('no N+1: repeated interactions re-use cached summary slices (0 new reads), and never stream sales', async () => {
  const { svc, loader } = await readyService()
  const round = async () => {
    await svc.run('dossier', { id: 'market:dallas-tx' })
    await svc.run('rank', { level: 'zip', within: 'nation:US', metric: 'sales_count' })
    await svc.run('rank', { level: 'state', within: 'nation:US', metric: 'median_sale_price' })
    await svc.run('screen', { level: 'zip', within: 'state:TX', filters: '[]' })
    await svc.run('compare', { ids: 'market:dallas-tx,market:houston-tx,market:minneapolis-mn,zip:55411,zip:75217,state:TX' })
    await svc.run('trends', { ids: 'zip:55411' })
    await svc.run('search', { q: 'dal' })
  }
  await round()
  const after1 = loader.calls.summary
  await round()
  assert.equal(loader.calls.summary, after1)
  assert.equal(loader.calls.stream, 0)
  assert.equal(loader.calls.byName.buyers, 1)
  assert.ok((loader.calls.byName.slice ?? 0) <= 20, `slice reads ${loader.calls.byName.slice}`)
})

test('universe summary counts graph flags only and reports field coverage', () => {
  const u = shapeUniverse('TX', UNIVERSE.TX)
  const s = summarizeUniverse(u.rows)
  assert.equal(s.seller_record_count, 2)
  assert.equal(s.sms_eligible_count, 1)
  assert.equal(s.suppressed_count, 1)
  assert.equal(s.recent_contact_hold_count, 1)
  assert.equal(s.stock.find((x) => x.field === 'loan').n, 1) // zero balances are not a median input
})

test('legacy guard: Market Intelligence never reads the frozen comp pools', () => {
  const dir = join(process.cwd(), 'src/lib/domain/market-intelligence')
  for (const f of readdirSync(dir)) {
    const src = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    assert.doesNotMatch(src, /recently_sold_properties|mv_map_sold_comps|v_recent_sold_comps|buyer_comp_raw_v2/, f)
    assert.doesNotMatch(src, /\b(insert|update|delete)\s+(into|from)?\s*public\./i, f)
  }
})

test('period window ends at the data as-of day', () => {
  const w = periodWindow('30d', dayOfDate('2026-09-10'), dayOfDate('2021-10-04'))
  assert.equal(w.to_date, '2026-09-10')
  assert.equal(w.from_date, '2026-08-12')
  assert.equal(monthOfDay(dayOfDate('2026-01-31')), 2026 * 12)
})

// ── the summary read path (owner decision 2026-10-04) ───────────────────────
test('production never streams raw sales: no summary → "Market summary not built yet"', async () => {
  for (const env of [{}, { MI_DEV_RAW_FALLBACK: '1', NODE_ENV: 'production' }, { NODE_ENV: 'development' }]) {
    const loader = fakeSummaryLoader({ ready: false })
    const svc = createMarketIntelService({ loader, warmWaitMs: 500, env, prewarm: false, readBoundaries: BOUNDARIES })
    const r = await svc.run('dossier', { id: 'zip:55411' })
    assert.equal(r.ok, true)
    assert.equal(r.status, 'summary_missing')
    assert.equal(r.message, SUMMARY_MISSING_MESSAGE)
    assert.match(r.detail, /in progress: unit 12 of 49/)
    assert.equal(loader.calls.stream, 0, JSON.stringify(env))
  }
  assert.equal(devRawAllowed({ MI_DEV_RAW_FALLBACK: '1', NODE_ENV: 'production' }), false)
  assert.equal(devRawAllowed({ NODE_ENV: 'development' }), false)
  assert.equal(devRawAllowed(DEV), true)
})

test('schema guard: a missing table or a phantom column is reported, never queried', async () => {
  const have = Object.entries(SUMMARY_COLUMNS).flatMap(([t, cols]) => cols.map((c) => ({ t, c })))
  assert.deepEqual(missingSummaryColumns(have), [])
  assert.deepEqual(missingSummaryColumns(have.filter((r) => !(r.t === 'mi_geo_period_rollup' && r.c === 'median_ppu'))), ['mi_geo_period_rollup.median_ppu'])
  assert.equal(missingSummaryColumns([]).length, have.length)
  const loader = fakeSummaryLoader({ schemaMissing: ['mi_geo_period_rollup.median_ppu'] })
  const svc = createMarketIntelService({ loader, warmWaitMs: 500, env: {}, prewarm: false, readBoundaries: BOUNDARIES })
  const r = await svc.run('status')
  assert.equal(r.status, 'summary_missing')
  assert.match(r.detail, /not installed/)
  assert.equal(loader.calls.summary, 0)
})

test('freshness is surfaced: build, built-at and data as-of', async () => {
  const { st } = await readyService()
  assert.equal(st.mode, 'summary')
  assert.equal(st.as_of, AS_OF_FIX)
  assert.equal(st.summary.build_id, 7)
  assert.equal(st.summary.built_at, '2026-10-05 10:52:13+00')
  assert.equal(st.sources.sales.built_at, '2026-10-05 10:52:13+00')
  const { svc } = await readyService()
  const d = await svc.run('dossier', { id: 'zip:55411' })
  assert.equal(d.data_quality.summary_built_at, '2026-10-05 10:52:13+00')
  assert.match(d.data_quality.sales_refresh, /build 7/)
})

test('summary and raw computation are IDENTICAL on the same rows', async () => {
  const { svc: sum } = await readyService()
  const { svc: raw, st } = await rawService()
  assert.equal(st.mode, 'raw_dev')
  const strip = (x) => JSON.parse(JSON.stringify(x))
  for (const id of ['nation:US', 'state:TX', 'state:MN', 'market:dallas-tx', 'market:houston-tx', 'market:minneapolis-mn', 'county:TX:dallas', 'county:TX:harris', 'city:TX:dallas', 'zip:55411', 'zip:75217', 'zip:77002']) {
    for (const period of ['30d', '90d', '6m', '1y', 'all']) {
      for (const asset of ['all', 'sfr', 'mf', 'mf_2_4', 'mf_5_plus']) {
        const a = await sum.run('dossier', { id, period, asset, load_universe: '0' })
        const b = await raw.run('dossier', { id, period, asset, load_universe: '0' })
        for (const k of ['values', 'sales', 'investors', 'multifamily', 'trends', 'brief', 'rank_context', 'children']) assert.deepEqual(strip(a[k]), strip(b[k]), `${id} ${period} ${asset} ${k}`)
      }
    }
  }
  for (const [level, within, metric] of [['zip', 'state:TX', 'investor_purchase_count'], ['zip', 'nation:US', 'median_sale_price'], ['market', 'nation:US', 'sales_count'], ['state', 'nation:US', 'investor_purchase_share'], ['city', 'state:TX', 'sales_count']]) {
    const a = await sum.run('rank', { level, within, metric })
    const b = await raw.run('rank', { level, within, metric })
    // centroid is display geometry (the raw index keeps coordinates as float32); every value must match exactly
    const noGeo = (rows) => strip(rows).map(({ centroid, ...r }) => { assert.ok(Array.isArray(centroid) || centroid === null); return r })
    assert.deepEqual(noGeo(a.rows), noGeo(b.rows), `rank ${level} ${within} ${metric}`)
  }
  const f = JSON.stringify([{ metric: 'sales_count', op: 'gte', value: 25 }, { metric: 'investor_purchase_share', op: 'gte', value: 0.15 }])
  const noGeo2 = (rows) => strip(rows).map(({ centroid: _c, ...r }) => r)
  assert.deepEqual(noGeo2((await sum.run('screen', { level: 'zip', within: 'state:TX', filters: f })).rows), noGeo2((await raw.run('screen', { level: 'zip', within: 'state:TX', filters: f })).rows))
})

test('SQL asset map = the JS asset model for every raw type in the corpus', () => {
  const sql = readFileSync(join(process.cwd(), '../../supabase/migrations/PROPOSED_20261004150000_market_intel_geo_rollup.sql'), 'utf8')
  const values = sql.slice(sql.indexOf('insert into public.mi_asset_type_map'), sql.indexOf('on conflict (raw_type)'))
  const map = Object.fromEntries([...values.matchAll(/\('([^']+)', '([a-z_0-9]+)'\)/g)].map((m) => [m[1], m[2]]))
  assert.equal(Object.keys(map).length, 7)
  // the SQL rule, transcribed: unit count governs the residential lanes, generic MF without units is its own bucket
  const sqlAsset = (raw, units) => {
    const base = map[raw] ?? 'unknown'
    if (['sfr', 'mf_generic', 'mf_5_plus', 'unknown'].includes(base) && units > 1) return units >= 5 ? 'mf_5_plus' : 'mf_2_4'
    if (base === 'mf_generic') return 'mf_unknown'
    return base
  }
  for (const raw of [...Object.keys(map), 'Something New']) for (const units of [null, 0, 1, 2, 2.5, 3, 4, 5, 8, 40]) assert.equal(sqlAsset(raw, units), miAssetOf(raw, units), `${raw} / ${units}`)
})

test('the rollback-only pretest embeds the migration verbatim and rolls back', () => {
  const dir = join(process.cwd(), '../../supabase/migrations')
  const mig = readFileSync(join(dir, 'PROPOSED_20261004150000_market_intel_geo_rollup.sql'), 'utf8')
  const pre = readFileSync(join(dir, 'PROPOSED_20261004150000_market_intel_geo_rollup_pretest.sql'), 'utf8')
  assert.ok(pre.includes(`EXECUTE $mig$${mig}$mig$;`), 'regenerate with apps/api/scripts/market-intel-make-pretest.py')
  assert.match(pre, /RAISE EXCEPTION 'pretest ok:/)
  assert.doesNotMatch(pre, /^\s*(BEGIN|COMMIT)\s*;/m)
  const rb = readFileSync(join(dir, 'PROPOSED_20261004150000_market_intel_geo_rollup_rollback.sql'), 'utf8')
  for (const obj of ['mi_geo_period_rollup', 'mi_geo_month_rollup', 'mi_zip_geo', 'mi_buyer_activity', 'mi_rollup_builds', 'mi_rollup_tick', 'mi_rollup_sales_v']) assert.match(rb, new RegExp(obj))
  const sched = readFileSync(join(dir, 'PROPOSED_20261004151000_market_intel_rollup_schedule.sql'), 'utf8')
  assert.match(sched, /statement_timeout = '30s'/)
  assert.match(sched, /'45-59 10 \* \* \*'/)
})
