/**
 * ENTITY GRAPH · ZIP MARKET CONTEXT (owner, 2026-10-08: "for the property's
 * zip show sold count, active buyers, demographics").
 *
 * Sources (all keyed reads, read-only):
 *   mi_geo_period_rollup  the Market Intelligence rollup of the CURRENT ready
 *                         build (mi_rollup_builds.status = 'ready'), geo_level
 *                         zip, asset all, periods 90d / 1y: sales, investor
 *                         purchases, cash share, median price / $ per sqft,
 *                         latest sale. PK (build_id, geo_level, period, asset, geo_key).
 *   eg_buyer_index        buyers who bought in the zip (GIN on zips): how many,
 *                         how many still active.
 *   census_geo_metrics    zip demographics — EMPTY in prod (0 rows, measured
 *                         2026-10-08), so `demographics` is reported unavailable,
 *                         never invented.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

export const MAX_ZIPS = 120
const clean = (v) => String(v ?? '').trim()
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

let buildCache = { at: 0, id: null }
async function currentBuild(supabase, now = Date.now()) {
  if (buildCache.id !== null && now - buildCache.at < 10 * 60_000) return buildCache.id
  const { data, error } = await supabase.from('mi_rollup_builds').select('build_id, status').eq('status', 'ready').order('build_id', { ascending: false }).limit(1)
  if (error) throw error
  buildCache = { at: now, id: data?.[0]?.build_id ?? null }
  return buildCache.id
}
export const __zipContextTest = { reset: () => { buildCache = { at: 0, id: null } } }

export async function getEntityGraphZipContext(params = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const zips = [...new Set(String(params.zips ?? '').split(',').map((z) => clean(z).slice(0, 5)).filter((z) => /^\d{5}$/.test(z)))].slice(0, MAX_ZIPS)
  const out = {}
  if (!zips.length) return { zips: out, buildId: null }
  const buildId = await currentBuild(supabase)
  const [rollup, demographics] = await Promise.all([
    buildId === null ? Promise.resolve([]) : supabase.from('mi_geo_period_rollup')
      .select('geo_key, period, sale_count, investor_count, buyer_known_count, cash_known_count, cash_count, median_price, median_ppsf, median_inv_price, latest_sale, mf_sale_count')
      .eq('build_id', buildId).eq('geo_level', 'zip').eq('asset', 'all').in('period', ['90d', '1y']).in('geo_key', zips)
      .then(({ data, error }) => { if (error) throw error; return data || [] }),
    supabase.from('census_geo_metrics').select('zcta, median_household_income, total_population, owner_occupancy_rate, renter_rate, vacancy_rate, median_year_built, source_year').in('zcta', zips).order('source_year', { ascending: false })
      .then(({ data, error }) => (error ? [] : data || [])),
  ])
  for (const zip of zips) out[zip] = { zip, sales90d: null, sales1y: null, investorShare1y: null, cashShare1y: null, medianPrice1y: null, medianPpsf1y: null, medianInvestorPrice1y: null, latestSale: null, buyers: null, activeBuyers: null, demographics: null }
  for (const r of rollup) {
    const z = out[clean(r.geo_key)]
    if (!z) continue
    if (r.period === '90d') z.sales90d = num(r.sale_count)
    if (r.period === '1y') {
      z.sales1y = num(r.sale_count)
      const known = num(r.buyer_known_count)
      z.investorShare1y = known ? Math.round((num(r.investor_count) / known) * 100) : null
      const cashKnown = num(r.cash_known_count)
      z.cashShare1y = cashKnown ? Math.round((num(r.cash_count) / cashKnown) * 100) : null
      z.medianPrice1y = num(r.median_price)
      z.medianPpsf1y = num(r.median_ppsf)
      z.medianInvestorPrice1y = num(r.median_inv_price)
      z.latestSale = r.latest_sale || null
    }
  }
  for (const d of demographics) {
    const z = out[clean(d.zcta)]
    if (!z || z.demographics) continue
    z.demographics = { medianIncome: num(d.median_household_income), population: num(d.total_population), ownerOccupancy: num(d.owner_occupancy_rate), renterRate: num(d.renter_rate), vacancyRate: num(d.vacancy_rate), medianYearBuilt: num(d.median_year_built), year: num(d.source_year) }
  }
  // buyers per zip: GIN on eg_buyer_index.zips (~9 ms each) — only when asked, ≤ 40 zips
  const wantBuyers = ['1', 'true'].includes(clean(params.buyers))
  const counts = !wantBuyers ? [] : await Promise.all(zips.slice(0, 40).map(async (zip) => {
    const [all, active] = await Promise.all([
      supabase.from('eg_buyer_index').select('buyer_id', { count: 'exact', head: true }).overlaps('zips', [zip]),
      supabase.from('eg_buyer_index').select('buyer_id', { count: 'exact', head: true }).overlaps('zips', [zip]).eq('activity_status', 'active'),
    ])
    return [zip, all.error ? null : all.count ?? null, active.error ? null : active.count ?? null]
  }))
  for (const [zip, all, active] of counts) { out[zip].buyers = all; out[zip].activeBuyers = active }
  return { zips: out, buildId, demographicsAvailable: demographics.length > 0 }
}
