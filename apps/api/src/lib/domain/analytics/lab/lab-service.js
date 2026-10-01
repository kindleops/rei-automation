/**
 * ANALYTICS LAB — the service behind /api/cockpit/analytics/lab/*.
 *
 *   getRegistry()                     the metric / dimension / filter registry + runtime facts
 *   getOverview(ctx)                  THE MACHINE: narrative, KPI strip, trend, the period, what changed, funnel, geo signal
 *   runQuery(ctx, view)               breakdown | series | heatmap | histogram | contribution | compare
 *   getRecords(ctx, cohort, paging)   the exact records behind a number (server-paginated)
 *   getFilterOptions(ctx, field)      values present in the period's cohort, with counts
 *
 * Read-only. Every response carries the normalised context, the definition
 * version, the data-as-of time and the query timing.
 */
import { publicRegistry, METRICS_BY_ID, DIMENSION_REGISTRY, FILTER_FIELDS, DEFINITION_VERSION, COHORTS } from './metric-registry.js'
import { cacheKey, HISTORY_START, publicContext, ContractError } from './query-contract.js'
import { sharedFactLoader } from './fact-loader.js'
import {
  buildModel, breakdown, cohortOf, compare, contribution, DEF, dimValue, entityOf, evaluate, heatmap, histogram, periodFacts, scopePredicate, series, seriesBy, stageMatrix, table, UNRESOLVED,
} from './metric-engine.js'
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import {
  DORMANT_DAYS, STAGE_INDEX, STAGE_MAX_DAYS, getPipelineCommandFeed, getPipelineCommandOffers, isImplausibleSellerNumber,
} from '@/lib/domain/opportunity/pipeline-command-service.js'
import { canaryPhones, OPTOUT_INTENTS, POSITIVE_INTENTS } from './fact-classifiers.js'
import { CLASS_DISPOSITION, CLASS_LABELS, DISPOSITION_LABELS, RUN_CLASS_LABELS } from './fact-classifiers.js'
import { UNIVERSAL_STAGE_LABELS } from '@/lib/domain/opportunity/universal-pipeline-registry.js'

const DAY = 86_400_000
const RESULT_TTL = 60_000
const results = new Map()
function cached(key, fn) {
  const hit = results.get(key)
  if (hit && Date.now() - hit.at < RESULT_TTL) return hit.promise
  const promise = Promise.resolve().then(fn)
  results.set(key, { at: Date.now(), promise })
  promise.catch(() => results.delete(key))
  if (results.size > 200) results.delete(results.keys().next().value)
  return promise
}

/* model reuse: same cached fact arrays → same model */
const models = new WeakMap()
function modelFor(facts) {
  const e = models.get(facts.sends)
  const same = e && e.inbound === facts.inbound && e.history === facts.history && e.runs === facts.runs && e.opportunities === facts.opportunities && e.propertiesSize === facts.properties.size && e.bucketsSize === facts.buckets.size
  if (same) return e.model
  const model = buildModel(facts)
  models.set(facts.sends, { inbound: facts.inbound, history: facts.history, runs: facts.runs, opportunities: facts.opportunities, propertiesSize: facts.properties.size, bucketsSize: facts.buckets.size, model })
  return model
}

async function load(ctx, deps = {}) {
  const loader = deps.loader || sharedFactLoader()
  const starts = [ctx.period.start, ctx.compare.available ? ctx.compare.start : Infinity]
  const ends = [ctx.period.end, ctx.compare.available ? ctx.compare.end : -Infinity]
  const t0 = Date.now()
  const facts = await loader.load({ start: Math.min(...starts), end: Math.max(...ends), lookbackMs: 30 * DAY })
  const model = modelFor(facts)
  const cur = periodFacts(model, { start: ctx.period.start, end: ctx.period.end }, { filters: ctx.filters, segment: ctx.segment })
  const prev = ctx.compare.available ? periodFacts(model, { start: ctx.compare.start, end: ctx.compare.end }, { filters: ctx.filters, segment: ctx.segment }) : null
  return { facts, model, cur, prev, loadMs: facts.loadMs, t0 }
}

const envelope = (ctx, extra) => ({
  version: DEFINITION_VERSION,
  context: publicContext(ctx),
  period: { start: new Date(ctx.period.start).toISOString(), end: new Date(ctx.period.end).toISOString(), days: ctx.period.days, preset: ctx.period.preset, coverage: ctx.period.coverage, historyStart: HISTORY_START },
  compare: { mode: ctx.compare.mode, available: ctx.compare.available, reason: ctx.compare.reason || null, partial: Boolean(ctx.compare.partial), start: ctx.compare.start ? new Date(ctx.compare.start).toISOString() : null, end: ctx.compare.end ? new Date(ctx.compare.end).toISOString() : null },
  grain: ctx.grain,
  ...extra,
})

function metricPair(id, L, ctx) {
  const cur = evaluate(id, L.cur)
  const prev = L.prev ? evaluate(id, L.prev) : null
  const change = prev ? compare(id, cur, prev, { lenCur: ctx.period.end - ctx.period.start, lenPrev: ctx.compare.end - ctx.compare.start }) : { comparable: false, reason: ctx.compare.reason || 'No comparison window.' }
  return { id, cur: strip(cur), prev: strip(prev), change }
}
/** Drop the raw sample arrays from duration results before they leave the server. */
function strip(r) {
  if (!r) return r
  const { values, ...rest } = r
  return rest
}

/* ═══ REGISTRY ═══════════════════════════════════════════════════════════ */

export function getRegistry(deps = {}) {
  // No database read here: the registry is static, and the send_queue replica
  // is built lazily by the first wide-window request (see fact-loader).
  const loader = deps.loader || sharedFactLoader()
  return {
    ...publicRegistry(),
    // which disposition each failure / hold class sits under (the flow chart's links)
    classDisposition: CLASS_DISPOSITION, classLabels: CLASS_LABELS, dispositionLabels: DISPOSITION_LABELS, runClassLabels: RUN_CLASS_LABELS,
    historyStart: HISTORY_START, generatedAt: new Date().toISOString(), replica: loader.replicaState?.() || null,
  }
}

/* ═══ OVERVIEW — THE MACHINE ═════════════════════════════════════════════ */

export const STRIP = ['sellers_reached', 'reply_rate', 'interest_rate', 'opt_out_rate', 'delivery_rate', 'content_filter_rate', 'opportunities_created', 'stage_advancements', 'median_reply_latency', 'human_intervention_rate']
export const TREND_METRICS = ['sellers_reached', 'reply_rate', 'sellers_replied', 'interest_rate', 'delivery_rate', 'content_filter_rate', 'messages_delivered', 'opportunities_created', 'stage_advancements']
const WATCH = [...new Set([...STRIP, 'sellers_replied', 'messages_sent', 'transport_failures', 'provider_rejections', 'sender_health_blocks', 'template_health_blocks', 'content_guard_blocks', 'send_gate_holds', 'autopilot_runs', 'stage_regressions', 'positive_reply_rate', 'transport_failure_rate'])]
const DRILL_DIMS = ['market', 'campaign', 'sender', 'template', 'failure_class', 'hour_local', 'touch']
/** Failure class only decomposes the metrics that SPAN several classes; for the rest it restates the metric. */
const MULTI_CLASS = new Set(['transport_failures', 'provider_rejections', 'dispatch_decisions'])
const drillDims = (id) => DRILL_DIMS.filter((d) => METRICS_BY_ID[id]?.dimensions.includes(d) && (d !== 'failure_class' || MULTI_CLASS.has(id)))

const fmtN = (n) => (n === null || n === undefined ? '—' : Math.round(n).toLocaleString('en-US'))
const fmtP = (r, d = 1) => (r === null || r === undefined ? '—' : `${(r * 100).toFixed(d)}%`)
const fmtPts = (p) => `${p > 0 ? '+' : ''}${p.toFixed(1)} pts`
const rangeWords = (ctx) => ({ today: 'Today', '7d': 'In the last 7 days', '30d': 'In the last 30 days', '90d': 'In the last 90 days', ytd: 'This year', custom: 'In this period' }[ctx.period.preset])
const compareWords = (ctx) => ({ previous: `the previous ${Math.round(ctx.period.days)} days`, week: 'the same window a week earlier', month: 'the same window a month earlier', year: 'the same window a year earlier', custom: 'the comparison window', none: '' }[ctx.compare.mode])

/**
 * The period in plain language. Every figure is a registry metric (a `parts`
 * segment carrying its metric id, so the UI can open its inspector), and a
 * change is called a change only when its test passes; otherwise the sentence
 * says so. Association language only; no causal claims.
 */
function sentence() {
  const parts = []
  const refs = new Set()
  const api = {
    t(text) { if (text) parts.push({ text }); return api },
    m(metric, text) { parts.push({ text, metric }); refs.add(metric); return api },
    done() { return { parts, refs: [...refs], text: parts.map((x) => x.text).join('') } },
  }
  return api
}
export function narrative(ctx, M) {
  const out = []
  const v = (id) => M[id]?.cur
  const reached = v('sellers_reached')
  const rr = v('reply_rate')
  if (!reached || reached.status === 'not_applicable') return [sentence().t('The current filters do not apply to seller outreach; the metrics below say which ones they do apply to.').done()]
  if (!reached.value) return [sentence().t(`${rangeWords(ctx)} `).m('sellers_reached', 'no seller received a delivered message').t(`${ctx.filters.length || ctx.segment.length ? ' in this slice' : ''}.`).done()]
  const ch = M.sellers_reached.change
  const reachDelta = ch?.comparable && ch.pct !== null ? ` (${ch.delta > 0 ? '+' : ''}${fmtN(ch.delta)}, ${ch.pct > 0 ? '+' : ''}${Math.round(ch.pct * 100)}% vs ${compareWords(ctx)})` : ch?.comparable ? ` (${ch.delta > 0 ? '+' : ''}${fmtN(ch.delta)} vs ${compareWords(ctx)})` : ''
  out.push(sentence().t(`${rangeWords(ctx)} the machine reached `).m('sellers_reached', `${fmtN(reached.value)} seller${reached.value === 1 ? '' : 's'}`).t(`${reachDelta}.`).done())
  if (rr && rr.value !== null) {
    const c = M.reply_rate.change
    let tail = ''
    if (c?.comparable && c.significant) tail = `, ${c.pts > 0 ? 'up' : 'down'} ${Math.abs(c.pts).toFixed(1)} pts from ${fmtP(M.reply_rate.prev.value)} — a statistically meaningful change`
    else if (c?.comparable) tail = ` (${fmtP(M.reply_rate.prev.value)} before; the ${fmtPts(c.pts)} difference is within normal variation)`
    else if (c?.reason && M.reply_rate.prev) tail = ` (not compared: ${c.reason})`
    const late = (v('sellers_replied')?.value ?? 0) - (v('reached_replied')?.value ?? rr.num)
    const s2 = sentence().m('reached_replied', `${fmtN(rr.num)} of them replied`).t(' — a ').m('reply_rate', `${fmtP(rr.value)} reply rate`).t(`${tail}.`)
    if (late > 0) s2.t(' ').m('sellers_replied', `${fmtN(late)} more seller${late === 1 ? '' : 's'}`).t(' replied to earlier outreach.')
    if (rr.status === 'insufficient_sample') s2.t(` The sample is small (n=${rr.den}).`)
    out.push(s2.done())
  }
  const ir = v('interest_rate')
  if (ir && ir.value !== null && ir.num > 0) {
    const s3 = sentence().m('interested_sellers', `${fmtN(ir.num)} showed interest`).t(' (').m('interest_rate', `${fmtP(ir.value)} of sellers reached`).t(')')
    const oo = v('opt_out_rate')
    if (oo?.num) s3.t(' and ').m('opted_out_sellers', `${fmtN(oo.num)} opted out`).t(' (').m('opt_out_rate', fmtP(oo.value)).t(')')
    out.push(s3.t('.').done())
  }
  const cf = v('content_filter_rate')
  const dr = v('delivery_rate')
  const tf = v('transport_failures')
  if (cf && cf.value !== null && cf.den >= 30 && cf.value >= 0.05) {
    const largest = tf?.value && cf.num / tf.value >= 0.5
    out.push(sentence().t('Carriers filtered ').m('content_filtered', `${fmtN(cf.num)} of ${fmtN(cf.den)} sent messages`).t(' as spam (').m('content_filter_rate', fmtP(cf.value)).t(`)${largest ? `, ${Math.round((cf.num / tf.value) * 100)}% of all non-delivery` : ''}; `).m('delivery_rate', `${fmtP(dr?.value)} were delivered`).t('.').done())
  } else if (dr && dr.value !== null) {
    out.push(sentence().m('delivery_rate', `${fmtP(dr.value)} of ${fmtN(dr.den)} sent messages were delivered`).t('.').done())
  }
  const oc = v('opportunities_created')
  const sa = v('stage_advancements')
  if (oc?.status === 'ok' || sa?.status === 'ok') {
    out.push(sentence().m('opportunities_created', `${fmtN(oc?.value ?? 0)} opportunit${oc?.value === 1 ? 'y was' : 'ies were'} created`).t(' and ').m('stage_advancements', `${fmtN(sa?.value ?? 0)} forward stage move${sa?.value === 1 ? ' was' : 's were'} recorded`).t('.').done())
  }
  const down = ['offers_issued', 'contracts_signed', 'closings'].map((id) => M[id]?.cur)
  if (down.every((d) => d && d.status === 'ok' && d.value === 0)) {
    out.push(sentence().t('No ').m('offers_issued', 'offers').t(', ').m('contracts_signed', 'contracts').t(' or ').m('closings', 'closings').t(' were recorded — the offer ledger and closing desk are empty, not failing.').done())
  }
  return out
}

function topContributor(L, id) {
  if (!L.prev) return null
  let best = null
  // Only dimensions that can name a responsible slice; a dimension with one
  // value (SMS) or one dominant group (first touches) restates the total.
  const dims = ['campaign', 'market', 'sender', 'template', 'failure_class'].filter((d) => drillDims(id).includes(d))
  for (const dim of dims) {
    const c = contribution(id, L.cur, L.prev, dim, { limit: 50 })
    if (!c.available) continue
    const named = c.rows.filter((r) => r.key !== UNRESOLVED && r.key !== '__none')
    if (named.length < 2) continue
    const top = named[0]
    const total = c.kind === 'rate' ? c.totalPts : c.total
    const size = c.kind === 'rate' ? top.contributionPts : top.contribution
    if (!total || !size) continue
    const everything = c.kind === 'rate'
      ? (top.cur.den / Math.max(1, c.rows.reduce((a, r) => a + r.cur.den, 0))) > 0.95 && (top.prev.den / Math.max(1, c.rows.reduce((a, r) => a + r.prev.den, 0))) > 0.95
      : top.cur >= 0.95 * c.rows.reduce((a, r) => a + r.cur, 0) && top.prev >= 0.95 * c.rows.reduce((a, r) => a + r.prev, 0)
    if (everything) continue
    const share = size / total
    if (!best || Math.abs(share) > Math.abs(best.share)) best = { dim, dimLabel: DIMENSION_REGISTRY[dim].label, key: top.key, label: top.label, value: size, share, kind: c.kind }
  }
  return best
}

function funnelOf(M) {
  const g = (id) => M[id]?.cur
  const reached = g('sellers_reached')?.value ?? null
  const steps = [
    { id: 'sellers_reached', label: 'Reached', value: reached, base: null },
    { id: 'reached_replied', label: 'Replied', value: g('reached_replied')?.value ?? null, base: reached },
    { id: 'interested_sellers', label: 'Interested', value: g('interested_sellers')?.value ?? null, base: g('reached_replied')?.value ?? null, note: 'subset of replied' },
    { id: 'opportunity_rate', label: 'Became opportunity', value: g('opportunity_rate')?.num ?? null, base: g('reached_replied')?.value ?? null, note: 'repliers whose thread produced an opportunity' },
  ].map((s) => ({ ...s, conversion: s.base ? s.value / s.base : null, kind: 'cohort' }))
  const events = ['offers_issued', 'contracts_signed', 'closings'].map((id) => ({ id, label: METRICS_BY_ID[id].short, value: g(id)?.value ?? null, status: g(id)?.status, kind: 'events', caveat: METRICS_BY_ID[id].caveat || null }))
  return { steps, events, note: 'Cohort steps follow the sellers reached in the period; offers, contracts and closings are events recorded in the period (not yet linked to this cohort).' }
}

export async function getOverview(ctx, deps = {}) {
  return cached(cacheKey(ctx, 'overview'), async () => {
    const L = await load(ctx, deps)
    const t1 = Date.now()
    const ids = [...new Set([...WATCH, 'reached_replied', 'interested_sellers', 'opted_out_sellers', 'opportunity_rate', 'offers_issued', 'contracts_signed', 'closings', ctx.metric])]
    const M = Object.fromEntries(ids.map((id) => [id, metricPair(id, L, ctx)]))
    const changes = WATCH.map((id) => ({ id, ...M[id] }))
      .filter((x) => x.change?.comparable && x.change.significant)
      .map((x) => ({ id: x.id, label: METRICS_BY_ID[x.id].label, kind: x.change.kind, cur: x.cur.value, prev: x.prev.value, num: x.cur.num ?? null, den: x.cur.den ?? null, prevNum: x.prev.num ?? null, prevDen: x.prev.den ?? null, delta: x.change.delta ?? null, pct: x.change.pct ?? null, pts: x.change.pts ?? null, ciPts: x.change.ciPts ?? null, p: x.change.p, polarity: METRICS_BY_ID[x.id].polarity, drill: drillDims(x.id), top: topContributor(L, x.id) }))
      .sort((a, b) => a.p - b.p)
      .slice(0, 8)
    // Any registry metric can be trended, unless it has no honest series here
    // (not filterable by the slice, or gated as unavailable) — then reply rate.
    const trendOk = M[ctx.metric] && !['not_applicable', 'unavailable'].includes(M[ctx.metric].cur.status)
    const trendId = trendOk ? ctx.metric : 'reply_rate'
    const trend = {
      metric: trendId,
      grain: ctx.grain.grain,
      current: series(trendId, L.cur, { grain: ctx.grain.grain, tz: ctx.tz }),
      comparison: L.prev ? series(trendId, L.prev, { grain: ctx.grain.grain, tz: ctx.tz }) : null,
      options: TREND_METRICS.includes(trendId) ? TREND_METRICS : [...TREND_METRICS, trendId],
    }
    const geo = breakdown('reply_rate', L.cur, 'market', { limit: 12 })
    const ex = L.model.excluded
    const cohortStep = ctx.segment.find((s) => s.dim === 'cohort')
    const cohort = {
      sellers: M.sellers_reached.cur.value, messages: L.cur.messages.length, replies: L.cur.repliers.length, transitions: L.cur.transitions.length, runs: L.cur.runs.length,
      // an active seller cohort (a funnel stage used as a filter) and its size in each window
      sellerCohort: cohortStep ? { key: cohortStep.value, label: COHORTS[cohortStep.value]?.label || cohortStep.value, current: L.cur.cohort, comparison: L.prev ? L.prev.cohort : null } : null,
    }
    return envelope(ctx, {
      generatedAt: new Date().toISOString(),
      dataAsOf: L.facts.dataAsOf,
      timing: { loadMs: L.loadMs, computeMs: Date.now() - t1 },
      narrative: narrative(ctx, M),
      strip: STRIP.map((id) => M[id]),
      metrics: M,
      trend,
      thePeriod: {
        cohort,
        exclusions: {
          canarySends: ex.canarySends, canaryInbound: ex.canaryInbound, unattributableInbound: ex.unattributableInbound, syntheticHistory: ex.syntheticHistory, replayRuns: ex.replayRuns,
          testCampaignMessages: L.model.sends.filter((s) => s.test && s.at >= ctx.period.start && s.at < ctx.period.end).length,
          voidedClosings: ex.voidedClosings,
        },
        unresolved: { market: geo.rows.filter((r) => r.key === UNRESOLVED).reduce((a, r) => a + r.n, 0) },
        freshness: {
          dataAsOf: L.facts.dataAsOf,
          live: ['send_queue', 'message_events', 'acquisition_opportunity_history', 'seller_automation_executions'],
          note: 'Live sources are read on request (cached 90 s). Delivery receipts can lag minutes after a send.',
        },
        caveats: [
          METRICS_BY_ID.reply_rate.caveat,
          ctx.period.coverage === 'partial' ? `History begins ${HISTORY_START.slice(0, 10)}; the window starts earlier.` : null,
          ctx.compare.partial ? ctx.compare.reason : null,
        ].filter(Boolean),
      },
      changes,
      funnel: funnelOf(M),
      geo: { metric: 'reply_rate', dim: 'market', rows: geo.rows.filter((r) => r.key !== UNRESOLVED), unresolved: geo.rows.find((r) => r.key === UNRESOLVED)?.n ?? 0 },
    })
  })
}

/* ═══ QUERY ══════════════════════════════════════════════════════════════ */

export const VIEWS = ['metric', 'breakdown', 'series', 'seriesBy', 'heatmap', 'histogram', 'contribution', 'table', 'stages', 'orchestrator', 'buyers', 'events', 'money']
export async function runQuery(ctx, view = 'metric', deps = {}) {
  if (!VIEWS.includes(view)) throw new ContractError(`unknown view "${view}" (${VIEWS.join(', ')})`)
  if (view === 'orchestrator') return getOrchestrator(ctx, deps)
  if (view === 'buyers') return getBuyers(ctx, deps)
  if (view === 'events') return getEvents(ctx, deps)
  if (view === 'money') return getMoney(ctx, deps)
  if (view === 'table' && !ctx.metrics.length) throw new ContractError('table needs metrics[]')
  const needsGroup = view === 'breakdown' || view === 'contribution' || view === 'table' || view === 'seriesBy'
  if (needsGroup && !ctx.groupBy) throw new ContractError(`${view} needs groupBy`)
  return cached(`${cacheKey(ctx, 'query')}|${view}`, async () => {
    const L = await load(ctx, deps)
    const t1 = Date.now()
    const id = ctx.metric
    const base = metricPair(id, L, ctx)
    let result = null
    if (view === 'stages') result = null
    else if (view === 'table') {
      const cur = table(ctx.metrics, L.cur, ctx.groupBy, { limit: ctx.limit })
      const prev = L.prev ? table(ctx.metrics, L.prev, ctx.groupBy, { limit: 5000 }) : null
      const pmap = new Map((prev?.rows || []).map((r) => [r.key, r.values]))
      result = { ...cur, rows: cur.rows.map((r) => ({ ...r, prev: pmap.get(r.key) || null })) }
    } else if (base.cur.status === 'not_applicable' || base.cur.status === 'unavailable') result = null
    else if (view === 'metric') result = null
    else if (view === 'breakdown') {
      const cur = breakdown(id, L.cur, ctx.groupBy, { limit: ctx.limit })
      const prev = L.prev ? breakdown(id, L.prev, ctx.groupBy, { limit: 1000 }) : null
      const pmap = new Map((prev?.rows || []).map((r) => [r.key, r]))
      result = { ...cur, rows: cur.rows.map((r) => ({ ...r, prev: pmap.get(r.key) || null })) }
    } else if (view === 'series') {
      result = { grain: ctx.grain.grain, current: series(id, L.cur, { grain: ctx.grain.grain, tz: ctx.tz }), comparison: L.prev ? series(id, L.prev, { grain: ctx.grain.grain, tz: ctx.tz }) : null }
    } else if (view === 'seriesBy') {
      result = seriesBy(id, L.cur, ctx.groupBy, { grain: ctx.grain.grain, tz: ctx.tz, limit: Math.min(12, ctx.limit) })
    } else if (view === 'heatmap') result = { current: heatmap(id, L.cur), comparison: L.prev ? heatmap(id, L.prev) : null }
    else if (view === 'histogram') result = { current: histogram(id, L.cur), comparison: L.prev ? histogram(id, L.prev) : null }
    else if (view === 'contribution') result = L.prev ? contribution(id, L.cur, L.prev, ctx.groupBy, { limit: ctx.limit }) : { available: false, reason: ctx.compare.reason || 'No comparison window.' }
    if (view === 'stages') {
      const opts = { now: Date.now(), maxDays: STAGE_MAX_DAYS, dormantDays: DORMANT_DAYS }
      const cur = stageMatrix(L.cur, opts)
      const candidates = cur.filter((x) => x.live >= 3 && x.stalled >= 2)
      const bottleneck = candidates.sort((a, b) => b.stalled / b.live - a.stalled / a.live || b.stalled - a.stalled)[0] || null
      result = { current: cur, comparison: L.prev ? stageMatrix(L.prev, opts) : null, bottleneck: bottleneck ? { code: bottleneck.code, label: bottleneck.label, live: bottleneck.live, stalled: bottleneck.stalled, thresholdDays: bottleneck.stallThresholdDays } : null, dormantDays: DORMANT_DAYS }
    }
    return envelope(ctx, { generatedAt: new Date().toISOString(), dataAsOf: L.facts.dataAsOf, timing: { loadMs: L.loadMs, computeMs: Date.now() - t1 }, view, metric: base, result })
  })
}

/* ═══ BUYERS (recorded-transaction corpus, via the reconciled v1 RPC) ═════ */

/**
 * The buyer corpus lives in comp_private, which the Lab's PostgREST reads
 * cannot reach; the analytics_performance RPC (security definer, reconciled
 * against the Lab key-for-key) already exposes it with its DATA-THROUGH date.
 * Periods after that date are "not yet recorded", never zero.
 */
export async function getBuyers(ctx, deps = {}) {
  const client = deps.supabase || defaultSupabase
  return cached(`${cacheKey({ ...ctx, filters: [], segment: [] }, 'buyers')}`, async () => {
    const t0 = Date.now()
    const prevStart = ctx.compare.available ? ctx.compare.start : ctx.period.start - (ctx.period.end - ctx.period.start)
    const prevEnd = ctx.compare.available ? ctx.compare.end : ctx.period.start
    const { data, error } = await client.rpc('analytics_performance', {
      p_start: new Date(ctx.period.start).toISOString(), p_end: new Date(ctx.period.end).toISOString(),
      p_prev_start: new Date(prevStart).toISOString(), p_prev_end: new Date(prevEnd).toISOString(),
      p_exclude: [...canaryPhones()], p_positive: [...POSITIVE_INTENTS], p_optout: [...OPTOUT_INTENTS], p_market: null, p_bucket: 'week',
    })
    if (error) throw error
    const through = data?.buyer_data_through || null
    const throughMs = through ? Date.parse(through) : null
    const coverage = throughMs === null ? 'unknown' : throughMs < ctx.period.start ? 'none' : throughMs < ctx.period.end ? 'partial' : 'full'
    const cur = data?.totals?.cur || {}
    const prev = data?.totals?.prev || {}
    const markets = (data?.markets || []).filter((m) => (m.cur?.buyer_purchases || 0) + (m.prev?.buyer_purchases || 0) > 0)
      .map((m) => ({ key: m.id, label: m.name, state: m.state, cur: m.cur.buyer_purchases, prev: m.prev.buyer_purchases, entities: m.cur.buyer_entities, centroid: Number.isFinite(m.lat) ? { lat: m.lat, lng: m.lng } : null }))
      .sort((a, b) => b.cur - a.cur)
    return envelope(ctx, {
      generatedAt: new Date().toISOString(), timing: { loadMs: Date.now() - t0, computeMs: 0 }, view: 'buyers',
      result: {
        dataThrough: through, coverage,
        purchases: coverage === 'none' ? null : cur.buyer_purchases ?? null,
        entities: coverage === 'none' ? null : cur.buyer_entities ?? null,
        repeat: coverage === 'none' ? null : cur.repeat_buyer_purchases ?? null,
        prevPurchases: prev.buyer_purchases ?? null,
        markets, zips: (data?.zips || []).filter((z) => z.buyer_purchases > 0).map((z) => ({ zip: z.zip, market: z.market, lat: z.lat, lng: z.lng, purchases: z.buyer_purchases })),
        unresolved: data?.unresolved?.buyer_purchases ?? null,
        note: 'Arm\u2019s-length purchases by identity-resolved buyers (nominal and distress/transfer deeds excluded); ZIP \u2192 canonical market via reviewed ZIP membership. Filters and breadcrumbs do not apply to this corpus.',
      },
    })
  })
}

/* ═══ ORCHESTRATOR (wf_* runtime) ════════════════════════════════════════ */

export async function getOrchestrator(ctx, deps = {}) {
  const client = deps.supabase || defaultSupabase
  return cached(`${cacheKey({ ...ctx, filters: [], segment: [] }, 'wf')}`, async () => {
    const res = await client.from('wf_runs').select('id,workflow_key,version,subject_kind,state,outcome,reason,started_at,finished_at,trigger_event_type')
      .gte('started_at', new Date(ctx.period.start).toISOString()).lt('started_at', new Date(ctx.period.end).toISOString()).order('started_at', { ascending: false }).limit(500)
    if (res.error) throw res.error
    const runs = res.data || []
    const byKey = new Map()
    for (const r of runs) {
      const k = `${r.workflow_key} v${r.version}`
      const g = byKey.get(k) || { key: k, workflow: r.workflow_key, version: r.version, runs: 0, states: {} }
      g.runs += 1
      g.states[r.state || 'unknown'] = (g.states[r.state || 'unknown'] || 0) + 1
      byKey.set(k, g)
    }
    return envelope(ctx, { generatedAt: new Date().toISOString(), view: 'orchestrator', result: { total: runs.length, workflows: [...byKey.values()], runs: runs.slice(0, 50), note: 'wf_* orchestrator runtime (live since 2026-09-29). Rates are withheld below 30 runs per workflow version.' } })
  })
}

/* ═══ EVENTS (chart annotations) ═════════════════════════════════════════ */

/**
 * Operational events worth marking on a time series — never routine noise.
 * Campaign lifecycle from campaign_events (the scheduler's 5-minute
 * "launch_scheduled" ticks, target builds and edits are noise and are not
 * read) and the LAST change of an allow-listed control setting from
 * system_control (the table keeps no history, so only the latest change is
 * known; other keys — including secrets — are never selected).
 */
export const EVENT_TYPES = Object.freeze({
  'campaign.activated': { tone: 'exec', verb: 'Campaign activated' },
  'campaign.converted_to_live': { tone: 'exec', verb: 'Converted to a live campaign' },
  'campaign.launch_blocked': { tone: 'attn', verb: 'Campaign launch blocked' },
  'campaign.quarantined_target_integrity': { tone: 'attn', verb: 'Campaign quarantined' },
  'campaign.archived': { tone: 'neutral', verb: 'Campaign archived' },
})
export const CONTROL_KEYS = Object.freeze({
  queue_processor_mode: { label: 'Send processor mode' },
  queue_execution_mode: { label: 'Queue execution mode' },
  queue_auto_send_enabled: { label: 'Queue auto-send' },
  queue_auto_enqueue_enabled: { label: 'Queue auto-enqueue' },
  followup_automation_mode: { label: 'Follow-up automation' },
  auto_reply_mode: { label: 'Auto-reply mode' },
  campaign_mode: { label: 'Campaign mode' },
  queue_emergency_stop_at: { label: 'Emergency stop', tone: 'crit' },
  sms_blocked_sender_numbers: { label: 'Sender block list', tone: 'attn', list: 'sender numbers' },
  sms_blocked_template_ids: { label: 'Template block list', tone: 'attn', list: 'templates' },
  queue_per_number_cap: { label: 'Per-number send cap' },
  queue_daily_send_cap: { label: 'Daily send cap' },
  queue_market_cap: { label: 'Per-market send cap' },
  queue_hard_cap: { label: 'Queue hard cap' },
  queue_contact_window_start: { label: 'Contact window start' },
  queue_contact_window_end: { label: 'Contact window end' },
  workflow_orchestrator_enabled: { label: 'Workflow orchestrator' },
  feeder_enabled: { label: 'Campaign feeder' },
  closing_automation_enabled: { label: 'Closing automation' },
  email_automation_enabled: { label: 'Email automation' },
})
const controlValue = (spec, raw) => {
  const v = String(raw ?? '').trim()
  if (spec.list) { const n = v ? v.split(',').map((x) => x.trim()).filter(Boolean).length : 0; return `${n} ${spec.list}` }
  if (!v) return 'cleared'
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true' ? 'on' : 'off'
  return v.length > 40 ? `${v.slice(0, 40)}…` : v
}

/** Pure: raw rows → annotations (exported for tests). */
export function shapeEvents({ campaignRows = [], controlRows = [], campaigns = new Map() } = {}) {
  const out = []
  const seen = new Map()
  for (const r of campaignRows) {
    const spec = EVENT_TYPES[r.event_type]
    if (!spec) continue
    const c = campaigns.get(String(r.campaign_id || '')) || null
    if (c?.integrity?.test) continue // structural test / proof campaigns are not operations
    const at = Date.parse(r.created_at)
    if (!Number.isFinite(at)) continue
    // the same transition repeated within an hour is one event, counted
    const k = `${r.campaign_id}|${r.event_type}`
    const prev = seen.get(k)
    if (prev && at - Date.parse(prev.at) < 3_600_000) { prev.repeats += 1; continue }
    const e = {
      id: String(r.id), at: new Date(at).toISOString(), kind: 'campaign', tone: spec.tone, title: spec.verb,
      subject: c?.name || 'Campaign', detail: String(r.description || r.title || '').slice(0, 220) || null,
      campaignId: r.campaign_id ? String(r.campaign_id) : null, source: 'campaign_events', repeats: 0,
    }
    seen.set(k, e)
    out.push(e)
  }
  // settings changed in the same instant are one change
  const groups = new Map()
  for (const r of controlRows) {
    const spec = CONTROL_KEYS[r.key]
    if (!spec) continue
    const at = Date.parse(r.updated_at)
    if (!Number.isFinite(at)) continue
    const k = Math.floor(at / 1000)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push({ key: r.key, label: spec.label, value: controlValue(spec, r.value), tone: spec.tone || 'flow', at })
  }
  for (const items of groups.values()) {
    items.sort((a, b) => a.label.localeCompare(b.label))
    const tone = items.some((i) => i.tone === 'crit') ? 'crit' : items.some((i) => i.tone === 'attn') ? 'attn' : 'flow'
    out.push({
      id: `control:${items[0].at}`, at: new Date(items[0].at).toISOString(), kind: 'control', tone,
      title: items.length === 1 ? `${items[0].label} changed` : `${items.length} control settings changed`,
      subject: items.map((i) => `${i.label} → ${i.value}`).join(' · '),
      detail: null, items: items.map(({ key, label, value }) => ({ key, label, value })), source: 'system_control',
      note: 'The settings table keeps only the latest change of each key; earlier changes are not recorded.',
    })
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

export async function getEvents(ctx, deps = {}) {
  const client = deps.supabase || defaultSupabase
  return cached(`${cacheKey({ ...ctx, filters: [], segment: [], groupBy: null, metric: 'reply_rate', metrics: [] }, 'events')}`, async () => {
    const t0 = Date.now()
    const L = await load({ ...ctx, filters: [], segment: [] }, deps)
    const from = new Date(ctx.period.start).toISOString()
    const to = new Date(ctx.period.end).toISOString()
    const [ce, sc] = await Promise.all([
      client.from('campaign_events').select('id,campaign_id,event_type,severity,title,description,created_at')
        .in('event_type', Object.keys(EVENT_TYPES)).gte('created_at', from).lt('created_at', to).order('created_at', { ascending: true }).limit(300),
      client.from('system_control').select('key,value,updated_at').in('key', Object.keys(CONTROL_KEYS)).gte('updated_at', from).lt('updated_at', to),
    ])
    if (ce.error) throw ce.error
    if (sc.error) throw sc.error
    const events = shapeEvents({ campaignRows: ce.data || [], controlRows: sc.data || [], campaigns: L.model.campaigns })
    return envelope(ctx, {
      generatedAt: new Date().toISOString(), dataAsOf: L.facts.dataAsOf, timing: { loadMs: L.loadMs, computeMs: Date.now() - t0 }, view: 'events',
      result: { events, sources: ['campaign_events (lifecycle only)', 'system_control (latest change of allow-listed settings)'], note: 'Routine scheduler ticks, target builds and edits are not events. Test and proof campaigns are excluded.' },
    })
  })
}

/* ═══ MONEY + INVENTORY (current state, by basis) ════════════════════════ */

const LANES = ['system', 'operator', 'seller', 'external', 'blocked', 'dormant', 'complete']
const emptyBasis = () => ({ n: 0, sum: 0 })
const addTo = (b, v) => { if (Number.isFinite(v) && v > 0) { b.n += 1; b.sum += v } }

/**
 * Pure: canonical Pipeline cards + engine offer rows + closing cases →
 * value through the stages, by basis, never summed across bases. Exported
 * for tests.
 *   cards     Pipeline Command feed rows (lane, stall, money.asking, propertyId, …)
 *   offers    Pipeline Command offer rows (engine, readiness, binding offer)
 *   closings  Lab closing cases (voided excluded) with money by basis
 *   prop(id)  the Lab model's property (canonical market, record estimate)
 *   pass(e)   the Lab scope predicate for opportunities (filters, breadcrumb, cohort)
 */
export function moneyModel({ cards = [], offers = [], closings = [], prop = () => null, marketLabel = (id) => id, pass = () => true } = {}) {
  const offerBy = new Map(offers.map((r) => [String(r.card?.id), r]))
  const closingBy = new Map(closings.filter((c) => c.oppId).map((c) => [String(c.oppId), c]))
  const stages = Object.keys(STAGE_INDEX).sort((a, b) => STAGE_INDEX[a] - STAGE_INDEX[b]).map((code) => ({
    code, index: STAGE_INDEX[code], label: code, deals: 0, stalled: 0, lanes: Object.fromEntries(LANES.map((l) => [l, 0])),
    asking: emptyBasis(), askingImplausible: 0, record: emptyBasis(),
    authorized: { n: 0, offer: 0, valuation: 0, fee: 0 }, needsValidation: 0, notPriced: 0,
    presented: emptyBasis(), contract: emptyBasis(), expected: emptyBasis(), actual: emptyBasis(),
  }))
  const byStage = new Map(stages.map((s) => [s.code, s]))
  const markets = new Map()
  const deals = []
  let scoped = 0
  let closedWithoutEvidence = 0
  for (const card of cards) {
    if (card.lane?.key === 'closed_out') continue
    const p = card.propertyId ? prop(card.propertyId) : null
    const entity = { id: card.id, propertyId: card.propertyId || null, thread: card.threadKey || null, stage: card.stage, campaignIds: [] }
    if (!pass(entity)) continue
    scoped += 1
    // S10 is a closing only with closing evidence (Pipeline Command's rule);
    // an "active" row parked at S10 is counted apart, never as a won deal.
    if (card.stage === 'closed' && card.lane?.key !== 'complete') { closedWithoutEvidence += 1; continue }
    const s = byStage.get(card.stage)
    if (!s) continue
    const o = offerBy.get(String(card.id)) || null
    const c = closingBy.get(String(card.id)) || null
    const engine = o?.engine || null
    const state = o?.readiness?.state || 'not_priced'
    const record = p?.estimatedValue ?? null
    const reference = engine?.mid || record || null
    const asking = card.money?.asking ?? null
    const askImplausible = asking ? isImplausibleSellerNumber(asking, reference) : false
    s.deals += 1
    if (card.stall) s.stalled += 1
    const lane = LANES.includes(card.lane?.key) ? card.lane.key : 'seller'
    s.lanes[lane] += 1
    if (asking) { if (askImplausible) s.askingImplausible += 1; else addTo(s.asking, asking) }
    addTo(s.record, record)
    if (state === 'authorized' && engine) { s.authorized.n += 1; s.authorized.offer += engine.recommended || 0; s.authorized.valuation += engine.mid || 0; s.authorized.fee += engine.assignmentFee || 0 }
    else if (state === 'needs_validation') s.needsValidation += 1
    else s.notPriced += 1
    if (o?.offer?.binding) addTo(s.presented, o.offer.price)
    if (c) { addTo(s.contract, c.money?.contract); addTo(s.expected, c.money?.expectedGross); addTo(s.actual, c.money?.confirmedGross) }
    const mk = p?.market || '__unresolved'
    const m = markets.get(mk) || { key: mk, label: mk === '__unresolved' ? 'Unresolved' : marketLabel(mk), deals: 0, asking: emptyBasis(), record: emptyBasis(), authorized: { n: 0, offer: 0 }, needsValidation: 0 }
    m.deals += 1
    if (asking && !askImplausible) addTo(m.asking, asking)
    addTo(m.record, record)
    if (state === 'authorized' && engine) { m.authorized.n += 1; m.authorized.offer += engine.recommended || 0 }
    else if (state === 'needs_validation') m.needsValidation += 1
    markets.set(mk, m)
    deals.push({
      id: card.id, stage: card.stage, stageIndex: card.stageIndex ?? STAGE_INDEX[card.stage] ?? null, lane: card.lane ? { key: card.lane.key, label: card.lane.label } : null,
      stall: card.stall ? card.stall.label : null, daysInStage: card.daysInStage ?? null, address: card.address || p?.address || null,
      market: mk === '__unresolved' ? null : marketLabel(mk), marketKey: mk === '__unresolved' ? null : mk,
      asking, askImplausible, record,
      engine: engine ? { state, tier: engine.tierLabel || engine.tier || null, recommended: engine.recommended ?? null, valuation: engine.mid ?? null, fee: engine.assignmentFee ?? null, compCount: engine.compCount ?? null, reasons: (o.readiness?.reasons || []).slice(0, 4) } : { state: 'not_priced', reasons: ['The Decision Engine has not priced this property'] },
      presented: o?.offer?.binding ? o.offer.price : null, contract: c?.money?.contract ?? null, actual: c?.money?.confirmedGross ?? null,
      propertyId: card.propertyId || null, threadKey: card.threadKey || null,
    })
  }
  const total = (key) => stages.reduce((acc, s) => ({ n: acc.n + s[key].n, sum: acc.sum + s[key].sum }), emptyBasis())
  const totals = {
    deals: scoped,
    closedWithoutEvidence,
    asking: total('asking'), askingImplausible: stages.reduce((a, s) => a + s.askingImplausible, 0),
    record: total('record'),
    authorized: stages.reduce((acc, s) => ({ n: acc.n + s.authorized.n, offer: acc.offer + s.authorized.offer, valuation: acc.valuation + s.authorized.valuation, fee: acc.fee + s.authorized.fee }), { n: 0, offer: 0, valuation: 0, fee: 0 }),
    needsValidation: stages.reduce((a, s) => a + s.needsValidation, 0),
    notPriced: stages.reduce((a, s) => a + s.notPriced, 0),
    presented: total('presented'), contract: total('contract'), expected: total('expected'), actual: total('actual'),
    lanes: Object.fromEntries(LANES.map((l) => [l, stages.reduce((a, s) => a + s.lanes[l], 0)])),
    stalled: stages.reduce((a, s) => a + s.stalled, 0),
  }
  deals.sort((a, b) => (b.stageIndex ?? 0) - (a.stageIndex ?? 0) || (b.daysInStage ?? 0) - (a.daysInStage ?? 0))
  return {
    stages, totals,
    markets: [...markets.values()].sort((a, b) => Number(a.key === '__unresolved') - Number(b.key === '__unresolved') || b.deals - a.deals),
    deals: deals.slice(0, 400), dealsTruncated: deals.length > 400,
  }
}

export async function getMoney(ctx, deps = {}) {
  const pipe = deps.pipeline || { feed: getPipelineCommandFeed, offers: getPipelineCommandOffers }
  return cached(`${cacheKey({ ...ctx, groupBy: null, metric: 'reply_rate', metrics: [] }, 'money')}`, async () => {
    const t0 = Date.now()
    const L = await load(ctx, deps)
    const cards = []
    let cursor = 0
    // sequential pages: the first fills Pipeline Command's scope memo, the rest reuse it
    for (let i = 0; i < 60 && cursor !== null && cursor !== undefined; i += 1) {
      const page = await pipe.feed({ scope: 'active', view: 'all', limit: 100, cursor })
      cards.push(...(page?.rows || []))
      cursor = page?.nextCursor ?? null
    }
    const offers = await pipe.offers({ scope: 'active' })
    const scope = scopePredicate(L.model, ctx.period, 'opportunity', { filters: ctx.filters, segment: ctx.segment })
    const model = moneyModel({
      cards, offers: offers?.rows || [], closings: L.model.closings, prop: (id) => L.model.prop(id),
      marketLabel: (id) => L.model.markets.get(id)?.display_name || id, pass: scope.pass,
    })
    for (const s of model.stages) s.label = UNIVERSAL_STAGE_LABELS[s.code] || s.code
    const ever = { closings: L.model.closings.length, confirmedRevenue: L.model.closings.filter((c) => (c.money?.confirmedGross || 0) > 0).length, contracts: L.model.closings.filter((c) => (c.money?.contract || 0) > 0).length }
    return envelope(ctx, {
      generatedAt: new Date().toISOString(), dataAsOf: new Date().toISOString(), timing: { loadMs: L.loadMs, computeMs: Date.now() - t0 }, view: 'money',
      result: {
        ...model,
        asOf: 'now',
        notApplicable: scope.notApplicable,
        offersTruncated: Boolean(offers?.truncated),
        ever,
        thresholds: { stageMaxDays: STAGE_MAX_DAYS, dormantDays: DORMANT_DAYS },
        note: 'Current state of the active pipeline (Pipeline Command scope: active, waiting, paused, nurture), as of now — the period does not apply; geography, property and cohort filters do. Each basis is its own figure; none is a sum of another.',
      },
    })
  })
}

/* ═══ RECORDS ════════════════════════════════════════════════════════════ */

const mask = (phone) => { const d = String(phone || '').replace(/\D/g, ''); return d.length >= 4 ? `••• ${d.slice(-4)}` : '—' }
const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null)

/** Column registry per entity: id, label, type. The client chooses; the server sorts. */
export const RECORD_COLUMNS = {
  seller: [
    ['seller', 'Seller', 'text'], ['phone', 'Phone', 'text'], ['address', 'Property', 'text'], ['market', 'Market', 'text'], ['campaign', 'Campaign', 'text'],
    ['sender', 'Sender', 'text'], ['template', 'Template', 'text'], ['touch', 'Touch', 'number'], ['reachedAt', 'Reached', 'time'], ['repliedAt', 'Replied', 'time'],
    ['intent', 'Intent', 'text'], ['latencyMin', 'Latency (min)', 'number'], ['interested', 'Interested', 'bool'], ['optedOut', 'Opted out', 'bool'], ['opportunity', 'Opportunity', 'bool'], ['delivered', 'Delivered msgs', 'number'],
  ],
  message: [
    ['at', 'Time', 'time'], ['outcome', 'Outcome', 'text'], ['class', 'Class', 'text'], ['phone', 'Phone', 'text'], ['address', 'Property', 'text'], ['market', 'Market', 'text'],
    ['campaign', 'Campaign', 'text'], ['sender', 'Sender', 'text'], ['template', 'Template', 'text'], ['touch', 'Touch', 'number'], ['origin', 'Origin', 'text'], ['reason', 'Reason', 'text'],
  ],
  reply: [['at', 'Received', 'time'], ['phone', 'Phone', 'text'], ['intent', 'Intent', 'text'], ['address', 'Property', 'text'], ['market', 'Market', 'text'], ['campaign', 'Campaign', 'text'], ['touch', 'Touch', 'number']],
  transition: [['at', 'Time', 'time'], ['event', 'Event', 'text'], ['from', 'From', 'text'], ['to', 'To', 'text'], ['actor', 'Moved by', 'text'], ['dwellMin', 'Dwell (min)', 'number'], ['address', 'Property', 'text'], ['market', 'Market', 'text']],
  run: [['at', 'Time', 'time'], ['outcome', 'Outcome', 'text'], ['reason', 'Reason', 'text'], ['address', 'Property', 'text'], ['market', 'Market', 'text'], ['workflow', 'Workflow', 'text']],
  offer: [['at', 'Time', 'time'], ['direction', 'Direction', 'text'], ['status', 'Status', 'text'], ['price', 'Price', 'number'], ['address', 'Property', 'text']],
  closing: [['at', 'Created', 'time'], ['status', 'Status', 'text'], ['contractAt', 'Contract signed', 'time'], ['closedAt', 'Closed', 'time'], ['address', 'Property', 'text']],
}

function recordRow(model, kind, e) {
  const d = (dim) => { const v = dimValue(model, kind, e, dim); return v.key === UNRESOLVED || v.key === '__none' ? null : v.label }
  const p = kind === 'seller' ? model.prop(e.anchor.propertyId) : model.prop(e.propertyId)
  const place = { address: p?.address || null, lat: p?.lat ?? null, lng: p?.lng ?? null, propertyId: p?.id || null }
  if (kind === 'seller') {
    const a = e.anchor
    return {
      key: e.thread, thread: e.thread, seller: a.sellerName, phone: mask(e.thread), ...place, market: d('market'), campaign: d('campaign'), campaignId: a.campaignId,
      sender: d('sender'), template: d('template'), touch: a.touch, reachedAt: iso(a.at), repliedAt: iso(e.firstReply?.at), intent: e.firstReply?.intent || null,
      latencyMin: e.latencyMin === null ? null : Math.round(e.latencyMin * 10) / 10, interested: e.positive, optedOut: e.optedOut, opportunity: Boolean(e.opportunity), oppId: e.opportunity?.oppId || null, delivered: e.deliveredInW,
    }
  }
  if (kind === 'message') {
    return {
      key: e.id, id: e.id, thread: e.thread, at: iso(e.at), outcome: DISPOSITION_LABELS[e.disposition] || e.disposition, class: CLASS_LABELS[e.cls] || e.cls, phone: mask(e.thread), ...place,
      market: d('market'), campaign: d('campaign'), campaignId: e.campaignId, sender: d('sender'), template: d('template'), touch: e.touch, origin: e.origin, reason: e.reason ? e.reason.slice(0, 140) : null,
    }
  }
  if (kind === 'reply') {
    return { key: e.id, id: e.id, thread: e.thread, at: iso(e.at), phone: mask(e.thread), intent: e.intent, ...place, market: d('market'), campaign: d('campaign'), campaignId: e.prompt?.campaignId || null, touch: e.prompt?.touch ?? null }
  }
  if (kind === 'transition') {
    const st = (c) => (c ? UNIVERSAL_STAGE_LABELS[c] || c : null)
    return { key: e.id, id: e.id, oppId: e.oppId, thread: e.opp?.thread || null, at: iso(e.at), event: e.type === 'opportunity_created' ? 'Created' : e.direction === 'backward' ? 'Moved back' : 'Advanced', from: st(e.from), to: st(e.to), actor: e.actor, dwellMin: e.prevAt ? Math.round((e.at - e.prevAt) / 60_000) : null, ...place, market: d('market') }
  }
  if (kind === 'run') {
    return { key: e.id, id: e.id, thread: e.thread, at: iso(e.at), outcome: RUN_CLASS_LABELS[e.cls] || e.cls, reason: e.reason ? e.reason.replace(/_/g, ' ') : null, ...place, market: d('market'), workflow: e.workflow }
  }
  if (kind === 'offer') return { key: e.id, id: e.id, thread: e.thread, oppId: e.oppId, at: iso(e.at), direction: e.direction, status: e.status, price: e.price, ...place }
  return { key: e.id, id: e.id, thread: e.thread, oppId: e.oppId, at: iso(e.at), status: e.status, contractAt: iso(e.contractAt), closedAt: iso(e.closedAt), ...place }
}

/**
 * The exact records behind a number.
 *   cohort = { metric, part: 'numerator' | 'denominator', window: 'current' | 'comparison',
 *              group?: { dim, key }, bucket?: { start, end }, cell?: { weekday, hour } }
 * The count returned is the metric's numerator / denominator for that slice,
 * so VIEW RECORDS and the KPI can never disagree.
 */
export async function getRecords(ctx, cohort = {}, { page = 1, pageSize = 50, sort = null, dir = 'desc' } = {}, deps = {}) {
  const id = String(cohort.metric || ctx.metric)
  if (!DEF[id] || !METRICS_BY_ID[id]) throw new ContractError(`unknown metric "${id}"`)
  const part = cohort.part === 'denominator' ? 'denominator' : 'numerator'
  const windowKey = cohort.window === 'comparison' ? 'comparison' : 'current'
  return cached(`${cacheKey(ctx, 'records')}|${JSON.stringify({ id, part, windowKey, g: cohort.group || null, b: cohort.bucket || null, c: cohort.cell || null, page, pageSize, sort, dir })}`, async () => {
    const L = await load(ctx, deps)
    const pf = windowKey === 'comparison' ? L.prev : L.cur
    if (!pf) throw new ContractError('no comparison window in this context')
    const kind = entityOf(id)
    const r = evaluate(id, pf)
    if (r.status === 'not_applicable' || r.status === 'unavailable') return envelope(ctx, { entity: kind, total: 0, rows: [], status: r.status, reason: r.reason })
    let set = cohortOf(id, pf, part)
    if (cohort.group?.dim) {
      if (!DIMENSION_REGISTRY[cohort.group.dim]) throw new ContractError(`unknown dimension "${cohort.group.dim}"`)
      set = set.filter((e) => String(dimValue(L.model, kind, e, cohort.group.dim).key) === String(cohort.group.key))
    }
    if (cohort.bucket) {
      const s = Date.parse(cohort.bucket.start)
      const en = Date.parse(cohort.bucket.end)
      const mom = (e) => (kind === 'seller' ? e.anchor.at : e.at)
      set = set.filter((e) => mom(e) >= s && mom(e) < en)
    }
    if (cohort.cell) {
      set = set.filter((e) => dimValue(L.model, kind, e, 'weekday_local').key === String(cohort.cell.weekday) && Number(dimValue(L.model, kind, e, 'hour_local').key) === Number(cohort.cell.hour))
    }
    const cols = RECORD_COLUMNS[kind] || []
    const rows = set.map((e) => recordRow(L.model, kind, e))
    const sortKey = cols.some(([c]) => c === sort) ? sort : cols.find(([, , t]) => t === 'time')?.[0]
    const sign = dir === 'asc' ? 1 : -1
    if (sortKey) {
      rows.sort((a, b) => {
        const x = a[sortKey]
        const y = b[sortKey]
        if (x === y) return 0
        if (x === null || x === undefined) return 1
        if (y === null || y === undefined) return -1
        return (x > y ? 1 : -1) * sign
      })
    }
    const size = Math.max(10, Math.min(200, Math.trunc(pageSize) || 50))
    const pg = Math.max(1, Math.trunc(page) || 1)
    return envelope(ctx, {
      generatedAt: new Date().toISOString(), dataAsOf: L.facts.dataAsOf,
      metric: id, part, window: windowKey, entity: kind, total: rows.length, page: pg, pageSize: size, pages: Math.max(1, Math.ceil(rows.length / size)),
      sort: sortKey, dir, columns: cols.map(([idc, lbl, type]) => ({ id: idc, label: lbl, type })), rows: rows.slice((pg - 1) * size, pg * size),
      // Hand-off cohorts: exact ids, bounded, for the canonical apps.
      handoff: {
        threads: [...new Set(rows.map((x) => x.thread).filter(Boolean))].slice(0, 5000),
        propertyIds: [...new Set(rows.map((x) => x.propertyId).filter(Boolean))].slice(0, 5000),
        points: rows.filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng)).slice(0, 5000).map((x) => ({ lat: x.lat, lng: x.lng, id: x.propertyId, label: x.address })),
        opportunityIds: [...new Set(rows.map((x) => x.oppId).filter(Boolean))].slice(0, 2000),
      },
    })
  })
}

/* ═══ FILTER OPTIONS ═════════════════════════════════════════════════════ */

const FIELD_DIM = { market: 'market', state: 'state', county: 'county', zip: 'zip', property_type: 'property_type', owner_type: 'owner_type', campaign: 'campaign', campaign_source: 'campaign_source', sender: 'sender', template: 'template', template_use_case: 'template_use_case', disposition: 'disposition', failure_class: 'failure_class', intent: 'intent', stage: 'stage', hold_class: 'hold_class', origin: 'origin', language: 'language', channel: 'channel', weekday_local: 'weekday_local' }
/** Values present in the period's cohort (bounded), with counts, for the filter builder. */
export async function getFilterOptions(ctx, field, deps = {}) {
  const def = FILTER_FIELDS.find((f) => f.id === field)
  if (!def) throw new ContractError(`unknown filter field "${field}"`)
  if (def.type !== 'category') return envelope(ctx, { field, type: def.type, values: [] })
  const dim = FIELD_DIM[field]
  return cached(`${cacheKey({ ...ctx, filters: [], segment: [] }, 'options')}|${field}`, async () => {
    const L = await load({ ...ctx, filters: [], segment: [] }, deps)
    const kind = def.applies.includes('message') ? 'message' : def.applies[0]
    const set = kind === 'message' ? L.cur.messages : kind === 'reply' ? L.cur.repliers : kind === 'run' ? L.cur.runs : kind === 'transition' || kind === 'opportunity' ? L.cur.transitions : L.cur.sellers
    const counts = new Map()
    for (const e of set) {
      const v = dimValue(L.model, kind === 'opportunity' ? 'transition' : kind, e, dim)
      if (v.key === UNRESOLVED || v.key === '__none') continue
      const key = field === 'weekday_local' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][Number(v.key)] : v.key
      const c = counts.get(key) || { value: key, label: v.label, n: 0, test: Boolean(v.test) }
      c.n += 1
      counts.set(key, c)
    }
    const values = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 300)
    return envelope(ctx, { field, type: def.type, entity: kind, values, truncated: counts.size > 300 })
  })
}

export { UNIVERSAL_STAGE_LABELS }
