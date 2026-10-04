/**
 * MARKET INTELLIGENCE: metric values. Pure: accumulators / summaries in,
 * registry-keyed values out.
 *
 * Every value is { value, n, status, reason?, coverage?, basis? }:
 *   status 'ok'           value is supported by its sample
 *   status 'insufficient' sample below the registry minimum (value withheld)
 *   status 'unavailable'  no source for this geography / asset / window
 *   status 'not_loaded'   source exists but was not read yet (seller universe)
 * A withheld value is null. The UI never shows a number for anything but 'ok'.
 */
import { METRIC_BY_ID } from './mi-metric-registry.js'
import { medianOf } from './mi-sales-index.js'
import { completeMonthsIn, growthWindows, monthOfDay } from './mi-periods.js'

const ok = (value, n, extra = {}) => ({ value, n, status: 'ok', ...extra })
const insufficient = (n, min, extra = {}) => ({ value: null, n, status: 'insufficient', reason: `Insufficient sample: ${n} of ${min} needed`, ...extra })
export const unavailable = (reason, extra = {}) => ({ value: null, n: 0, status: 'unavailable', reason, ...extra })

function gated(id, value, n, extra = {}) {
  const min = METRIC_BY_ID[id]?.min_sample ?? 1
  if (n < min) return insufficient(n, min, extra)
  if (value === null || value === undefined || !Number.isFinite(value)) return unavailable('No value', { n, ...extra })
  return ok(value, n, extra)
}

const monthsSum = (acc, from, to) => {
  let t = 0
  for (const [m, n] of acc.months) if (m >= from && m <= to) t += n
  return t
}

/** Sales-derived metrics for one accumulator. ctx = { window, periodId, coverage }. Medians sort the acc arrays. */
export function salesValues(acc, ctx) {
  const v = {}
  v.sales_count = ok(acc.sales, acc.sales)
  v.priced_sale_count = ok(acc.priced, acc.sales)
  v.qualified_sale_count = ok(acc.qualified, acc.sales)
  v.median_sale_price = gated('median_sale_price', medianOf(acc.prices), acc.prices.length)
  v.median_ppsf = gated('median_ppsf', medianOf(acc.ppsf), acc.ppsf.length)
  v.median_price_per_unit = gated('median_price_per_unit', medianOf(acc.ppu), acc.ppu.length)
  v.mf_sale_count = ok(acc.mfSales, acc.sales)

  const months = completeMonthsIn(ctx.window.from, ctx.window.to, ctx.coverage)
  if (!months.length) v.monthly_sales_rate = unavailable('No complete, covered month in the period')
  else {
    const total = months.reduce((t, m) => t + (acc.months.get(m) || 0), 0)
    v.monthly_sales_rate = ok(total / months.length, months.length, { basis: `${months.length} complete month${months.length === 1 ? '' : 's'}` })
  }

  const g = growthWindows(ctx.periodId, ctx.coverage)
  if (!g.valid) v.sales_growth = unavailable(`No valid baseline: ${g.reason}`)
  else {
    const cur = monthsSum(acc, monthOfDay(g.current.from), monthOfDay(g.current.to))
    const prior = monthsSum(acc, monthOfDay(g.prior.from), monthOfDay(g.prior.to))
    const basis = `${g.current.label} vs ${g.prior.label} (complete months)`
    const min = METRIC_BY_ID.sales_growth.min_sample
    if (prior < min || cur < min) v.sales_growth = insufficient(Math.min(prior, cur), min, { basis })
    else v.sales_growth = ok(cur / prior - 1, prior, { basis, current: cur, prior })
  }

  v.investor_purchase_count = ok(acc.investor, acc.sales)
  v.investor_purchase_share = gated('investor_purchase_share', acc.buyerKnown ? acc.investor / acc.buyerKnown : null, acc.buyerKnown,
    { coverage: acc.sales ? acc.buyerKnown / acc.sales : 0, basis: `${acc.investor} of ${acc.buyerKnown} sales with a recorded buyer` })
  v.buyer_evidence_coverage = acc.sales ? ok(acc.buyerKnown / acc.sales, acc.sales) : unavailable('No sales in the period')
  v.cash_purchase_count = ok(acc.cash, acc.sales)
  v.cash_purchase_share = gated('cash_purchase_share', acc.cashKnown ? acc.cash / acc.cashKnown : null, acc.cashKnown,
    { coverage: acc.sales ? acc.cashKnown / acc.sales : 0, basis: `${acc.cash} of ${acc.cashKnown} sales with cash evidence` })
  v.cash_evidence_coverage = acc.sales ? ok(acc.cashKnown / acc.sales, acc.sales) : unavailable('No sales in the period')
  v.entity_owned_count = ok(acc.entity, acc.entity, { basis: 'Current state, not windowed' })

  const counts = [...acc.buyers.values()].map((b) => b.n).sort((a, b) => b - a)
  v.company_buyer_count = ok(counts.length, acc.namedPurchases)
  v.repeat_buyer_count = ok(counts.filter((n) => n >= 2).length, acc.namedPurchases)
  const top5 = counts.slice(0, 5).reduce((t, n) => t + n, 0)
  v.top5_buyer_share = gated('top5_buyer_share', acc.namedPurchases ? top5 / acc.namedPurchases : null, acc.namedPurchases, { basis: `${top5} of ${acc.namedPurchases} named-company purchases` })
  v.median_investor_price = gated('median_investor_price', medianOf(acc.invPrices), acc.invPrices.length)
  return v
}

const UNIVERSE_IDS = ['seller_record_count', 'phone_on_file_count', 'sms_eligible_count', 'queue_eligible_count', 'email_eligible_count', 'suppressed_count', 'recent_contact_hold_count', 'in_queue_count']

/** Universe metrics from summarizeUniverse(), or a not-loaded / unavailable state. */
export function universeValues(summary, statusWhenMissing = 'not_loaded', reason = 'Seller universe not loaded for this state yet') {
  const v = {}
  for (const id of UNIVERSE_IDS) {
    v[id] = summary ? ok(summary[id], summary.seller_record_count) : { value: null, n: 0, status: statusWhenMissing, reason }
  }
  return v
}

/** Property-stock metrics from an mv_map_property_area_stats row ({n, equity, value, …}). */
export function stockValues(row, propertyCount) {
  const v = {}
  v.property_count = propertyCount === null || propertyCount === undefined ? unavailable('Not in the property universe') : ok(propertyCount, propertyCount)
  const map = { avg_equity_pct: 'equity', avg_estimated_value: 'value', avg_year_built: 'year_built', tax_delinquent_share: 'tax_delinquent', free_clear_share: 'free_clear', avg_distress_score: 'distress' }
  for (const [id, col] of Object.entries(map)) {
    if (!row) { v[id] = unavailable('Property averages exist for ZIP, county, state and nation only'); continue }
    const n = Number(row.n) || 0
    const val = row[col] === null || row[col] === undefined ? null : Number(row[col])
    v[id] = gated(id, val, n, { basis: `mean over ${n.toLocaleString('en-US')} properties` })
  }
  return v
}

const ACS_CELL = {
  median_household_income: 'median_household_income', median_gross_rent: 'median_gross_rent', vacancy_rate: 'vacancy_rate', renter_share: 'renter_share',
  owner_share: 'owner_share', acs_median_year_built: 'median_year_built', rent_burden: 'rent_burden', units_2_4_share: 'units_2_4_share', units_5plus_share: 'units_5plus_share',
}
const ACS_SUM = ['population', 'households', 'housing_units']

/**
 * Census values. `cell` = the geography's own ACS cell (zip/county/city/state),
 * or null. `members` = { cells, expected } for sum-only geographies (market, nation).
 */
export function censusValues(cell, members = null) {
  const v = {}
  for (const id of ACS_SUM) {
    if (cell && cell[id] !== null && cell[id] !== undefined) v[id] = ok(Number(cell[id]), 1, { basis: `ACS ${cell.vintage ?? ''} 5-year`.trim() })
    else if (members && members.cells.length) {
      const vals = members.cells.map((c) => c[id]).filter((x) => x !== null && x !== undefined && Number.isFinite(Number(x)))
      v[id] = vals.length ? ok(vals.reduce((t, x) => t + Number(x), 0), vals.length, { basis: `sum of ${vals.length} ACS ZIP cells`, coverage: members.expected ? vals.length / members.expected : null }) : unavailable('No ACS cells')
    } else v[id] = unavailable('No ACS cell for this geography')
  }
  for (const [id, col] of Object.entries(ACS_CELL)) {
    if (cell && cell[col] !== null && cell[col] !== undefined && Number.isFinite(Number(cell[col]))) v[id] = ok(Number(cell[col]), 1, { basis: `ACS ${cell.vintage ?? ''} 5-year`.trim() })
    else v[id] = unavailable(cell ? 'Not reported for this geography' : members ? 'A median cannot be summed across ZIPs; open a ZIP, city, county or state' : 'No ACS cell for this geography')
  }
  return v
}

/** Top company buyers (listable names only), most active first. */
export function topBuyers(acc, index, assetLabel, limit = 10) {
  const out = []
  for (const [b, e] of acc.buyers) out.push({ name: index.dicts.buyers[b], purchases: e.n, priced_volume: e.vol, priced_n: e.pn, last_purchase_day: e.last, assets: Object.entries(e.assets).map(([code, n]) => ({ asset: assetLabel(Number(code)), n })).sort((x, y) => y.n - x.n) })
  out.sort((x, y) => (y.purchases - x.purchases) || (y.priced_volume - x.priced_volume) || x.name.localeCompare(y.name))
  return out.slice(0, limit)
}

/** Standard competition ranking (1, 2, 2, 4) over ok values; others unranked. */
export function rankRows(rows, metricId, dir = 'desc') {
  const ranked = rows.filter((r) => r.values[metricId]?.status === 'ok')
  const rest = rows.filter((r) => r.values[metricId]?.status !== 'ok')
  const sign = dir === 'asc' ? 1 : -1
  ranked.sort((a, b) => (sign * (a.values[metricId].value - b.values[metricId].value)) || ((b.values[metricId].n ?? 0) - (a.values[metricId].n ?? 0)) || a.label.localeCompare(b.label))
  let prev = null
  let prevRank = 0
  ranked.forEach((r, i) => {
    const val = r.values[metricId].value
    const rank = prev !== null && val === prev ? prevRank : i + 1
    r.rank = rank
    prev = val
    prevRank = rank
  })
  rest.sort((a, b) => ((b.values.sales_count?.value ?? 0) - (a.values.sales_count?.value ?? 0)) || a.label.localeCompare(b.label))
  rest.forEach((r) => { r.rank = null })
  return { ranked, unranked: rest }
}

/** Screener filter evaluation. Pure. A filter on a non-ok value never passes. */
export function passesFilters(row, filters, match = 'all') {
  if (!filters.length) return true
  const test = (f) => {
    const v = row.values[f.metric]
    if (!v || v.status !== 'ok') return false
    const x = v.value
    switch (f.op) {
      case 'gte': return x >= f.value
      case 'lte': return x <= f.value
      case 'gt': return x > f.value
      case 'lt': return x < f.value
      case 'eq': return x === f.value
      default: return false
    }
  }
  return match === 'any' ? filters.some(test) : filters.every(test)
}
