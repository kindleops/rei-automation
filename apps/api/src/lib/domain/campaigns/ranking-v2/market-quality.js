// ─── ranking-v2/market-quality.js ────────────────────────────────────────────
// Acquisition OS §15 — MARKET QUALITY with a transparent formula.
//
// Sources (read-only, provenance carried on every output):
//   • mi_geo_period_rollup (geo_level='zip', period='1y', asset lane):
//       qualified_sale_count  → liquidity (sales velocity)
//       investor_count / buyer_known_count → investor share of KNOWN-buyer sales
//       median_price / median_ppsf / median_ppu / median_inv_price → context only
//   • mi_buyer_activity (is_investor, 36 months): distinct investor buyers in
//     the ZIP → buyer depth. Buyer names never leave the database; only the
//     distinct count is used (Buyer Match withholds company names).
//
// FORMULA  market_quality_v1  (every term 0–100; null = not measurable)
//   liquidity        = 100 · min(1, ln(1+qualified_sales_1y) / ln(1+LIQUIDITY_REF))
//   buyer_depth      = 100 · min(1, ln(1+distinct_investor_buyers_36m) / ln(1+BUYER_DEPTH_REF))
//   investor_activity= 100 · min(1, (investor_purchases_1y / buyer_known_1y) / INVESTOR_SHARE_REF)
//                      — only when buyer_known_1y ≥ MIN_KNOWN_BUYER_SALES, else null
//   market_quality   = Σ wᵢ·termᵢ / Σ wᵢ over the KNOWN terms (w: 0.40 / 0.40 / 0.20)
//                      — null when neither liquidity nor buyer depth is known
//   label            = strong ≥ 65 · moderate ≥ 40 · thin < 40
//
// The references are the observed ZIP distribution at 2026-10-07 (SFR, 1y):
// qualified sales p75 ≈ 210, p90 ≈ 388; distinct investor buyers p90 ≈ 20.
// They are constants, not fitted weights — change them here, in one place.

export const MARKET_QUALITY_VERSION = 'market_quality_v1'

export const MARKET_QUALITY_CONSTANTS = Object.freeze({
  LIQUIDITY_REF: 250,
  BUYER_DEPTH_REF: 20,
  INVESTOR_SHARE_REF: 0.5,
  MIN_KNOWN_BUYER_SALES: 8,
  WEIGHTS: Object.freeze({ liquidity: 0.4, buyer_depth: 0.4, investor_activity: 0.2 }),
  STRONG: 65,
  MODERATE: 40,
})

function num(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function logScale(value, ref) {
  const n = num(value)
  if (n === null || n < 0) return null
  return Math.round(100 * Math.min(1, Math.log1p(n) / Math.log1p(ref)))
}

/** Asset lane used to pick the MI rollup row for a property. */
export function marketAssetLane(row = {}) {
  const units = num(row.units_count ?? row.units)
  const type = String(row.property_type ?? row.canonical_property_group ?? '').toLowerCase()
  if (units !== null && units >= 5) return 'mf_5_plus'
  if (units !== null && units >= 2) return 'mf_2_4'
  if (/multi|duplex|triplex|fourplex|quadplex|apartment/.test(type)) return 'mf'
  if (/land|lot|vacant/.test(type)) return 'land'
  return 'sfr'
}

/**
 * @param {{zip:string, asset:string, qualified_sales_1y?:number|null, investor_purchases_1y?:number|null,
 *          buyer_known_1y?:number|null, cash_purchases_1y?:number|null, distinct_investor_buyers_36m?:number|null,
 *          median_price?:number|null, median_ppsf?:number|null, median_ppu?:number|null, median_inv_price?:number|null,
 *          latest_sale?:string|null, rollup_build_id?:string|number|null}} stats
 */
export function computeMarketQuality(stats = {}) {
  const C = MARKET_QUALITY_CONSTANTS
  const liquidity = logScale(stats.qualified_sales_1y, C.LIQUIDITY_REF)
  const buyerDepth = logScale(stats.distinct_investor_buyers_36m, C.BUYER_DEPTH_REF)
  const known = num(stats.buyer_known_1y)
  const inv = num(stats.investor_purchases_1y)
  const investorShare = known !== null && known >= C.MIN_KNOWN_BUYER_SALES && inv !== null ? inv / known : null
  const investorActivity = investorShare === null
    ? null
    : Math.round(100 * Math.min(1, investorShare / C.INVESTOR_SHARE_REF))

  const terms = { liquidity, buyer_depth: buyerDepth, investor_activity: investorActivity }
  let wSum = 0
  let acc = 0
  for (const [key, weight] of Object.entries(C.WEIGHTS)) {
    if (terms[key] === null) continue
    wSum += weight
    acc += weight * terms[key]
  }
  const measurable = liquidity !== null || buyerDepth !== null
  const score = measurable && wSum > 0 ? Math.round(acc / wSum) : null
  const label = score === null ? 'unknown' : score >= C.STRONG ? 'strong' : score >= C.MODERATE ? 'moderate' : 'thin'
  return {
    version: MARKET_QUALITY_VERSION,
    zip: stats.zip ?? null,
    asset: stats.asset ?? null,
    score,
    label,
    terms,
    inputs: {
      qualified_sales_1y: num(stats.qualified_sales_1y),
      investor_purchases_1y: inv,
      buyer_known_1y: known,
      cash_purchases_1y: num(stats.cash_purchases_1y),
      investor_share_known_buyers: investorShare === null ? null : Math.round(investorShare * 1000) / 1000,
      distinct_investor_buyers_36m: num(stats.distinct_investor_buyers_36m),
      median_price: num(stats.median_price),
      median_ppsf: num(stats.median_ppsf),
      median_ppu: num(stats.median_ppu),
      median_investor_price: num(stats.median_inv_price),
    },
    coverage: {
      terms_known: Object.values(terms).filter((v) => v !== null).length,
      terms_total: 3,
      investor_share_sample: known,
    },
    provenance: {
      rollup: 'mi_geo_period_rollup(zip,1y)',
      rollup_build_id: stats.rollup_build_id ?? null,
      buyers: 'mi_buyer_activity(is_investor,36m,distinct buyer)',
      latest_sale: stats.latest_sale ?? null,
    },
  }
}

/** Human, non-fabricated phrase for why-targeted / discovery rows. */
export function describeMarketQuality(mq) {
  if (!mq || mq.score === null) return null
  const parts = []
  if (mq.terms.buyer_depth !== null) {
    const n = mq.inputs.distinct_investor_buyers_36m
    parts.push(`${mq.terms.buyer_depth >= 65 ? 'strong' : mq.terms.buyer_depth >= 40 ? 'moderate' : 'thin'} buyer depth (${n} investor buyers/36m)`)
  }
  if (mq.terms.liquidity !== null) parts.push(`${mq.inputs.qualified_sales_1y} qualified sales/yr`)
  if (mq.terms.investor_activity !== null) {
    parts.push(`investor share ${Math.round(mq.inputs.investor_share_known_buyers * 100)}% of ${mq.inputs.buyer_known_1y} known-buyer sales`)
  }
  return parts.join(' · ')
}

/**
 * SET-BASED loader: one rollup read + one buyer-activity read for ALL zips in
 * the cohort. Never per row. `db.query(sql, params)` (pg) is preferred; a
 * Supabase client works through `.from()` with `in` filters.
 * Returns Map<`${zip}|${asset}`, MarketQuality>.
 */
export async function loadZipMarketQuality(zips = [], { db = null, supabase = null, assets = null } = {}) {
  const list = [...new Set((zips || []).map((z) => String(z ?? '').trim().slice(0, 5)).filter((z) => /^\d{5}$/.test(z)))]
  const out = new Map()
  if (!list.length) return out
  const lanes = assets || ['sfr', 'mf_2_4', 'mf_5_plus', 'mf', 'land', 'all']
  let rollups = []
  let buyers = []
  if (db?.query) {
    const r1 = await db.query(
      `select geo_key zip, asset, qualified_sale_count, investor_count, buyer_known_count, cash_count,
              median_price, median_ppsf, median_ppu, median_inv_price, latest_sale, build_id
         from public.mi_geo_period_rollup
        where build_id = (select max(build_id) from public.mi_geo_period_rollup)
          and geo_level = 'zip' and period = '1y' and geo_key = any($1) and asset = any($2)`,
      [list, lanes],
    )
    rollups = r1.rows
    const r2 = await db.query(
      `select zip, case when units >= 5 then 'mf_5_plus' when units >= 2 then 'mf_2_4' else 'sfr' end asset,
              count(distinct lower(trim(buyer)))::int buyers
         from public.mi_buyer_activity
        where build_id = (select max(build_id) from public.mi_buyer_activity)
          and is_investor and zip = any($1) and sold_on >= (current_date - interval '36 months')
        group by 1, 2`,
      [list],
    )
    buyers = r2.rows
  } else if (supabase?.from) {
    const { data: r1, error: e1 } = await supabase
      .from('mi_geo_period_rollup')
      .select('geo_key,asset,qualified_sale_count,investor_count,buyer_known_count,cash_count,median_price,median_ppsf,median_ppu,median_inv_price,latest_sale,build_id')
      .eq('geo_level', 'zip').eq('period', '1y').in('geo_key', list).in('asset', lanes)
    if (e1) throw e1
    const maxBuild = Math.max(...(r1 || []).map((r) => Number(r.build_id) || 0))
    rollups = (r1 || []).filter((r) => Number(r.build_id) === maxBuild).map((r) => ({ ...r, zip: r.geo_key }))
    // Buyer depth needs a distinct count; without the PROPOSED view it is
    // reported unknown rather than approximated from a capped page.
    buyers = []
  }
  const buyerMap = new Map()
  for (const b of buyers) {
    buyerMap.set(`${b.zip}|${b.asset}`, Number(b.buyers) || 0)
    buyerMap.set(`${b.zip}|all`, (buyerMap.get(`${b.zip}|all`) || 0) + (Number(b.buyers) || 0))
  }
  const buyerKnown = db?.query ? true : false
  for (const r of rollups) {
    const key = `${r.zip}|${r.asset}`
    const laneBuyers = buyerMap.get(key) ?? (r.asset === 'mf' ? (buyerMap.get(`${r.zip}|mf_2_4`) || 0) + (buyerMap.get(`${r.zip}|mf_5_plus`) || 0) : null)
    out.set(key, computeMarketQuality({
      zip: r.zip,
      asset: r.asset,
      qualified_sales_1y: r.qualified_sale_count,
      investor_purchases_1y: r.investor_count,
      buyer_known_1y: r.buyer_known_count,
      cash_purchases_1y: r.cash_count,
      distinct_investor_buyers_36m: buyerKnown ? (laneBuyers ?? 0) : null,
      median_price: r.median_price,
      median_ppsf: r.median_ppsf,
      median_ppu: r.median_ppu,
      median_inv_price: r.median_inv_price,
      latest_sale: r.latest_sale,
      rollup_build_id: r.build_id,
    }))
  }
  return out
}

/** The market-quality entry for one graph row (asset lane, then 'all'). */
export function marketQualityForRow(row, marketMap) {
  if (!(marketMap instanceof Map)) return null
  const zip = String(row?.property_zip ?? row?.zip ?? '').trim().slice(0, 5)
  if (!zip) return null
  const lane = marketAssetLane(row)
  return marketMap.get(`${zip}|${lane}`) || (lane.startsWith('mf_') ? marketMap.get(`${zip}|mf`) : null) || marketMap.get(`${zip}|all`) || null
}
