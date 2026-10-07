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
import { annotatePhoneOwnerCounts } from '@/lib/domain/campaigns/ranking-v2/campaign-rank-v2.js'
import { fitMarketResponse, responseContextFor, responseLane } from '@/lib/domain/campaigns/ranking-v2/market-response.js'
import { INTEREST_INTENTS, INTEREST_STAGES } from '@/lib/domain/campaigns/ranking-v2/funnel-analytics.js'

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
  responseCache = null
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

/** prospects.matching_flags keyed by individual_key (= graph seller_person_key). ONE read per call. */
export async function loadMatchingFlagsForRows(rows, { db } = {}) {
  const keys = [...new Set(rows.map((r) => String(r.seller_person_key ?? '').trim()).filter(Boolean))]
  const out = new Map()
  for (let i = 0; i < keys.length; i += 5000) {
    const { rows: page } = await db.query(
      'select individual_key, matching_flags from public.prospects where individual_key = any($1::text[]) and matching_flags is not null',
      [keys.slice(i, i + 5000)],
    )
    for (const r of page) if (!out.has(String(r.individual_key))) out.set(String(r.individual_key), r.matching_flags)
  }
  return out
}

const RESPONSE_TTL_MS = 60 * 60 * 1000
let responseCache = null
/** Market response context, refit from history (cached 1 h). Bounded by market-response.js. */
export async function loadResponseContext({ db, nowMs = Date.now() } = {}) {
  if (responseCache && nowMs - responseCache.at < RESPONSE_TTL_MS) return responseCache.value
  const { rows } = await db.query(
    `with o as (select property_id, min(created_at) first_out from public.message_events
                 where direction = 'outbound' and property_id is not null and created_at > now() - interval '365 days' group by 1),
          i as (select property_id, bool_or(detected_intent = any($1::text[]) or stage_after = any($2::text[])) interested
                  from public.message_events where direction = 'inbound' and property_id is not null group by 1)
     select g.market, g.property_type, g.units_count, o.first_out, coalesce(i.interested, false) interested
       from o join public.campaign_target_graph g on g.property_id = o.property_id
       left join i on i.property_id = o.property_id`,
    [INTEREST_INTENTS, INTEREST_STAGES],
  )
  const value = fitMarketResponse(rows.map((r) => ({ market: r.market, lane: responseLane(r), contacted_at: r.first_out, interested: r.interested })), { now: nowMs })
  responseCache = { at: nowMs, value }
  return value
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
  const [situations, markets, flags, response] = await Promise.all([
    (typeof hooks.loadSituations === 'function' ? hooks.loadSituations(rows) : db ? loadSituationsForRows(rows, { db }) : Promise.resolve(new Map()))
      .catch((error) => { errors.push(`situations_unavailable:${error?.message || error}`); return new Map() }),
    (typeof hooks.loadMarkets === 'function' ? hooks.loadMarkets(rows) : db ? loadMarketsForRows(rows, { db }) : Promise.resolve(new Map()))
      .catch((error) => { errors.push(`markets_unavailable:${error?.message || error}`); return new Map() }),
    (typeof hooks.loadMatchingFlags === 'function' ? hooks.loadMatchingFlags(rows) : db ? loadMatchingFlagsForRows(rows, { db }) : Promise.resolve(new Map()))
      .catch((error) => { errors.push(`matching_flags_unavailable:${error?.message || error}`); return new Map() }),
    (typeof hooks.loadResponse === 'function' ? hooks.loadResponse() : db ? loadResponseContext({ db }) : Promise.resolve(null))
      .catch((error) => { errors.push(`response_context_unavailable:${error?.message || error}`); return null }),
  ])
  const tCtx = Date.now() - t0
  const enriched = annotatePhoneOwnerCounts(rows.map((row) => {
    const key = String(row.seller_person_key ?? '').trim()
    return row.matching_flags !== undefined ? row : { ...row, matching_flags: key && flags.has(key) ? flags.get(key) : null }
  }))
  const ranked = enriched.map((row) => {
    const situation = situations.get(String(row.property_id)) ?? null
    const market = marketQualityForRow(row, markets)
    return { ...row, _rank_v2: computeCampaignRankV2(row, { situation, market, response: responseContextFor(row, response), includeWhy: true }) }
  })
  ranked.sort(compareCampaignRankV2)
  const byBand = {}
  const bySource = {}
  const responseCapped = { applied: 0, max_abs_points: 0 }
  for (const r of ranked) {
    byBand[r._rank_v2.band] = (byBand[r._rank_v2.band] || 0) + 1
    bySource[r._rank_v2.rank_source] = (bySource[r._rank_v2.rank_source] || 0) + 1
    const pts = r._rank_v2.layers.market.response_context_points
    if (pts !== null && pts !== undefined) { responseCapped.applied += 1; responseCapped.max_abs_points = Math.max(responseCapped.max_abs_points, Math.abs(pts)) }
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
      matching_flags_loaded: flags.size,
      response_context: responseCapped,
      markets_loaded: markets.size,
      context_ms: tCtx,
      total_ms: Date.now() - t0,
      window: RANKING_V2_WINDOW,
      errors,
    },
  }
}
