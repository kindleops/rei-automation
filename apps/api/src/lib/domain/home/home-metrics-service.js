/**
 * HOME METRICS — the few period figures Home widgets show (Brief wave and
 * market count, the Analytics widget's metric/delta/rate/series, the
 * market selector), without the full analytics_performance bundle.
 *
 * The bundle is one SQL statement computing ~40 metrics over both periods
 * plus campaigns, cohorts, buyers and closings; under production load it
 * exceeds PostgREST's 8s authenticator statement_timeout and Home widgets
 * fail. Here the messaging/stage facts for [prevStart, end) are read as
 * narrow indexed range scans and counted in JS with the bundle's exact
 * predicates (canary rule, sent/delivered/failed, distinct conversations,
 * opt-out/positive intent, test history excluded, inner join to
 * opportunities, UTC date_trunc buckets), so the numbers are identical.
 * Comparison guards (compareCount / compareRate / priorHasData) are the
 * Analytics service's own functions.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { OPTOUT_INTENTS, POSITIVE_INTENTS } from '@/lib/domain/metrics/war-room-service.js'
import { compareCount, compareRate, METRICS, resolvePeriod } from '@/lib/domain/analytics/analytics-performance-service.js'
import {
  attributeReplies, canaryPhoneSet, clean, isCountedTransition, isDelivered, isExcludedRow, isFailed, isSent,
  marketTable, pagedRange, propertyIndex,
} from './home-read-kit.js'

export const METRIC_RANGES = Object.freeze(['today', '7d', '30d', '90d'])
export const EVENT_KEYS = Object.freeze(['send_rows', 'sent', 'delivered', 'delivered_conversations', 'failed', 'reply_messages', 'replied_conversations', 'positive_conversations', 'opt_out_conversations', 'opportunities_created', 'stage_advancements'])
const CONTRACT_KEYS = ['sent', 'delivered', 'delivered_conversations', 'failed', 'replied_conversations', 'positive_conversations', 'opt_out_conversations', 'opportunities_created', 'stage_advancements', 'reply_rate', 'delivery_rate', 'opt_out_rate']

const SEND_COLUMNS = 'id,thread_key,queue_status,created_at,sent_at,delivered_at,delivery_confirmed,property_id,source,from_phone_number,to_phone_number,md_canary:metadata->>internal_canary,md_kpi:metadata->>exclude_from_kpis'
const INBOUND_COLUMNS = 'id,thread_key,created_at,detected_intent,is_opt_out,opt_out_keyword,property_id,from_phone_number,to_phone_number,md_canary:metadata->>internal_canary'

const POS = new Set([...POSITIVE_INTENTS].map((x) => String(x).toLowerCase()))
const OPT = new Set([...OPTOUT_INTENTS].map((x) => String(x).toLowerCase()))
const intentOf = (m) => String(m.detected_intent ?? '').toLowerCase()
export const isOptOut = (m) => m.is_opt_out === true || m.opt_out_keyword != null || OPT.has(intentOf(m))
export const isPositive = (m) => POS.has(intentOf(m))

/** Postgres date_trunc(bucket, ts) in UTC (the database timezone). */
export function truncUtc(ms, bucket) {
  const d = new Date(ms)
  if (bucket === 'hour') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours())
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  if (bucket === 'week') return day - ((d.getUTCDay() + 6) % 7) * 86_400_000 // ISO week starts Monday
  return day
}

/** generate_series(date_trunc(bucket, start), end - 1s, '1 bucket'). */
export function bucketStarts(startIso, endIso, bucket) {
  const step = bucket === 'hour' ? 3_600_000 : bucket === 'week' ? 7 * 86_400_000 : 86_400_000
  const out = []
  for (let t = truncUtc(Date.parse(startIso), bucket); t <= Date.parse(endIso) - 1000; t += step) out.push(t)
  return out
}

const countDistinct = (rows, key = (r) => r.thread_key) => { const s = new Set(); for (const r of rows) { const k = key(r); if (k != null) s.add(String(k)) } return s.size }

/** The bundle's per-period totals from already-filtered fact rows. */
export function periodTotals({ sends, inbound, hist }) {
  const delivered = sends.filter(isDelivered)
  return {
    send_rows: sends.length,
    sent: sends.filter(isSent).length,
    delivered: delivered.length,
    delivered_conversations: countDistinct(delivered),
    failed: sends.filter(isFailed).length,
    reply_messages: inbound.length,
    replied_conversations: countDistinct(inbound),
    positive_conversations: countDistinct(inbound.filter(isPositive)),
    opt_out_conversations: countDistinct(inbound.filter(isOptOut)),
    opportunities_created: hist.filter((h) => h.event_type === 'opportunity_created').length,
    stage_advancements: hist.filter((h) => h.event_type === 'stage_transition').length,
  }
}

export function buildSeries({ sends, inbound, hist }, period) {
  const starts = bucketStarts(period.start, period.end, period.bucket)
  const idx = new Map(starts.map((t, i) => [t, i]))
  const rows = starts.map((t) => ({ at: new Date(t).toISOString(), delivered: 0, failed: 0, replied: new Set(), optOuts: new Set(), advancements: 0 }))
  const slot = (iso) => idx.get(truncUtc(Date.parse(iso), period.bucket))
  for (const s of sends) { const i = slot(s.created_at); if (i == null) continue; if (isDelivered(s)) rows[i].delivered += 1; if (isFailed(s)) rows[i].failed += 1 }
  for (const m of inbound) { const i = slot(m.created_at); if (i == null || m.thread_key == null) continue; rows[i].replied.add(String(m.thread_key)); if (isOptOut(m)) rows[i].optOuts.add(String(m.thread_key)) }
  for (const h of hist) { if (h.event_type !== 'stage_transition') continue; const i = slot(h.created_at); if (i != null) rows[i].advancements += 1 }
  return rows.map((r) => ({ at: r.at, delivered: r.delivered, failed: r.failed, replied: r.replied.size, optOuts: r.optOuts.size, advancements: r.advancements }))
}

export function shapeMetrics({ cur, prev }) {
  const priorHasData = prev.send_rows + prev.reply_messages > 0
  return {
    totals: { cur, prev },
    rates: {
      reply_rate: compareRate(cur.replied_conversations, cur.delivered_conversations, prev.replied_conversations, prev.delivered_conversations),
      delivery_rate: compareRate(cur.delivered, cur.sent, prev.delivered, prev.sent),
      opt_out_rate: compareRate(cur.opt_out_conversations, cur.delivered_conversations, prev.opt_out_conversations, prev.delivered_conversations),
      positive_share: compareRate(cur.positive_conversations, cur.replied_conversations, prev.positive_conversations, prev.replied_conversations, { minDen: 15 }),
    },
    priorHasData,
    compare: priorHasData ? Object.fromEntries(EVENT_KEYS.filter((k) => METRICS[k]?.kind === 'event').map((k) => [k, compareCount(cur[k], prev[k])])) : {},
  }
}

async function readFacts(client, period, phones, { needPlaces, market }) {
  const inWindow = (q) => q.gte('created_at', period.prevStart).lt('created_at', period.end)
  const [sendRows, inboundRows, histRows] = await Promise.all([
    pagedRange((first) => inWindow(client.from('send_queue').select(SEND_COLUMNS, first ? { count: 'exact' } : undefined)), 'send_queue'),
    pagedRange((first) => inWindow(client.from('message_events').select(INBOUND_COLUMNS, first ? { count: 'exact' } : undefined).eq('direction', 'inbound')), 'message_events'),
    // the bundle's hist CTE inner-joins acquisition_opportunities (FK embed)
    pagedRange((first) => inWindow(client.from('acquisition_opportunity_history').select('id,opportunity_id,event_type,actor,reason,created_at,opp:acquisition_opportunities!inner(primary_property_id)', first ? { count: 'exact' } : undefined).in('event_type', ['stage_transition', 'opportunity_created'])), 'acquisition_opportunity_history'),
  ])
  const sends = sendRows.filter((s) => !isExcludedRow(s, phones))
  const inbound = inboundRows.filter((m) => !isExcludedRow(m, phones))
  const hist = histRows.filter(isCountedTransition)
  if (!needPlaces) return { sends, inbound, hist }

  // Market of each fact, exactly as the bundle assigns it.
  const startMs = Date.parse(period.start)
  const curSends = market ? sends : sends.filter((s) => Date.parse(s.created_at) >= startMs)
  const [sendProps, replyPlaces, histProps] = await Promise.all([
    propertyIndex(client, curSends.map((s) => s.property_id)),
    market ? attributeReplies(client, inbound, period.end) : Promise.resolve(null),
    market ? propertyIndex(client, hist.map((h) => h.opp?.primary_property_id)) : Promise.resolve(null),
  ])
  for (const s of curSends) s.mkt = sendProps.get(clean(s.property_id))?.mkt ?? null
  if (replyPlaces) for (const r of replyPlaces) r.m.mkt = r.mkt
  if (histProps) for (const h of hist) h.mkt = histProps.get(clean(h.opp?.primary_property_id))?.mkt ?? null
  return { sends, inbound, hist }
}

export async function getHomeMetrics({ range = '7d', start = null, end = null, market = null, withMarkets = false } = {}, deps = {}) {
  const client = deps.supabase || defaultSupabase
  const period = resolvePeriod({ range, start, end, now: deps.now ?? Date.now() })
  const marketId = clean(market) || null
  const t0 = Date.now()
  const namesP = marketTable(client).catch(() => new Map())
  const facts = await readFacts(client, period, canaryPhoneSet(), { needPlaces: Boolean(marketId || withMarkets), market: marketId })
  const scoped = marketId
    ? { sends: facts.sends.filter((s) => s.mkt === marketId), inbound: facts.inbound.filter((m) => m.mkt === marketId), hist: facts.hist.filter((h) => h.mkt === marketId) }
    : facts
  const startMs = Date.parse(period.start)
  const split = (rows) => ({ cur: rows.filter((r) => Date.parse(r.created_at) >= startMs), prev: rows.filter((r) => Date.parse(r.created_at) < startMs) })
  const S = split(scoped.sends)
  const I = split(scoped.inbound)
  const H = split(scoped.hist)
  const cur = periodTotals({ sends: S.cur, inbound: I.cur, hist: H.cur })
  const prev = periodTotals({ sends: S.prev, inbound: I.prev, hist: H.prev })
  const names = await namesP

  let markets = null
  if (withMarkets) {
    // The bundle's market rows (canonical markets only) with current-period
    // messaging; `cur` carries the same keys the bundle's market `cur` does.
    const byMkt = new Map()
    for (const s of facts.sends) {
      if (Date.parse(s.created_at) < startMs || !s.mkt || !names.has(s.mkt)) continue
      const m = byMkt.get(s.mkt) ?? { delivered: 0, failed: 0, threads: new Set() }
      if (isDelivered(s)) { m.delivered += 1; if (s.thread_key != null) m.threads.add(String(s.thread_key)) }
      if (isFailed(s)) m.failed += 1
      byMkt.set(s.mkt, m)
    }
    markets = [...byMkt.entries()].map(([id, c]) => ({ id, name: names.get(id).name, state: names.get(id).state, cur: { delivered: c.delivered, delivered_conversations: c.threads.size, failed: c.failed } }))
      .sort((a, b) => b.cur.delivered - a.cur.delivered || a.name.localeCompare(b.name))
  }

  return {
    generatedAt: new Date().toISOString(),
    queryMs: Date.now() - t0,
    period,
    scope: { market: marketId, marketName: marketId ? names.get(marketId)?.name ?? null : null },
    metrics: Object.fromEntries(CONTRACT_KEYS.map((k) => [k, METRICS[k]])),
    ...shapeMetrics({ cur, prev }),
    series: buildSeries({ sends: S.cur, inbound: I.cur, hist: H.cur }, period),
    markets,
    source: 'send_queue + message_events inbound + acquisition_opportunity_history, analytics_performance rules',
  }
}

