// ─── ranking-v2/seller-screener.js ───────────────────────────────────────────
// Acquisition OS §13 / §69 — SELLER SCREENER (read-only) + stacked targeting.
//
//   "Texas SFR, forced-sale ≥70, sell365 ≥60, equity ≥35%, tax pain ≥50 OR
//    fatigue ≥65, min buyer liquidity, mobile reachable, not recently contacted"
//
// DSL — a small boolean tree, JSON-safe:
//   expr  := { all: expr[] } | { any: expr[] } | { not: expr } | leaf
//   leaf  := { m: <metric key>, op: <op>, v?: <value> }
//   op    := eq | neq | in | nin | gte | gt | lte | lt | between | is_true | is_false | known | unknown
//
// Semantics: a leaf on an UNKNOWN value (null) is FALSE for every op except
// `unknown` — and is COUNTED per metric (`unknown_excluded`) so the operator
// sees how many sellers dropped out for lack of data rather than evidence.
// `not` of an unknown leaf stays false (three-valued, unknown ≠ no).
//
// Execution: graph leaves in the top-level AND are pushed down to SQL
// (parameterised, column whitelist from SCREENER_METRICS); everything else is
// evaluated in-process on keyset batches. Seller situations and ZIP market
// quality are loaded SET-BASED per batch (never one DB request per row).
// Nothing here writes.

import { SCREENER_METRICS, metricDefinition, metricThreshold, measureMetricCoverage } from '@/lib/domain/campaigns/ranking-v2/screener-metrics.js'
import { computeCampaignRankV2, compareCampaignRankV2, RANK_BANDS } from '@/lib/domain/campaigns/ranking-v2/campaign-rank-v2.js'
import { marketQualityForRow } from '@/lib/domain/campaigns/ranking-v2/market-quality.js'

export const SCREENER_VERSION = 'seller_screener_v1'

const OPS = new Set(['eq', 'neq', 'in', 'nin', 'gte', 'gt', 'lte', 'lt', 'between', 'is_true', 'is_false', 'known', 'unknown'])
const MAX_DEPTH = 6
const MAX_LEAVES = 40

/** Validate + normalize. Returns { ok, expr, errors[], leaves[] }. */
export function normalizeScreenerExpression(input) {
  const errors = []
  const leaves = []
  const walk = (node, depth, path) => {
    if (depth > MAX_DEPTH) { errors.push(`${path}: too deep`); return null }
    if (!node || typeof node !== 'object' || Array.isArray(node)) { errors.push(`${path}: not an object`); return null }
    if (Array.isArray(node.all) || Array.isArray(node.any)) {
      const kind = Array.isArray(node.all) ? 'all' : 'any'
      const children = node[kind].map((c, i) => walk(c, depth + 1, `${path}.${kind}[${i}]`)).filter(Boolean)
      return { [kind]: children }
    }
    if (node.not) {
      const child = walk(node.not, depth + 1, `${path}.not`)
      return child ? { not: child } : null
    }
    const key = String(node.m ?? node.metric ?? '').trim()
    const op = String(node.op ?? '').trim()
    if (!metricDefinition(key)) { errors.push(`${path}: unknown metric '${key}'`); return null }
    if (!OPS.has(op)) { errors.push(`${path}: unknown op '${op}'`); return null }
    const leaf = { m: key, op }
    if (!['is_true', 'is_false', 'known', 'unknown'].includes(op)) {
      if (node.v === undefined) { errors.push(`${path}: '${op}' needs a value`); return null }
      leaf.v = node.v
      if ((op === 'in' || op === 'nin') && !Array.isArray(leaf.v)) leaf.v = [leaf.v]
      if (op === 'between' && !(Array.isArray(leaf.v) && leaf.v.length === 2)) { errors.push(`${path}: between needs [lo, hi]`); return null }
    }
    leaf.id = leaves.length
    leaves.push(leaf)
    return leaf
  }
  const expr = walk(input ?? { all: [] }, 0, '$')
  if (leaves.length > MAX_LEAVES) errors.push(`too many predicates (${leaves.length} > ${MAX_LEAVES})`)
  return { ok: errors.length === 0 && Boolean(expr), expr, errors, leaves }
}

function cmpNumber(op, value, target) {
  const v = Number(value)
  if (op === 'gte') return v >= Number(target)
  if (op === 'gt') return v > Number(target)
  if (op === 'lte') return v <= Number(target)
  if (op === 'lt') return v < Number(target)
  if (op === 'between') return v >= Number(target[0]) && v <= Number(target[1])
  return false
}

function leafValue(leaf, row, ctx) {
  return metricDefinition(leaf.m).get(row, ctx)
}

/** Three-valued leaf: true | false | null (unknown). */
export function evaluateLeaf(leaf, row, ctx = {}) {
  const value = leafValue(leaf, row, ctx)
  if (leaf.op === 'known') return value !== null && value !== undefined
  if (leaf.op === 'unknown') return value === null || value === undefined
  if (value === null || value === undefined) return null
  switch (leaf.op) {
    case 'is_true': return value === true
    case 'is_false': return value === false
    case 'eq': return String(value).toLowerCase() === String(leaf.v).toLowerCase()
    case 'neq': return String(value).toLowerCase() !== String(leaf.v).toLowerCase()
    case 'in': return leaf.v.some((t) => String(t).toLowerCase() === String(value).toLowerCase())
    case 'nin': return !leaf.v.some((t) => String(t).toLowerCase() === String(value).toLowerCase())
    default: return cmpNumber(leaf.op, value, leaf.v)
  }
}

/** Kleene logic. Returns true | false | null. `unknownHits` collects leaf ids that were unknown. */
export function evaluateExpression(expr, row, ctx = {}, unknownHits = null) {
  if (!expr) return true
  if (expr.all) {
    let sawNull = false
    for (const c of expr.all) {
      const r = evaluateExpression(c, row, ctx, unknownHits)
      if (r === false) return false
      if (r === null) sawNull = true
    }
    return sawNull ? null : true
  }
  if (expr.any) {
    if (!expr.any.length) return true
    let sawNull = false
    for (const c of expr.any) {
      const r = evaluateExpression(c, row, ctx, unknownHits)
      if (r === true) return true
      if (r === null) sawNull = true
    }
    return sawNull ? null : false
  }
  if (expr.not) {
    const r = evaluateExpression(expr.not, row, ctx, unknownHits)
    return r === null ? null : !r
  }
  const r = evaluateLeaf(expr, row, ctx)
  if (r === null && unknownHits) unknownHits.add(expr.m)
  return r
}

/**
 * Graph pushdown: top-level-AND graph leaves → SQL WHERE fragments.
 * Returns { where: string[], params: any[], pushed: Set<leaf id> }.
 * Only whitelisted columns from SCREENER_METRICS; values are parameters.
 */
export function compileGraphPushdown(expr, { startParam = 1 } = {}) {
  const where = []
  const params = []
  const pushed = new Set()
  const top = expr?.all ? expr.all : expr && !expr.any && !expr.not ? [expr] : []
  for (const leaf of top) {
    if (!leaf || leaf.all || leaf.any || leaf.not) continue
    const def = metricDefinition(leaf.m)
    if (!def || def.source !== 'graph' || !def.column) continue
    const col = def.column
    if (!/^[a-z_][a-z0-9_]*$/.test(col)) continue
    const bind = (value) => { params.push(value); return `$${startParam + params.length - 1}` }
    let frag = null
    if (def.type === 'boolean') {
      if (leaf.op === 'is_true') frag = `${col} is true`
      else if (leaf.op === 'is_false') frag = `${col} is false`
    } else if (def.type === 'number') {
      const opSql = { gte: '>=', gt: '>', lte: '<=', lt: '<' }[leaf.op]
      if (opSql) frag = `${col} ${opSql} ${bind(Number(leaf.v))}`
      else if (leaf.op === 'between') frag = `${col} between ${bind(Number(leaf.v[0]))} and ${bind(Number(leaf.v[1]))}`
    } else if (def.type === 'text') {
      if (leaf.op === 'in' || leaf.op === 'eq') {
        const values = (leaf.op === 'eq' ? [leaf.v] : leaf.v).map((x) => String(x))
        const target = leaf.m === 'zip' ? `left(${col}, 5)` : col
        frag = `${target} = any(${bind(values)}::text[])`
      }
    }
    if (leaf.op === 'known') frag = `${col} is not null`
    if (frag) { where.push(frag); pushed.add(leaf.id) }
  }
  return { where, params, pushed }
}

/** Situation / market metrics referenced by an expression. */
export function metricsInExpression(expr, out = new Set()) {
  if (!expr) return out
  if (expr.all) expr.all.forEach((c) => metricsInExpression(c, out))
  else if (expr.any) expr.any.forEach((c) => metricsInExpression(c, out))
  else if (expr.not) metricsInExpression(expr.not, out)
  else if (expr.m) out.add(expr.m)
  return out
}

/**
 * §17 gate: every metric the expression uses must have exposure coverage.
 * `coverage` = measureMetricCoverage(...) output (production sample).
 */
export function gateExpressionCoverage(expr, coverage) {
  const refused = []
  for (const key of metricsInExpression(expr)) {
    const cov = coverage?.[key]
    if (!cov) { refused.push({ metric: key, reason: 'coverage_not_measured', threshold: metricThreshold(key) }); continue }
    if (!cov.exposed) refused.push({ metric: key, reason: 'coverage_below_threshold', ratio: cov.ratio, threshold: cov.threshold })
  }
  return refused
}

function histogram(values, edges) {
  const buckets = edges.slice(0, -1).map((lo, i) => ({ lo, hi: edges[i + 1], n: 0 }))
  let unknown = 0
  for (const v of values) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) { unknown += 1; continue }
    const x = Number(v)
    const b = buckets.find((bk, i) => x >= bk.lo && (x < bk.hi || (i === buckets.length - 1 && x <= bk.hi)))
    if (b) b.n += 1
  }
  return { buckets, unknown }
}

function median(values) {
  const v = values.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = v.length >> 1
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

/**
 * Pure aggregation over already-loaded rows + contexts. Used by the screener
 * runner, the Campaign Quality Report and the offline tests.
 */
export function screenRows(rows, contexts, expr, { now = Date.now(), sellerLimit = 50, highPressureThreshold = 60 } = {}) {
  const matched = []
  const unknownExcluded = {}
  let unknownRows = 0
  for (let i = 0; i < rows.length; i += 1) {
    const ctx = { ...(contexts[i] || {}), now }
    const hits = new Set()
    const r = evaluateExpression(expr, rows[i], ctx, hits)
    if (r === true) matched.push({ row: rows[i], ctx })
    else if (r === null) {
      unknownRows += 1
      for (const m of hits) unknownExcluded[m] = (unknownExcluded[m] || 0) + 1
    }
  }
  const tiers = { A: 0, B: 0, C: 0, UNKNOWN: 0 }
  const markets = new Map()
  const zips = new Map()
  const rankScores = []
  const forced = []
  for (const { row, ctx } of matched) {
    const tier = ctx.situation?.opportunity_tier
    tiers[tier === 'A' || tier === 'B' || tier === 'C' ? tier : 'UNKNOWN'] += 1
    const mk = row.market || '(no market)'
    markets.set(mk, (markets.get(mk) || 0) + 1)
    const z = String(row.property_zip ?? '').slice(0, 5) || '(no zip)'
    if (!zips.has(z)) zips.set(z, { zip: z, market: row.market || null, count: 0, equity: [], high_pressure: 0, tier_a: 0, market_quality: ctx.market?.score ?? null, market_label: ctx.market?.label ?? 'unknown' })
    const zr = zips.get(z)
    zr.count += 1
    zr.equity.push(row.equity_percent === null || row.equity_percent === undefined ? null : Number(row.equity_percent))
    const fsp = ctx.situation?.opportunity_tier !== 'UNKNOWN' ? ctx.situation?.components?.forced_sale_pressure ?? null : null
    if (fsp !== null && fsp >= highPressureThreshold) zr.high_pressure += 1
    if (tier === 'A') zr.tier_a += 1
    rankScores.push(ctx.rank?.rank_source === 'v2' ? ctx.rank.score : null)
    forced.push(fsp)
  }
  const sorted = [...matched].sort((a, b) => compareCampaignRankV2({ property_id: a.row.property_id, _rank_v2: a.ctx.rank }, { property_id: b.row.property_id, _rank_v2: b.ctx.rank }))
  const sellers = sorted.slice(0, sellerLimit).map(({ row, ctx }) => ({
    property_id: row.property_id,
    address: row.property_address_full ?? null,
    market: row.market ?? null,
    zip: String(row.property_zip ?? '').slice(0, 5) || null,
    property_type: row.property_type ?? null,
    tier: ctx.situation?.opportunity_tier ?? 'UNKNOWN',
    seller_situation: ctx.situation?.seller_situation ?? null,
    rank: ctx.rank ? { band: ctx.rank.band, score: ctx.rank.score, priority_score: ctx.rank.priority_score, rank_source: ctx.rank.rank_source } : null,
    components: ctx.situation?.components ?? null,
    sell365: ctx.situation?.sell_probability?.d365 ?? null,
    why: (ctx.rank?.why || []).map((w) => ({ code: w.code, label: w.label, kind: w.kind })),
  }))
  return {
    matched: matched.length,
    unknown_rows: unknownRows,
    unknown_excluded: unknownExcluded,
    tiers,
    markets: [...markets].map(([market, count]) => ({ market, count })).sort((a, b) => b.count - a.count),
    zips: [...zips.values()]
      .map((z) => ({ zip: z.zip, market: z.market, count: z.count, high_pressure: z.high_pressure, tier_a: z.tier_a, median_equity_percent: median(z.equity), market_quality: z.market_quality, market_label: z.market_label }))
      .sort((a, b) => b.high_pressure - a.high_pressure || b.count - a.count)
      .slice(0, 100),
    score_distribution: {
      rank_score: histogram(rankScores, [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]),
      forced_sale_pressure: histogram(forced, [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]),
    },
    sellers,
  }
}

/**
 * Build {situation, market, rank} contexts for a batch, set-based.
 * deps.loadSituations(rows) → Map<property_id, SellerSituationResult>
 * deps.loadMarkets(rows)    → Map<`${zip}|${asset}`, MarketQuality>
 */
export async function buildRowContexts(rows, deps = {}) {
  const [situations, markets] = await Promise.all([
    typeof deps.loadSituations === 'function' ? deps.loadSituations(rows) : Promise.resolve(new Map()),
    typeof deps.loadMarkets === 'function' ? deps.loadMarkets(rows) : Promise.resolve(new Map()),
  ])
  return rows.map((row) => {
    const situation = situations?.get(String(row.property_id)) ?? null
    const market = marketQualityForRow(row, markets)
    const rank = computeCampaignRankV2(row, { situation, market, includeWhy: true })
    return { situation, market, rank }
  })
}

export const SCREENER_GRAPH_COLUMNS = Object.freeze([
  'property_id', 'master_owner_id', 'market', 'state', 'property_city', 'property_zip', 'property_county_name',
  'property_type', 'property_address_full', 'units_count', 'equity_percent', 'equity_amount', 'estimated_value',
  'ownership_years', 'year_built', 'tax_delinquent', 'active_lien', 'out_of_state_owner', 'is_corporate_owner',
  'sms_eligible', 'queue_eligible', 'phone_type', 'usage_2_months', 'identity_alignment', 'never_contacted',
  'last_outbound_at', 'acquisition_score', 'aos_score', 'total_loan_balance', 'language',
])

/**
 * Run the screener against the graph with keyset batches.
 * deps: { db: {query}, loadSituations, loadMarkets, coverage, now, maxScan, batchSize }
 */
export async function runSellerScreener(input = {}, deps = {}) {
  const t0 = Date.now()
  const norm = normalizeScreenerExpression(input.expression ?? input.expr)
  if (!norm.ok) return { ok: false, status: 400, error: 'invalid_expression', errors: norm.errors }
  const refused = deps.coverage ? gateExpressionCoverage(norm.expr, deps.coverage) : []
  if (refused.length && input.allow_unexposed !== true) {
    return { ok: false, status: 422, error: 'metric_not_exposed', refused, version: SCREENER_VERSION }
  }
  if (!deps.db?.query) return { ok: false, status: 503, error: 'screener_db_unavailable' }
  const maxScan = Math.max(1, Math.min(Number(input.max_scan ?? deps.maxScan ?? 25000), 100000))
  const batchSize = Math.max(100, Math.min(Number(deps.batchSize ?? 5000), 10000))
  const { where, params, pushed } = compileGraphPushdown(norm.expr, { startParam: 2 })
  const cols = SCREENER_GRAPH_COLUMNS.join(', ')
  const rows = []
  const contexts = []
  let last = ''
  let batches = 0
  let truncated = false
  const tRead = { graph_ms: 0, context_ms: 0 }
  while (rows.length < maxScan) {
    const limit = Math.min(batchSize, maxScan - rows.length)
    const sql = `select ${cols} from public.campaign_target_graph where property_id > $1${where.length ? ` and ${where.join(' and ')}` : ''} order by property_id limit ${limit}`
    const g0 = Date.now()
    const { rows: page } = await deps.db.query(sql, [last, ...params])
    tRead.graph_ms += Date.now() - g0
    batches += 1
    if (!page.length) break
    const c0 = Date.now()
    const ctx = await buildRowContexts(page, deps)
    tRead.context_ms += Date.now() - c0
    rows.push(...page)
    contexts.push(...ctx)
    last = String(page[page.length - 1].property_id)
    if (page.length < limit) break
    if (rows.length >= maxScan) { truncated = true; break }
  }
  const a0 = Date.now()
  const result = screenRows(rows, contexts, norm.expr, { now: deps.now ?? Date.now(), sellerLimit: Number(input.seller_limit ?? 50) })
  const coverage = measureMetricCoverage(rows, contexts, [...metricsInExpression(norm.expr)], deps.now ?? Date.now())
  return {
    ok: true,
    version: SCREENER_VERSION,
    expression: norm.expr,
    pushed_down: [...pushed].length,
    scanned: rows.length,
    truncated,
    refused_overridden: refused,
    coverage_in_cohort: coverage,
    ...result,
    bands: RANK_BANDS,
    timings_ms: { total: Date.now() - t0, graph: tRead.graph_ms, context: tRead.context_ms, aggregate: Date.now() - a0, batches },
  }
}

export { SCREENER_METRICS }
