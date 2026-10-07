// ─── ranking-v2/screener-service.js ──────────────────────────────────────────
// Read-only service layer behind the SELLER_SCREENER flag (§84, default OFF):
//   readScreenerCatalog()          metrics + measured production coverage (§17)
//   runScreener(input)             §69 Seller Screener over the graph
//   runDiscovery(input)            §16 ZIP "best campaigns now"
//   readWhyTargeted(ids)           §18 per-prospect why + rank + situation
//   readQualityReportForIds(ids)   §19/§70 Campaign Quality Report
// Every DB read: statement_timeout 30 s, keyset or `= ANY($1)` batches, never
// one request per row. Nothing writes.

import { isSellerScreenerEnabled, SELLER_SCREENER_FLAG } from '@/lib/domain/campaigns/ranking-v2/flags.js'
import { buildRowContexts, runSellerScreener, SCREENER_GRAPH_COLUMNS, normalizeScreenerExpression, compileGraphPushdown } from '@/lib/domain/campaigns/ranking-v2/seller-screener.js'
import { measureMetricCoverage, screenerMetricCatalog, SCREENER_METRICS } from '@/lib/domain/campaigns/ranking-v2/screener-metrics.js'
import { loadMarketsForRows, loadSituationsForRows } from '@/lib/domain/campaigns/ranking-v2/ranking-context.js'
import { rankDiscoveryZips } from '@/lib/domain/campaigns/ranking-v2/campaign-discovery.js'
import { summarizeCampaignQuality } from '@/lib/domain/campaigns/ranking-v2/campaign-quality-report.js'

const COVERAGE_SAMPLE = 3000
const COVERAGE_TTL_MS = 60 * 60 * 1000
const ID_CHUNK = 5000
let coverageCache = null

export function _resetScreenerServiceCache() { coverageCache = null }

export function screenerDisabledResponse() {
  return { ok: false, status: 404, error: 'seller_screener_disabled', flag: SELLER_SCREENER_FLAG, message: `${SELLER_SCREENER_FLAG} is off (default). Nothing was read.` }
}

async function defaultDb() {
  const { queryWithTimeout } = await import('@/lib/postgres/client.js')
  return { query: (sql, params) => queryWithTimeout(sql, params, 30_000) }
}

function contextDeps(db, deps = {}) {
  return {
    loadSituations: deps.loadSituations || ((rows) => loadSituationsForRows(rows, { db })),
    loadMarkets: deps.loadMarkets || ((rows) => loadMarketsForRows(rows, { db })),
  }
}

/** Production coverage from a ~2% block sample of the graph (cached 1 h). */
export async function measureProductionCoverage(deps = {}) {
  const now = deps.now ?? Date.now()
  if (!deps.fresh && coverageCache && now - coverageCache.at < COVERAGE_TTL_MS) return coverageCache.value
  const db = deps.db || await defaultDb()
  const t0 = Date.now()
  const { rows } = await db.query(
    `select ${SCREENER_GRAPH_COLUMNS.join(', ')} from public.campaign_target_graph tablesample system (2) limit ${COVERAGE_SAMPLE}`,
    [],
  )
  const contexts = await buildRowContexts(rows, contextDeps(db, deps))
  const coverage = measureMetricCoverage(rows, contexts, Object.keys(SCREENER_METRICS), now)
  const value = { at: new Date(now).toISOString(), sample: rows.length, method: 'tablesample system (2)', ms: Date.now() - t0, coverage }
  coverageCache = { at: now, value }
  return value
}

export async function readScreenerCatalog(deps = {}) {
  if (!isSellerScreenerEnabled(deps.env || process.env)) return screenerDisabledResponse()
  const cov = await measureProductionCoverage(deps)
  return { ok: true, flag: SELLER_SCREENER_FLAG, coverage_sample: { at: cov.at, rows: cov.sample, method: cov.method, ms: cov.ms }, metrics: screenerMetricCatalog(cov.coverage) }
}

export async function runScreener(input = {}, deps = {}) {
  if (!isSellerScreenerEnabled(deps.env || process.env)) return screenerDisabledResponse()
  const db = deps.db || await defaultDb()
  const cov = await measureProductionCoverage({ ...deps, db })
  return runSellerScreener(input, { db, coverage: cov.coverage, ...contextDeps(db, deps), now: deps.now })
}

/**
 * §16 discovery: scan a scope (state and/or market, asset) through the same
 * keyset reader as the screener, then rank ZIPs with zip_discovery_v1.
 */
export async function runDiscovery(input = {}, deps = {}) {
  if (!isSellerScreenerEnabled(deps.env || process.env)) return screenerDisabledResponse()
  const all = []
  if (input.state) all.push({ m: 'state', op: 'in', v: [].concat(input.state) })
  if (input.market) all.push({ m: 'market', op: 'in', v: [].concat(input.market) })
  if (!all.length) return { ok: false, status: 400, error: 'scope_required', message: 'Pass state and/or market — discovery never scans the nation in one request.' }
  const db = deps.db || await defaultDb()
  const t0 = Date.now()
  const norm = normalizeScreenerExpression({ all })
  const { where, params } = compileGraphPushdown(norm.expr, { startParam: 2 })
  const maxScan = Math.max(1, Math.min(Number(input.max_scan ?? 30000), 60000))
  const rows = []
  const contexts = []
  let last = ''
  const cdeps = contextDeps(db, deps)
  let truncated = false
  while (rows.length < maxScan) {
    const limit = Math.min(5000, maxScan - rows.length)
    const { rows: page } = await db.query(
      `select ${SCREENER_GRAPH_COLUMNS.join(', ')} from public.campaign_target_graph where property_id > $1 and ${where.join(' and ')} order by property_id limit ${limit}`,
      [last, ...params],
    )
    if (!page.length) break
    contexts.push(...await buildRowContexts(page, cdeps))
    rows.push(...page)
    last = String(page[page.length - 1].property_id)
    if (page.length < limit) break
    if (rows.length >= maxScan) truncated = true
  }
  const asset = input.asset ? String(input.asset) : null
  const ranked = rankDiscoveryZips(rows, contexts, { limit: Number(input.limit ?? 25) })
  const zips = asset ? ranked.zips.filter((z) => z.asset === asset || (asset === 'mf' && z.asset.startsWith('mf'))) : ranked.zips
  return { ok: true, ...ranked, zips, scope: { state: input.state ?? null, market: input.market ?? null, asset }, scanned: rows.length, truncated, ms: Date.now() - t0 }
}

async function graphRowsByIds(ids, db) {
  const unique = [...new Set((ids || []).map((v) => String(v ?? '').trim()).filter(Boolean))]
  const rows = []
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const { rows: page } = await db.query(
      `select ${SCREENER_GRAPH_COLUMNS.join(', ')} from public.campaign_target_graph where property_id = any($1::text[])`,
      [unique.slice(i, i + ID_CHUNK)],
    )
    rows.push(...page)
  }
  return rows
}

export async function readWhyTargeted(ids = [], deps = {}) {
  if (!isSellerScreenerEnabled(deps.env || process.env)) return screenerDisabledResponse()
  const list = [...new Set((ids || []).map((v) => String(v ?? '').trim()).filter(Boolean))].slice(0, 200)
  if (!list.length) return { ok: false, status: 400, error: 'property_ids_required' }
  const db = deps.db || await defaultDb()
  const t0 = Date.now()
  const rows = await graphRowsByIds(list, db)
  const contexts = await buildRowContexts(rows, contextDeps(db, deps))
  const found = new Set(rows.map((r) => String(r.property_id)))
  return {
    ok: true,
    ms: Date.now() - t0,
    missing: list.filter((id) => !found.has(id)),
    properties: rows.map((row, i) => {
      const { situation, market, rank } = contexts[i]
      return {
        property_id: row.property_id,
        market_name: row.market ?? null,
        zip: String(row.property_zip ?? '').slice(0, 5) || null,
        situation: situation
          ? {
              score_version: situation.score_version,
              input_model_version: situation.input_model_version,
              scored_at: situation.scored_at,
              opportunity_tier: situation.opportunity_tier,
              tier_reasons: situation.tier_reasons,
              seller_situation: situation.seller_situation,
              conversation_angle: situation.conversation_angle,
              components: situation.components,
              sell_probability: situation.sell_probability,
              coverage: situation.coverage,
              confidence: situation.confidence,
              evidence: (situation.evidence || []).map((e) => ({ code: e.code, points: e.points, component: e.component, source: `${e.source_table}.${e.source_field}`, provenance: e.provenance })),
              computed: 'in_process',
            }
          : null,
        market: market ? { score: market.score, label: market.label, terms: market.terms, inputs: market.inputs, provenance: market.provenance } : null,
        rank: rank ? { ranking_version: rank.ranking_version, rank_source: rank.rank_source, band: rank.band, score: rank.score, priority_score: rank.priority_score, coverage: rank.coverage, terms: rank.terms, fallback_reason: rank.fallback_reason ?? null } : null,
        why: (rank?.why || []).map((w) => ({ code: w.code, label: w.label, kind: w.kind, source: w.source })),
      }
    }),
  }
}

export async function readQualityReportForIds(ids = [], deps = {}) {
  if (!isSellerScreenerEnabled(deps.env || process.env)) return screenerDisabledResponse()
  const db = deps.db || await defaultDb()
  const t0 = Date.now()
  const rows = await graphRowsByIds(ids, db)
  const t1 = Date.now()
  const contexts = await buildRowContexts(rows, contextDeps(db, deps))
  const t2 = Date.now()
  const report = summarizeCampaignQuality(rows, contexts, { now: deps.now ?? Date.now() })
  return { ok: true, ...report, requested: new Set(ids).size, timings_ms: { graph: t1 - t0, context: t2 - t1, summarize: Date.now() - t2, total: Date.now() - t0 } }
}
