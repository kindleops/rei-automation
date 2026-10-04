/**
 * MARKET INTELLIGENCE: the finalized aggregate. ONE shape, two producers:
 *   - aggFromSummaryRow(): a mi_geo_period_rollup row (production path)
 *   - finalizeAcc():       the dev-only raw index accumulator
 * salesValues() (mi-metric-values.js) reads only this shape, so the summary and
 * the raw computation can be proven identical on the same rows.
 *
 *   agg = { sales, priced, qualified, mls, mfSales, investor, buyerKnown, cashKnown, cash, entity,
 *           latestDay, med: { price, ppsf, ppu, inv } each { v, n }, deciles: [{q, value}] | null,
 *           assetMix: Map(code → n), unitDist: Map(label → n), sqftDist: Map(label → n),
 *           buyers: Map(buyerIdx → {n, vol, pn, last, assets}), namedPurchases, lenderPurchases,
 *           rateSum, curSum, priorSum }   (the three window sums are attached by the source)
 */
import { ASSET_CODE } from './mi-asset-classes.js'
import { dayOfDate } from './mi-periods.js'

export const DECILE_QS = Object.freeze([0.1, 0.25, 0.5, 0.75, 0.9])
export const UNIT_LABELS = Object.freeze(['2', '3', '4', '5–9', '10–19', '20–49', '50+'])
export const SQFT_LABELS = Object.freeze(['< 2K', '2–4K', '4–8K', '8–20K', '20K+'])
export const NOT_RECORDED = 'not recorded'

/** Unit bucket on the ROUNDED recorded unit count; < 2 or missing = not recorded (same as the SQL). */
export function unitBucket(units) {
  if (!Number.isFinite(units) || !(units > 1)) return NOT_RECORDED
  const r = Math.round(units)
  if (r < 2) return NOT_RECORDED
  if (r <= 4) return String(r)
  if (r <= 9) return '5–9'
  if (r <= 19) return '10–19'
  if (r <= 49) return '20–49'
  return '50+'
}
/** Building-size bucket, half-open bounds (same as the SQL). */
export function sqftBucket(sqft) {
  if (!Number.isFinite(sqft) || !(sqft > 0)) return NOT_RECORDED
  if (sqft < 2000) return '< 2K'
  if (sqft < 4000) return '2–4K'
  if (sqft < 8000) return '4–8K'
  if (sqft < 20000) return '8–20K'
  return '20K+'
}

/** Exact median (percentile_cont(0.5)). Sorts in place. */
export function medianOf(values) {
  const n = values.length
  if (!n) return null
  values.sort((x, y) => x - y)
  const h = n >> 1
  return n % 2 ? values[h] : (values[h - 1] + values[h]) / 2
}
/** percentile_disc semantics: the first value whose cumulative share reaches q. */
export function percentileDisc(sorted, q) {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]
}

/** Buyer accumulation, shared by both paths (privacy/lender policy decided per name by the caller). */
export function addBuyer(buyers, b, { day, price, qualified, assetCode }) {
  const counted = qualified && price > 0
  const e = buyers.get(b)
  if (e) {
    e.n += 1
    if (counted) { e.vol += price; e.pn += 1 }
    if (day > e.last) e.last = day
    e.assets[assetCode] = (e.assets[assetCode] || 0) + 1
  } else buyers.set(b, { n: 1, vol: counted ? price : 0, pn: counted ? 1 : 0, last: day, assets: { [assetCode]: 1 } })
}

const emptyBuyerStats = () => ({ buyers: new Map(), namedPurchases: 0, lenderPurchases: 0 })

/** Raw accumulator (mi-sales-index newAcc/addRow) → agg. */
export function finalizeAcc(acc) {
  const prices = [...acc.prices].sort((a, b) => a - b)
  return {
    sales: acc.sales, priced: acc.priced, qualified: acc.qualified, mls: acc.mls, mfSales: acc.mfSales, investor: acc.investor,
    buyerKnown: acc.buyerKnown, cashKnown: acc.cashKnown, cash: acc.cash, entity: acc.entity, latestDay: acc.latestDay,
    med: {
      price: { v: medianOf([...acc.prices]), n: acc.prices.length },
      ppsf: { v: medianOf([...acc.ppsf]), n: acc.ppsf.length },
      ppu: { v: medianOf([...acc.ppu]), n: acc.ppu.length },
      inv: { v: medianOf([...acc.invPrices]), n: acc.invPrices.length },
    },
    deciles: prices.length >= 10 ? DECILE_QS.map((q) => ({ q, value: percentileDisc(prices, q) })) : null,
    assetMix: acc.assetMix, unitDist: acc.unitDist, sqftDist: acc.sqftDist,
    buyers: acc.buyers, namedPurchases: acc.namedPurchases, lenderPurchases: acc.lenderPurchases,
    months: acc.months,
  }
}

const MIX_COLS = [['n_sfr', 'sfr'], ['n_mf_2_4', 'mf_2_4'], ['n_mf_5_plus', 'mf_5_plus'], ['n_mf_unknown', 'mf_unknown'], ['n_land', 'land'], ['n_commercial', 'commercial'], ['n_other_res', 'other_res'], ['n_unknown', 'unknown']]
const UNIT_COLS = [['u_2', '2'], ['u_3', '3'], ['u_4', '4'], ['u_5_9', '5–9'], ['u_10_19', '10–19'], ['u_20_49', '20–49'], ['u_50p', '50+'], ['u_unrec', NOT_RECORDED]]
const SQFT_COLS = [['s_lt2k', '< 2K'], ['s_2_4k', '2–4K'], ['s_4_8k', '4–8K'], ['s_8_20k', '8–20K'], ['s_20kp', '20K+'], ['s_unrec', NOT_RECORDED]]
const int = (v) => (v === null || v === undefined ? 0 : Number(v) || 0)
const numOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)

/** A mi_geo_period_rollup row → agg (buyer stats attached separately from mi_buyer_activity). */
export function aggFromSummaryRow(r, buyerStats = emptyBuyerStats()) {
  if (!r) return emptyAgg(buyerStats)
  const nonZero = (cols) => new Map(cols.map(([c, k]) => [k, int(r[c])]).filter(([, n]) => n > 0))
  const deciles = Array.isArray(r.price_deciles) && int(r.qualified_sale_count) >= 10 ? DECILE_QS.map((q, i) => ({ q, value: Number(r.price_deciles[i]) })) : null
  return {
    sales: int(r.sale_count), priced: int(r.priced_sale_count), qualified: int(r.qualified_sale_count), mls: int(r.mls_count), mfSales: int(r.mf_sale_count),
    investor: int(r.investor_count), buyerKnown: int(r.buyer_known_count), cashKnown: int(r.cash_known_count), cash: int(r.cash_count), entity: int(r.entity_owned_count),
    latestDay: r.latest_sale ? dayOfDate(String(r.latest_sale).slice(0, 10)) : null,
    med: {
      price: { v: numOrNull(r.median_price), n: int(r.qualified_sale_count) },
      ppsf: { v: numOrNull(r.median_ppsf), n: int(r.ppsf_n) },
      ppu: { v: numOrNull(r.median_ppu), n: int(r.ppu_n) },
      inv: { v: numOrNull(r.median_inv_price), n: int(r.inv_price_n) },
    },
    deciles,
    assetMix: new Map(MIX_COLS.map(([c, k]) => [ASSET_CODE[k], int(r[c])]).filter(([, n]) => n > 0)),
    unitDist: nonZero(UNIT_COLS), sqftDist: nonZero(SQFT_COLS),
    ...buyerStats,
  }
}

export function emptyAgg(buyerStats = emptyBuyerStats()) {
  return { sales: 0, priced: 0, qualified: 0, mls: 0, mfSales: 0, investor: 0, buyerKnown: 0, cashKnown: 0, cash: 0, entity: 0, latestDay: null,
    med: { price: { v: null, n: 0 }, ppsf: { v: null, n: 0 }, ppu: { v: null, n: 0 }, inv: { v: null, n: 0 } }, deciles: null,
    assetMix: new Map(), unitDist: new Map(), sqftDist: new Map(), ...buyerStats }
}

/** Sum of a month → count map over [from, to] (inclusive month ints). */
export function monthSum(months, from, to) {
  let t = 0
  for (const [m, n] of months) if (m >= from && m <= to) t += n
  return t
}
