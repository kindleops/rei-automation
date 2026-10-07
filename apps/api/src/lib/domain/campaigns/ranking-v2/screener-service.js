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
import { loadMarketsForRows, loadMatchingFlagsForRows, loadResponseContext, loadSituationsForRows } from '@/lib/domain/campaigns/ranking-v2/ranking-context.js'
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
    loadMatchingFlags: deps.loadMatchingFlags || ((rows) => loadMatchingFlagsForRows(rows, { db })),
    loadResponse: deps.loadResponse || (() => loadResponseContext({ db })),
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

/**
 * TARGETING FUNNEL (owner rebuild 2026-10-07) — delivered → replied → owner →
 * interested → price → realistic → negotiation → deal, by every targeting
 * signal, optionally conditional on a stage (e.g. 'owner'). Read-only; one
 * set-based outcome query + `= ANY($1)` graph reads + set-based contexts.
 * input: { campaign_ids?: uuid[], since?: ISO, conditional_on?: stage }
 */
export async function runFunnel(input = {}, deps = {}) {
  if (!isSellerScreenerEnabled(deps.env || process.env)) return screenerDisabledResponse()
  const { FUNNEL_OUTCOME_SQL, FUNNEL_STAGES, funnelBySignal, funnelLabels, funnelSignals } = await import('@/lib/domain/campaigns/ranking-v2/funnel-analytics.js')
  const campaignIds = [].concat(input.campaign_ids || []).map((v) => String(v).trim()).filter((v) => /^[0-9a-f-]{36}$/i.test(v))
  const since = input.since && Number.isFinite(Date.parse(input.since)) ? new Date(input.since).toISOString() : null
  const propertyIds = [].concat(input.property_ids || []).map((v) => String(v).trim()).filter(Boolean).slice(0, 50000)
  if (!campaignIds.length && !since && !propertyIds.length) return { ok: false, status: 400, error: 'scope_required', message: 'Pass campaign_ids, property_ids and/or since.' }
  const conditionalOn = FUNNEL_STAGES.includes(input.conditional_on) ? input.conditional_on : null
  const db = deps.db || await defaultDb()
  const t0 = Date.now()
  const until = input.until && Number.isFinite(Date.parse(input.until)) ? new Date(input.until).toISOString() : null
  const { rows: outcomes } = await db.query(FUNNEL_OUTCOME_SQL, [campaignIds.length ? campaignIds : null, since, propertyIds.length ? propertyIds : null, until])
  const capped = outcomes.slice(0, 50000)
  const graph = await graphRowsByIds(capped.map((o) => o.property_id), db)
  const contexts = await buildRowContexts(graph, contextDeps(db, deps))
  const byId = new Map(graph.map((r, i) => [String(r.property_id), { row: r, ctx: contexts[i] }]))
  const items = []
  for (const o of capped) {
    const hit = byId.get(String(o.property_id))
    if (!hit) continue
    const labels = funnelLabels({ delivered: true, inbound: o.inbound, intents: o.intents, stages: o.stages, opt_out: o.opt_out, ask: o.ask, value: hit.row.estimated_value, opportunity_stage: o.opportunity_stage, lifecycle: o.lifecycle, closing: o.jsonb_closing })
    const signals = funnelSignals(hit.row, hit.ctx)
    signals.first_touch = o.first_touch_campaign_id ? `campaign:${o.first_touch_campaign_id}` : `source:${o.first_touch_source}`
    if (input.arms && input.arms[o.property_id]) signals.arm = input.arms[o.property_id]
    items.push({ property_id: o.property_id, labels, signals })
  }
  const report = funnelBySignal(items, { conditionalOn })
  if (input.return_items) report.items = items
  return { ok: true, version: 'targeting_funnel_v2', scope: { campaign_ids: campaignIds, since, until, property_ids: propertyIds.length }, delivered_properties: outcomes.length, truncated: outcomes.length > capped.length, matched_to_graph: items.length, ...report, ms: Date.now() - t0 }
}

export const CHECKPOINTS = Object.freeze({ '24h': 24, '72h': 72, '7d': 168, '14d': 336, '21d': 504 })

/**
 * TEST CAMPAIGN CHECKPOINT (owner decision 10-07): per-stage funnel for both
 * arms at 24h / 72h / 7d / 14d / 21d after launch, with Newcombe CIs, the
 * pre-registered verdicts and contamination checks (send hour / sender /
 * template balance by arm). Read-only; re-runnable at any time — outcomes are
 * capped at launched_at + checkpoint so a re-run reproduces the same read.
 * cohort: { arms: {test: [ids], control: [ids]}, preregistration }
 */
export async function runTestCampaignCheckpoint(cohort = {}, { checkpoint = '24h', launched_at = null } = {}, deps = {}) {
  if (!isSellerScreenerEnabled(deps.env || process.env)) return screenerDisabledResponse()
  const hours = CHECKPOINTS[checkpoint]
  if (!hours) return { ok: false, status: 400, error: 'unknown_checkpoint', allowed: Object.keys(CHECKPOINTS) }
  if (!launched_at || !Number.isFinite(Date.parse(launched_at))) return { ok: false, status: 400, error: 'launched_at_required' }
  const armOf = {}
  for (const [arm, ids] of Object.entries(cohort.arms || {})) for (const id of ids) armOf[String(id)] = arm
  const ids = Object.keys(armOf)
  if (!ids.length) return { ok: false, status: 400, error: 'cohort_empty' }
  const since = new Date(launched_at).toISOString()
  const until = new Date(Date.parse(launched_at) + hours * 3600_000).toISOString()
  const db = deps.db || await defaultDb()
  const funnel = await runFunnel({ property_ids: ids, since, until, arms: armOf, return_items: true }, { ...deps, db })
  if (!funnel.ok) return funnel
  const { armComparison } = await import('@/lib/domain/campaigns/ranking-v2/funnel-analytics.js')
  const comparison = armComparison(funnel.items, { arms: ['test', 'control'], checkpoint, preregistration: cohort.preregistration || null })
  const { rows: sends } = await db.query(
    `select property_id, extract(hour from coalesce(sent_at, created_at) at time zone 'America/Chicago')::int hour_ct,
            coalesce(textgrid_number_id::text, from_phone_number, 'unknown') sender, coalesce(template_id::text, 'unknown') template, queue_status
       from public.send_queue where property_id = any($1::text[]) and created_at >= $2::timestamptz and created_at <= $3::timestamptz`,
    [ids, since, until],
  )
  const balance = {}
  for (const dim of ['hour_ct', 'sender', 'template', 'queue_status']) {
    const t = {}
    for (const r of sends) { const a = armOf[String(r.property_id)]; const k = String(r[dim]); t[k] ||= { test: 0, control: 0 }; t[k][a] += 1 }
    balance[dim] = t
  }
  const contacted = { test: 0, control: 0 }
  for (const id of new Set(sends.map((r) => String(r.property_id)))) contacted[armOf[id]] += 1
  delete funnel.items
  return { ok: true, version: 'test_campaign_checkpoint_v1', checkpoint, window: { since, until }, cohort_size: { test: (cohort.arms.test || []).length, control: (cohort.arms.control || []).length }, contacted, ...comparison, contamination: balance, funnel_by_signal_overall: funnel.overall }
}
