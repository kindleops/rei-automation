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
import { monthSum } from './mi-agg.js'
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

/**
 * The month windows a period needs, decided once per (period, coverage): the complete
 * months inside the period (velocity) and the two equal growth windows. Pure.
 */
export function periodWindows(ctx) {
  const rateMonths = completeMonthsIn(ctx.window.from, ctx.window.to, ctx.coverage)
  const g = growthWindows(ctx.periodId, ctx.coverage)
  return {
    rate: rateMonths.length ? { from: rateMonths[0], to: rateMonths[rateMonths.length - 1], months: rateMonths.length } : null,
    growth: g,
    cur: g.valid ? { from: monthOfDay(g.current.from), to: monthOfDay(g.current.to) } : null,
    prior: g.valid ? { from: monthOfDay(g.prior.from), to: monthOfDay(g.prior.to) } : null,
  }
}

/** Window sums from a month → sales map (raw path, or one geography's month rows). */
export function windowSumsFromMonths(months, pw) {
  const sum = (w) => (w ? monthSum(months, w.from, w.to) : 0)
  return { rateSum: sum(pw.rate), curSum: sum(pw.cur), priorSum: sum(pw.prior) }
}

/**
 * Sales-derived metrics for one finalized aggregate (mi-agg.js). ctx = { window, periodId, coverage }.
 * The aggregate carries rateSum / curSum / priorSum for the windows of periodWindows(ctx),
 * or a `months` map they are computed from.
 */
export function salesValues(agg, ctx) {
  const pw = ctx.windows || periodWindows(ctx)
  const sums = agg.months ? windowSumsFromMonths(agg.months, pw) : { rateSum: agg.rateSum ?? 0, curSum: agg.curSum ?? 0, priorSum: agg.priorSum ?? 0 }
  const v = {}
  v.sales_count = ok(agg.sales, agg.sales)
  v.priced_sale_count = ok(agg.priced, agg.sales)
  v.qualified_sale_count = ok(agg.qualified, agg.sales)
  v.median_sale_price = gated('median_sale_price', agg.med.price.v, agg.med.price.n)
  v.median_ppsf = gated('median_ppsf', agg.med.ppsf.v, agg.med.ppsf.n)
  v.median_price_per_unit = gated('median_price_per_unit', agg.med.ppu.v, agg.med.ppu.n)
  v.mf_sale_count = ok(agg.mfSales, agg.sales)

  if (!pw.rate) v.monthly_sales_rate = unavailable('No complete, covered month in the period')
  else v.monthly_sales_rate = ok(sums.rateSum / pw.rate.months, pw.rate.months, { basis: `${pw.rate.months} complete month${pw.rate.months === 1 ? '' : 's'}` })

  const g = pw.growth
  if (!g.valid) v.sales_growth = unavailable(`No valid baseline: ${g.reason}`)
  else {
    const cur = sums.curSum
    const prior = sums.priorSum
    const basis = `${g.current.label} vs ${g.prior.label} (complete months)`
    const min = METRIC_BY_ID.sales_growth.min_sample
    if (prior < min || cur < min) v.sales_growth = insufficient(Math.min(prior, cur), min, { basis })
    else v.sales_growth = ok(cur / prior - 1, prior, { basis, current: cur, prior })
  }

  v.investor_purchase_count = ok(agg.investor, agg.sales)
  v.investor_purchase_share = gated('investor_purchase_share', agg.buyerKnown ? agg.investor / agg.buyerKnown : null, agg.buyerKnown,
    { coverage: agg.sales ? agg.buyerKnown / agg.sales : 0, basis: `${agg.investor} of ${agg.buyerKnown} sales with a recorded buyer` })
  v.buyer_evidence_coverage = agg.sales ? ok(agg.buyerKnown / agg.sales, agg.sales) : unavailable('No sales in the period')
  v.cash_purchase_count = ok(agg.cash, agg.sales)
  v.cash_purchase_share = gated('cash_purchase_share', agg.cashKnown ? agg.cash / agg.cashKnown : null, agg.cashKnown,
    { coverage: agg.sales ? agg.cashKnown / agg.sales : 0, basis: `${agg.cash} of ${agg.cashKnown} sales with cash evidence` })
  v.cash_evidence_coverage = agg.sales ? ok(agg.cashKnown / agg.sales, agg.sales) : unavailable('No sales in the period')
  v.entity_owned_count = ok(agg.entity, agg.entity, { basis: 'Current state, not windowed' })

  const counts = [...agg.buyers.values()].map((b) => b.n).sort((a, b) => b - a)
  v.company_buyer_count = ok(counts.length, agg.namedPurchases)
  v.repeat_buyer_count = ok(counts.filter((n) => n >= 2).length, agg.namedPurchases)
  const top5 = counts.slice(0, 5).reduce((t, n) => t + n, 0)
  v.top5_buyer_share = gated('top5_buyer_share', agg.namedPurchases ? top5 / agg.namedPurchases : null, agg.namedPurchases, { basis: `${top5} of ${agg.namedPurchases} named-company purchases` })
  v.median_investor_price = gated('median_investor_price', agg.med.inv.v, agg.med.inv.n)
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
export function topBuyers(acc, nameOf, assetLabel, limit = 10) {
  const out = []
  for (const [b, e] of acc.buyers) out.push({ name: nameOf(b), purchases: e.n, priced_volume: e.vol, priced_n: e.pn, last_purchase_day: e.last, assets: Object.entries(e.assets).map(([code, n]) => ({ asset: assetLabel(Number(code)), n })).sort((x, y) => y.n - x.n) })
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
