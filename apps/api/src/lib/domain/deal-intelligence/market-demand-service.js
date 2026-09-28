/**
 * AREA MARKET DEMAND — what the market is actually doing near one property,
 * for the SAME asset family. Read-only; independent of Buyer Match.
 *
 * The SQL read model `public.deal_market_demand(p_property_id, p_radius_miles,
 * p_months)` (migration 20260927200000) does all the counting and pricing over
 * `mv_map_sold_comps`. This module only calls it (service role — the RPC is not
 * executable by anon/authenticated) and reshapes the payload for the UI:
 * camelCase keys, numbers as numbers, null wherever the value is unknown.
 *
 * Semantics carried from SQL (do not re-derive here):
 *   - a SALE is any same-family transfer in the radius/window; only PRICED
 *     sales feed price statistics (unpriced transfers still count as volume
 *     and toward buyer mix).
 *   - portfolio sales are priced per door, never at the package price.
 *   - outliers are excluded and counted by reason (excludedByReason).
 *   - the radius widens 1.5 -> 3 -> 5 -> 10 mi until the priced-sales target
 *     (8; 5 for apartments) is met; radius.used is the radius actually used.
 *   - investor / retail / nonInvestor definitions travel with the payload.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const int = (v) => { const n = num(v); return n === null ? null : Math.round(n) }
const count = (v) => int(v) ?? 0
const str = (v) => { const s = String(v ?? '').trim(); return s || null }
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const arr = (v) => (Array.isArray(v) ? v : [])
const bool = (v) => v === true

const DAY = 86_400_000

export const FAMILY_LABELS = Object.freeze({
  residential_1: 'Single family',
  condo: 'Condo',
  multifamily: 'Multifamily (2–4)',
  apartment: 'Apartments (5+)',
  land: 'Land',
  mobile_home: 'Mobile home',
  commercial: 'Commercial',
  other: 'Other',
  unknown: 'Unknown',
})

export const SOURCE_LABELS = Object.freeze({
  mls: 'MLS',
  public_record: 'Public record',
  investor: 'Investor purchases',
})

export const BUYER_GROUP_LABELS = Object.freeze({
  company_llc: 'LLC / company',
  institutional: 'Institutional / fund',
  portfolio: 'Portfolio buyer',
  builder: 'Builder',
  individual: 'Individual',
  bank_government: 'Bank / government',
  unknown: 'Buyer not on record',
})

const EXCLUSION_LABELS = Object.freeze({
  price_under_10k: 'Price under $10k',
  price_over_20x_subject_value: 'Over 20× subject value',
  price_under_5pct_subject_value: 'Under 5% of subject value',
  ppsf_out_of_range: '$/sqft outside $8–$2,500',
  price_far_from_area_median: 'Price > 6× from area median',
  ppsf_far_from_area_median: '$/sqft > 4× from area median',
})

function shapeSegment(v) {
  const s = obj(v)
  return {
    count: count(s.count),
    priced: count(s.priced),
    medianPrice: int(s.median_price),
    medianPpsf: int(s.median_ppsf),
    medianPpu: int(s.median_ppu),
  }
}

/**
 * Pure: raw jsonb from deal_market_demand -> UI shape.
 * `now` (ms) only drives the staleness figure.
 */
export function shapeMarketDemand(raw, { now = Date.now() } = {}) {
  const r = obj(raw)
  if (r.ok !== true) {
    return {
      ok: false,
      propertyId: str(r.property_id),
      error: str(r.error) || 'market_demand_unavailable',
    }
  }

  const subject = obj(r.subject)
  const family = str(subject.family) || 'unknown'
  const overall = obj(r.overall)
  const ivr = obj(r.investor_vs_retail)
  const win = obj(r.window)
  const band = obj(r.units_band)

  const requested = num(r.radius_requested)
  const used = num(r.radius_used)
  const dataThrough = str(r.data_through)
  const throughMs = dataThrough ? Date.parse(dataThrough) : NaN
  const dataAgeDays = Number.isFinite(throughMs) ? Math.max(0, Math.floor((now - throughMs) / DAY)) : null

  const totalSales = count(r.total_sales)
  const pricedSales = count(r.priced_sales)
  const excludedByReason = Object.entries(obj(r.excluded_by_reason))
    .map(([reason, n]) => ({ reason, label: EXCLUSION_LABELS[reason] || reason, count: count(n) }))
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))

  return {
    ok: true,
    propertyId: str(r.property_id),
    subject: {
      family,
      familyLabel: FAMILY_LABELS[family] || family,
      propertyType: str(subject.property_type),
      units: num(subject.units),
      sqft: num(subject.sqft),
      estimatedValue: num(subject.estimated_value),
      zip: str(subject.zip),
      city: str(subject.city),
      state: str(subject.state),
    },
    radius: {
      requested,
      used,
      widened: requested !== null && used !== null && used > requested,
      minSalesTarget: int(r.min_sales_target),
      tiers: arr(r.radius_tiers).map((t) => ({
        radius: num(t?.radius),
        sales: count(t?.sales),
        priced: count(t?.priced),
        pricedInBand: count(t?.priced_in_band),
      })),
    },
    unitsBand: {
      applied: bool(band.applied),
      min: num(band.min),
      max: num(band.max),
    },
    window: {
      months: int(r.months),
      since: str(win.since),
      until: str(win.until),
      dataThrough,
      dataAgeDays,
    },
    totals: {
      sales: totalSales,
      pricedSales,
      unpricedSales: Math.max(0, totalSales - pricedSales),
      excludedOutliers: count(r.excluded_outliers),
      excludedByReason,
    },
    overall: {
      medianPrice: int(overall.median_price),
      avgPrice: int(overall.avg_price),
      p25Price: int(overall.p25_price),
      p75Price: int(overall.p75_price),
      medianPpsf: int(overall.median_ppsf),
      ppsfSample: count(overall.ppsf_sample),
      medianPpu: int(overall.median_ppu),
      ppuSample: count(overall.ppu_sample),
      medianBeds: num(overall.median_beds),
      medianSqft: int(overall.median_sqft),
      medianUnits: num(overall.median_units),
      medianYearBuilt: int(overall.median_year_built),
      medianDistanceMiles: num(overall.median_distance_miles),
      buyerKnownShare: num(overall.buyer_known_share),
      portfolioDoors: count(overall.portfolio_doors),
      portfolioTransactions: count(overall.portfolio_transactions),
      latestSaleOn: str(overall.latest_sale_on),
      earliestSaleOn: str(overall.earliest_sale_on),
    },
    bySource: arr(r.by_source).map((s) => ({
      source: str(s?.source),
      label: SOURCE_LABELS[s?.source] || str(s?.source),
      count: count(s?.count),
      priced: count(s?.priced),
      share: num(s?.share),
      medianPrice: int(s?.median_price),
      medianPpsf: int(s?.median_ppsf),
    })),
    byBuyer: arr(r.by_buyer).map((b) => ({
      group: str(b?.group),
      label: BUYER_GROUP_LABELS[b?.group] || str(b?.group),
      count: count(b?.count),
      priced: count(b?.priced),
      share: num(b?.share),
      medianPrice: int(b?.median_price),
      medianPpsf: int(b?.median_ppsf),
      outOfStateShare: num(b?.out_of_state_share),
    })),
    investorVsRetail: {
      investor: shapeSegment(ivr.investor),
      retail: shapeSegment(ivr.retail),
      nonInvestor: shapeSegment(ivr.non_investor),
      unclassifiedCount: count(ivr.unclassified_count),
      nonMarketCount: count(ivr.non_market_count),
      minSample: int(ivr.min_sample),
      discountPct: num(ivr.discount_pct),
      ppsfDiscountPct: num(ivr.ppsf_discount_pct),
      discountVsNonInvestorPct: num(ivr.discount_vs_non_investor_pct),
      definitions: Object.fromEntries(
        Object.entries(obj(ivr.definitions)).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), str(v)]),
      ),
    },
    trend: arr(r.trend).map((q) => ({
      quarter: str(q?.quarter),
      quarterStart: str(q?.quarter_start),
      count: count(q?.count),
      priced: count(q?.priced),
      medianPrice: int(q?.median_price),
      medianPpsf: int(q?.median_ppsf),
      investorCount: count(q?.investor_count),
    })),
    zips: arr(r.zips).map((z) => ({
      zip: str(z?.zip),
      count: count(z?.count),
      priced: count(z?.priced),
      medianPrice: int(z?.median_price),
      medianPpsf: int(z?.median_ppsf),
      isSubjectZip: bool(z?.is_subject_zip),
    })),
    generatedAt: str(r.generated_at),
  }
}

const clampRadius = (v) => { const n = num(v); return n === null ? 1.5 : Math.min(10, Math.max(0.25, n)) }
const clampMonths = (v) => { const n = int(v); return n === null ? 12 : Math.min(60, Math.max(1, n)) }

export async function getMarketDemand({ propertyId, radiusMiles, months } = {}, deps = {}) {
  const client = deps.supabase || defaultSupabase
  const id = str(propertyId)
  if (!id) return { ok: false, propertyId: null, error: 'property_id_required' }

  const { data, error } = await client.rpc('deal_market_demand', {
    p_property_id: id,
    p_radius_miles: clampRadius(radiusMiles),
    p_months: clampMonths(months),
  })
  if (error) {
    return { ok: false, propertyId: id, error: 'market_demand_unavailable', detail: str(error.message) }
  }
  return shapeMarketDemand(data, { now: deps.now ?? Date.now() })
}
