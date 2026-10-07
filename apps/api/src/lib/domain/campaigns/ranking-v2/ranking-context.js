// ─── ranking-v2/ranking-context.js ───────────────────────────────────────────
// Set-based context for CAMPAIGN_RANKING_V2 at build/preview time:
//   • seller situations — A1's batched loader (≤500 ids per call, one query
//     per source table per call) + the pure scoreSellerSituation, in-process.
//     When the PROPOSED persisted scores exist the loader is swapped for a
//     read of seller_situation_scores (same shape).
//   • ZIP market quality — one rollup read + one buyer read for the cohort's
//     ZIPs, cached per process (MI rollups rebuild daily at most).
// Never one DB request per row. A context failure never fails a build: rows
// fall into the LEGACY FALLBACK band, marked, and the error is reported.

import { compareCampaignRankV2, computeCampaignRankV2, CAMPAIGN_RANKING_VERSION } from '@/lib/domain/campaigns/ranking-v2/campaign-rank-v2.js'
import { loadZipMarketQuality, marketQualityForRow } from '@/lib/domain/campaigns/ranking-v2/market-quality.js'

/** Rows the graph read fetches when v2 is on: the whole cohort up to this window. */
export const RANKING_V2_WINDOW = 20000
const SITUATION_CHUNK = 500
const MARKET_TTL_MS = 30 * 60 * 1000
const marketCache = new Map()

export function rankingV2FetchLimit(limit, window = RANKING_V2_WINDOW) {
  const n = Math.max(1, Number(limit) || 1)
  return Math.max(n, window)
}

export function _resetRankingContextCache() {
  marketCache.clear()
}

async function defaultDb() {
  const { queryWithTimeout } = await import('@/lib/postgres/client.js')
  return { query: (sql, params) => queryWithTimeout(sql, params, 30_000) }
}

export async function loadSituationsForRows(rows, { db, now = new Date() } = {}) {
  const { loadSellerRawFacts, scoreSellerSituation } = await import('@/lib/acquisition/seller-situation/index.js')
  const ids = [...new Set(rows.map((r) => String(r.property_id ?? '').trim()).filter(Boolean))]
  const out = new Map()
  for (let i = 0; i < ids.length; i += SITUATION_CHUNK) {
    const facts = await loadSellerRawFacts(ids.slice(i, i + SITUATION_CHUNK), db)
    for (const [id, rf] of facts) out.set(String(id), scoreSellerSituation(rf, { now }))
  }
  return out
}

export async function loadMarketsForRows(rows, { db, nowMs = Date.now() } = {}) {
  const zips = [...new Set(rows.map((r) => String(r.property_zip ?? '').slice(0, 5)).filter((z) => /^\d{5}$/.test(z)))]
  const missing = zips.filter((z) => {
    const hit = marketCache.get(z)
    return !hit || nowMs - hit.at > MARKET_TTL_MS
  })
  if (missing.length) {
    const fresh = await loadZipMarketQuality(missing, { db })
    for (const z of missing) marketCache.set(z, { at: nowMs, entries: new Map() })
    for (const [key, value] of fresh) marketCache.get(key.split('|')[0])?.entries.set(key, value)
  }
  const map = new Map()
  for (const z of zips) for (const [k, v] of marketCache.get(z)?.entries || []) map.set(k, v)
  return map
}

/**
 * Rank eligible graph rows in place of the legacy order.
 * deps.rankingV2 = { loadSituations(rows), loadMarkets(rows), db } — injectable.
 * Returns { rows (sorted copies with _rank_v2), compare, summary }.
 */
export async function applyCampaignRankingV2(rows = [], deps = {}) {
  const t0 = Date.now()
  const hooks = deps.rankingV2 || {}
  const errors = []
  let db = hooks.db || null
  const needDb = typeof hooks.loadSituations !== 'function' || typeof hooks.loadMarkets !== 'function'
  if (needDb && !db) {
    try { db = await defaultDb() } catch (error) { errors.push(`db_unavailable:${error?.message || error}`) }
  }
  const [situations, markets] = await Promise.all([
    (typeof hooks.loadSituations === 'function' ? hooks.loadSituations(rows) : db ? loadSituationsForRows(rows, { db }) : Promise.resolve(new Map()))
      .catch((error) => { errors.push(`situations_unavailable:${error?.message || error}`); return new Map() }),
    (typeof hooks.loadMarkets === 'function' ? hooks.loadMarkets(rows) : db ? loadMarketsForRows(rows, { db }) : Promise.resolve(new Map()))
      .catch((error) => { errors.push(`markets_unavailable:${error?.message || error}`); return new Map() }),
  ])
  const tCtx = Date.now() - t0
  const ranked = rows.map((row) => {
    const situation = situations.get(String(row.property_id)) ?? null
    const market = marketQualityForRow(row, markets)
    return { ...row, _rank_v2: computeCampaignRankV2(row, { situation, market, includeWhy: true }) }
  })
  ranked.sort(compareCampaignRankV2)
  const byBand = {}
  const bySource = {}
  for (const r of ranked) {
    byBand[r._rank_v2.band] = (byBand[r._rank_v2.band] || 0) + 1
    bySource[r._rank_v2.rank_source] = (bySource[r._rank_v2.rank_source] || 0) + 1
  }
  return {
    rows: ranked,
    compare: compareCampaignRankV2,
    summary: {
      ranking_version: CAMPAIGN_RANKING_VERSION,
      rows_ranked: ranked.length,
      by_band: byBand,
      by_source: bySource,
      situations_loaded: situations.size,
      markets_loaded: markets.size,
      context_ms: tCtx,
      total_ms: Date.now() - t0,
      window: RANKING_V2_WINDOW,
      errors,
    },
  }
}
