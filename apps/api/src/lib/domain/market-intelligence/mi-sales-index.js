/**
 * MARKET INTELLIGENCE: the in-memory MARKET SALES INDEX.
 *
 * Why it exists (audit G): mv_map_market_sales has no geography index. Exact
 * medians for one level nationally cost 6.6 s, and the six levels × asset
 * classes in one pass would be ~40 s. So the API streams the MV ONCE (a
 * consistent cursor over a sequential scan; see mi-loader.js) into compact
 * typed arrays. Every overview, ranking, screen, compare, trend and heat cell
 * is then computed exactly in-process, with zero database queries per interaction.
 *
 * Nothing here is sampled or approximated: medians are exact
 * (percentile_cont(0.5) semantics), counts are exact.
 *
 * Row columns (EXTRACT_COLUMNS order) are produced by mi-loader's SQL.
 */
import { createAssetClassifier, ASSET_CODE, isPricePerUnitEvidence, MF_BUCKETS } from './mi-asset-classes.js'
import { monthOfDay } from './mi-periods.js'
import { addBuyer, medianOf, sqftBucket, unitBucket } from './mi-agg.js'

export { medianOf }
import { displayableCompanyName } from '@/lib/domain/entity-graph/buyer-name-privacy.js'
import { lenderClass } from '@/lib/domain/buyer-match/buyer-identity-rules.js'

export const EXTRACT_COLUMNS = Object.freeze(['d', 'price', 'ppsf', 'units', 'sqft', 'property_type', 'state', 'zip', 'city', 'lat', 'lng', 'flags', 'buyer', 'buyer_class'])
export const F = Object.freeze({ INVESTOR: 1, BUYER_KNOWN: 2, CASH_KNOWN: 4, CASH: 8, ENTITY: 16, QUALIFIED: 32, MLS: 64, PORTFOLIO: 128, PRICED: 256 })

const MF_CODES = new Set(MF_BUCKETS.map((b) => ASSET_CODE[b]))

class Grow {
  constructor(Type, cap = 1 << 16) { this.Type = Type; this.a = new Type(cap); this.n = 0 }
  push(v) { if (this.n === this.a.length) { const b = new this.Type(this.a.length * 2); b.set(this.a); this.a = b } this.a[this.n++] = v }
  done() { return this.a.subarray(0, this.n) }
}

class Dict {
  constructor() { this.map = new Map(); this.keys = [] }
  id(k) { let i = this.map.get(k); if (i === undefined) { i = this.keys.length; this.map.set(k, i); this.keys.push(k) } return i }
  get(k) { return this.map.get(k) }
  get size() { return this.keys.length }
}

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v))
const clean = (v) => String(v ?? '').trim()
const ZIP5 = /^\d{5}$/

/** CSR row lists: rows grouped by a key index (Int32 keys, -1 = none). */
function buildCsr(keys, nKeys) {
  const counts = new Int32Array(nKeys + 1)
  for (let i = 0; i < keys.length; i += 1) if (keys[i] >= 0) counts[keys[i] + 1] += 1
  for (let k = 0; k < nKeys; k += 1) counts[k + 1] += counts[k]
  const rows = new Int32Array(counts[nKeys])
  const fill = counts.slice(0, nKeys)
  for (let i = 0; i < keys.length; i += 1) { const k = keys[i]; if (k >= 0) rows[fill[k]++] = i }
  return { offsets: counts, rows }
}

/** Streaming builder. ingest() takes array-mode rows; finish() returns the index. */
export function createSalesIndexBuilder({ classify = createAssetClassifier() } = {}) {
  const day = new Grow(Int32Array); const price = new Grow(Float64Array); const ppsf = new Grow(Float32Array)
  const units = new Grow(Float32Array); const sqft = new Grow(Float32Array); const asset = new Grow(Uint8Array)
  const zip = new Grow(Int32Array); const city = new Grow(Int32Array); const state = new Grow(Int16Array)
  const lat = new Grow(Float32Array); const lng = new Grow(Float32Array); const flags = new Grow(Uint16Array)
  const buyer = new Grow(Int32Array); const bclass = new Grow(Uint8Array)
  const zips = new Dict(); const cities = new Dict(); const states = new Dict(); const buyers = new Dict(); const classes = new Dict()
  const rawTypes = new Map()
  let rejected = 0

  function ingest(rows) {
    for (const r of rows) {
      const d = num(r[0])
      const st = clean(r[6]).toUpperCase()
      if (!Number.isFinite(d) || !/^[A-Z]{2}$/.test(st)) { rejected += 1; continue }
      const z = clean(r[7])
      const c = clean(r[8]).toLowerCase()
      const p = num(r[1]); const ps = num(r[2]); const u = num(r[3]); const sq = num(r[4])
      const raw = r[5] === null || r[5] === undefined ? null : String(r[5])
      rawTypes.set(raw, (rawTypes.get(raw) || 0) + 1)
      day.push(d)
      price.push(Number.isFinite(p) && p > 0 ? p : NaN)
      ppsf.push(Number.isFinite(ps) && ps > 0 ? ps : NaN)
      units.push(Number.isFinite(u) ? u : NaN)
      sqft.push(Number.isFinite(sq) && sq > 0 ? sq : NaN)
      asset.push(classify(raw, Number.isFinite(u) ? u : null))
      state.push(states.id(st))
      zip.push(ZIP5.test(z) && z !== '00000' ? zips.id(z) : -1)
      city.push(c ? cities.id(`${st}:${c}`) : -1)
      lat.push(num(r[9])); lng.push(num(r[10]))
      flags.push(Number(r[11]) || 0)
      const b = r[12] === null || r[12] === undefined ? '' : clean(r[12])
      buyer.push(b ? buyers.id(b) : -1)
      bclass.push(classes.id(clean(r[13]) || 'unknown'))
    }
  }

  function finish() {
    const cols = {
      day: day.done(), price: price.done(), ppsf: ppsf.done(), units: units.done(), sqft: sqft.done(), asset: asset.done(),
      zip: zip.done(), city: city.done(), state: state.done(), lat: lat.done(), lng: lng.done(), flags: flags.done(), buyer: buyer.done(), bclass: bclass.done(),
    }
    const n = cols.day.length
    // Month per row, computed once (aggregations never construct Dates per row).
    cols.month = new Int32Array(n)
    const monthMemo = new Map()
    for (let i = 0; i < n; i += 1) {
      const d = cols.day[i]
      let mo = monthMemo.get(d)
      if (mo === undefined) { mo = monthOfDay(d); monthMemo.set(d, mo) }
      cols.month[i] = mo
    }
    let minDay = Infinity; let maxDay = -Infinity
    for (let i = 0; i < n; i += 1) { if (cols.day[i] < minDay) minDay = cols.day[i]; if (cols.day[i] > maxDay) maxDay = cols.day[i] }
    // Buyer identity policy, decided once per name: listable = a displayable company that is not a lender/agency.
    const buyerListable = new Uint8Array(buyers.size)
    const buyerLender = new Uint8Array(buyers.size)
    buyers.keys.forEach((name, i) => {
      const lender = lenderClass(name)
      buyerLender[i] = lender ? 1 : 0
      buyerListable[i] = !lender && displayableCompanyName(name) ? 1 : 0
    })
    return {
      n, rejected, cols, minDay: n ? minDay : null, maxDay: n ? maxDay : null,
      dicts: { zips: zips.keys, cities: cities.keys, states: states.keys, buyers: buyers.keys, classes: classes.keys },
      lookup: { zip: zips.map, city: cities.map, state: states.map },
      buyerListable, buyerLender,
      byZip: buildCsr(cols.zip, zips.size), byCity: buildCsr(cols.city, cities.size), byState: buildCsr(cols.state, states.size),
      rawTypes: [...rawTypes.entries()].map(([raw, count]) => ({ raw, count })).sort((a, b) => b.count - a.count),
    }
  }
  return { ingest, finish }
}

// ── Aggregation ────────────────────────────────────────────────────────────

/** A row source: iterate the rows of one or more CSR buckets, or every row. */
export function rowsOf(index, selector) {
  if (!selector || selector.all) return { all: true, n: index.n }
  const lists = []
  for (const [csrName, k] of selector.buckets || []) {
    const csr = index[csrName]
    if (k === undefined || k === null || k < 0 || k + 1 >= csr.offsets.length) continue
    lists.push(csr.rows.subarray(csr.offsets[k], csr.offsets[k + 1]))
  }
  return { all: false, lists }
}

export function forEachRow(src, fn) {
  if (src.all) { for (let i = 0; i < src.n; i += 1) fn(i); return }
  for (const list of src.lists) for (let j = 0; j < list.length; j += 1) fn(list[j])
}

export function newAcc() {
  return {
    sales: 0, priced: 0, qualified: 0, investor: 0, buyerKnown: 0, cashKnown: 0, cash: 0, mfSales: 0, entity: 0,
    prices: [], ppsf: [], ppu: [], invPrices: [], buyers: new Map(), namedPurchases: 0, lenderPurchases: 0,
    latestDay: null, months: new Map(), mls: 0, assetMix: new Map(), unitDist: new Map(), sqftDist: new Map(),
  }
}

export function addRow(acc, index, i, win) {
  const c = index.cols
  const a = c.asset[i]
  if (win.codes && !win.codes.has(a)) return
  const f = c.flags[i]
  if (f & F.ENTITY) acc.entity += 1
  const d = c.day[i]
  const mo = c.month[i]
  acc.months.set(mo, (acc.months.get(mo) || 0) + 1)
  if (d < win.from || d > win.to) return
  acc.sales += 1
  if (acc.latestDay === null || d > acc.latestDay) acc.latestDay = d
  acc.assetMix.set(a, (acc.assetMix.get(a) || 0) + 1)
  if (f & F.MLS) acc.mls += 1
  if (MF_CODES.has(a)) {
    acc.mfSales += 1
    const ub = unitBucket(c.units[i])
    acc.unitDist.set(ub, (acc.unitDist.get(ub) || 0) + 1)
    const sb = sqftBucket(c.sqft[i])
    acc.sqftDist.set(sb, (acc.sqftDist.get(sb) || 0) + 1)
  }
  const p = c.price[i]
  if (f & F.PRICED) acc.priced += 1
  if (f & F.INVESTOR) acc.investor += 1
  if (f & F.BUYER_KNOWN) acc.buyerKnown += 1
  if (f & F.CASH_KNOWN) { acc.cashKnown += 1; if (f & F.CASH) acc.cash += 1 }
  if ((f & F.QUALIFIED) && p > 0) {
    acc.qualified += 1
    acc.prices.push(p)
    const ps = c.ppsf[i]
    if (ps > 0) acc.ppsf.push(ps)
    const u = c.units[i]
    const sq = c.sqft[i]
    if (isPricePerUnitEvidence({ price: p, units: u, sqft: Number.isFinite(sq) ? sq : null, assetCode: a })) acc.ppu.push(p / u)
    if (f & F.INVESTOR) acc.invPrices.push(p)
  }
  const b = c.buyer[i]
  if (b >= 0) {
    if (index.buyerLender[b]) acc.lenderPurchases += 1
    else if (index.buyerListable[b]) {
      acc.namedPurchases += 1
      addBuyer(acc.buyers, b, { day: d, price: p, qualified: Boolean(f & F.QUALIFIED), assetCode: a })
    }
  }
}

export function aggregate(index, src, win) {
  const acc = newAcc()
  forEachRow(src, (i) => addRow(acc, index, i, win))
  return acc
}

/**
 * Group the rows of `src` by a child key function → Map(childKey → acc).
 * childOf(i) returns an int key or -1 (row has no child at that level).
 */
export function aggregateBy(index, src, win, childOf) {
  const out = new Map()
  forEachRow(src, (i) => {
    const k = childOf(i)
    if (k < 0) return
    let acc = out.get(k)
    if (!acc) { acc = newAcc(); out.set(k, acc) }
    addRow(acc, index, i, win)
  })
  return out
}

/** Per-month series for trends: month → { sales, investor, buyerKnown, cash, cashKnown, prices[], ppsf[] }. */
export function monthlySeries(index, src, codes) {
  const c = index.cols
  const out = new Map()
  forEachRow(src, (i) => {
    if (codes && !codes.has(c.asset[i])) return
    const mo = c.month[i]
    let s = out.get(mo)
    if (!s) { s = { sales: 0, investor: 0, buyerKnown: 0, cash: 0, cashKnown: 0, entityAcq: 0, prices: [], ppsf: [] }; out.set(mo, s) }
    const f = c.flags[i]
    s.sales += 1
    if (f & F.INVESTOR) s.investor += 1
    if (f & F.BUYER_KNOWN) s.buyerKnown += 1
    if (f & F.CASH_KNOWN) { s.cashKnown += 1; if (f & F.CASH) s.cash += 1 }
    const b = c.buyer[i]
    if (b >= 0 && index.buyerListable[b]) s.entityAcq += 1
    const p = c.price[i]
    if ((f & F.QUALIFIED) && p > 0) { s.prices.push(p); if (c.ppsf[i] > 0) s.ppsf.push(c.ppsf[i]) }
  })
  return out
}

/** National monthly counts (for the coverage window). */
export function nationalMonthCounts(index) {
  const out = new Map()
  const mo = index.cols.month
  for (let i = 0; i < index.n; i += 1) out.set(mo[i], (out.get(mo[i]) || 0) + 1)
  return out
}
