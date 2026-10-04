/**
 * MARKET INTELLIGENCE: seller universe + property stock from the campaign
 * target graph (brief §20, §21). A SUMMARY ONLY.
 *
 * Campaign Composer computes the authoritative audience (owner rule
 * 2026-10-03). This module never decides eligibility: it counts the graph's
 * own flags (sms_eligible, queue_eligible, …) for a geography.
 *
 * Loaded per state on demand (indexed on state; FL, the largest, 4.4 s cold),
 * cached 6 h, single-flight, one state at a time. National seller figures are
 * only offered after the operator asks for every state.
 */
import { createAssetClassifier, ASSET_CODE } from './mi-asset-classes.js'
import { medianOf } from './mi-sales-index.js'

export const UNIVERSE_COLUMNS = Object.freeze(['property_id', 'zip', 'city', 'county', 'market', 'property_type', 'units', 'sms', 'queue', 'email', 'phone',
  'suppressed', 'wrong', 'hold', 'in_queue', 'never', 'corporate', 'beds', 'baths', 'sqft', 'year_built', 'lot', 'loan', 'years_owned', 'equity', 'value', 'phone_type'])
export const UNIVERSE_TTL_MS = 6 * 3600_000

const clean = (v) => String(v ?? '').trim()
const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)

/** Pure: shape array rows for one state into a compact store. */
export function shapeUniverse(state, rows, { classify = createAssetClassifier(), loadedAt = Date.now() } = {}) {
  const out = []
  for (const r of rows || []) {
    out.push({
      pid: clean(r[0]), zip: clean(r[1]).slice(0, 5), city: clean(r[2]), county: clean(r[3]).replace(/\s+(county|parish)$/, ''), market: clean(r[4]),
      asset: classify(r[5] ?? null, num(r[6])),
      sms: r[7] === true, queue: r[8] === true, email: r[9] === true, phone: r[10] === true,
      suppressed: r[11] === true || r[12] === true, hold: r[13] === true, inQueue: r[14] === true, never: r[15] === true, corporate: r[16] === true,
      beds: num(r[17]), baths: num(r[18]), sqft: num(r[19]), year: num(r[20]), lot: num(r[21]), loan: num(r[22]), years: num(r[23]), equity: num(r[24]), value: num(r[25]),
      phoneType: clean(r[26]) || null,
    })
  }
  return { state, rows: out, loadedAt }
}

/** Does a universe row belong to a geography? Pure. */
export function universeMatches(row, geo, markets) {
  switch (geo.level) {
    case 'state': case 'nation': return true
    case 'zip': return row.zip === geo.key
    case 'city': return `${geo.state}:${row.city}` === geo.key
    case 'county': return `${geo.state}:${row.county}` === geo.key
    case 'market': return Boolean(markets?.get(geo.key)) && row.market === markets.get(geo.key)
    default: return false
  }
}

const STOCK_FIELDS = Object.freeze([['beds', 'Beds'], ['baths', 'Baths'], ['sqft', 'Building sq ft'], ['year', 'Year built'], ['lot', 'Lot sq ft'], ['years', 'Years owned'], ['loan', 'Loan balance'], ['equity', 'Equity %'], ['value', 'Est. value']])

/** Pure: summarise matching rows. assetCodes null = all. */
export function summarizeUniverse(rows, { assetCodes = null } = {}) {
  const s = { seller_record_count: 0, property_ids: new Set(), phone_on_file_count: 0, sms_eligible_count: 0, queue_eligible_count: 0, email_eligible_count: 0,
    suppressed_count: 0, recent_contact_hold_count: 0, in_queue_count: 0, never_contacted_count: 0, corporate_owner_count: 0, phone_type_known: 0, types: new Map() }
  const vals = Object.fromEntries(STOCK_FIELDS.map(([k]) => [k, []]))
  for (const r of rows) {
    if (assetCodes && !assetCodes.has(r.asset)) continue
    s.seller_record_count += 1
    if (r.pid) s.property_ids.add(r.pid)
    if (r.phone) s.phone_on_file_count += 1
    if (r.sms) s.sms_eligible_count += 1
    if (r.queue) s.queue_eligible_count += 1
    if (r.email) s.email_eligible_count += 1
    if (r.suppressed) s.suppressed_count += 1
    if (r.hold) s.recent_contact_hold_count += 1
    if (r.inQueue) s.in_queue_count += 1
    if (r.never) s.never_contacted_count += 1
    if (r.corporate) s.corporate_owner_count += 1
    if (r.phoneType) s.phone_type_known += 1
    s.types.set(r.asset, (s.types.get(r.asset) || 0) + 1)
    for (const [k] of STOCK_FIELDS) { const v = r[k]; if (v !== null && Number.isFinite(v) && v > 0) vals[k].push(v) }
  }
  const total = s.seller_record_count
  const stock = STOCK_FIELDS.map(([k, label]) => {
    const n = vals[k].length
    return { field: k, label, median: n ? medianOf(vals[k]) : null, n, coverage: total ? n / total : 0 }
  })
  const types = [...s.types.entries()].map(([code, n]) => ({ code, n })).sort((a, b) => b.n - a.n)
  return {
    seller_record_count: total, property_count: s.property_ids.size, phone_on_file_count: s.phone_on_file_count, sms_eligible_count: s.sms_eligible_count,
    queue_eligible_count: s.queue_eligible_count, email_eligible_count: s.email_eligible_count, suppressed_count: s.suppressed_count,
    recent_contact_hold_count: s.recent_contact_hold_count, in_queue_count: s.in_queue_count, never_contacted_count: s.never_contacted_count,
    corporate_owner_count: s.corporate_owner_count, phone_type_coverage: total ? s.phone_type_known / total : 0, stock, types,
  }
}

/** Per-state cache with single-flight loads and a sequential queue (concurrency 1). */
export function createUniverseStore({ loader, clock = () => Date.now(), ttl = UNIVERSE_TTL_MS, classify = createAssetClassifier() } = {}) {
  const states = new Map()
  let chain = Promise.resolve()
  function status(st) {
    const e = states.get(st)
    if (!e) return 'not_loaded'
    if (e.value && e.expires > clock()) return 'ready'
    if (e.promise) return 'loading'
    if (e.error) return 'error'
    return 'stale'
  }
  function load(st) {
    const e = states.get(st)
    if (e?.value && e.expires > clock()) return Promise.resolve(e.value)
    if (e?.promise) return e.promise
    const entry = { ...(e || {}), promise: null, error: null }
    entry.promise = (chain = chain.then(async () => {
      const g = await loader.guard()
      if (!g.ok) throw Object.assign(new Error(g.reason), { code: 'db_busy' })
      const rows = await loader.universeForState(st)
      return shapeUniverse(st, rows, { classify, loadedAt: clock() })
    })).then((value) => { entry.value = value; entry.expires = clock() + ttl; entry.promise = null; return value },
      (error) => { entry.error = String(error?.message || error); entry.promise = null; throw error })
    chain = entry.promise.catch(() => null)
    states.set(st, entry)
    return entry.promise
  }
  const get = (st) => { const e = states.get(st); return e?.value && e.expires > clock() ? e.value : null }
  const loaded = () => [...states.entries()].filter(([, e]) => e.value && e.expires > clock()).map(([st]) => st)
  return { load, get, status, loaded }
}

export const ASSET_ALL = null
export { ASSET_CODE }
