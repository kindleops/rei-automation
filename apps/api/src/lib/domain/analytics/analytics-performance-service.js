/**
 * ANALYTICS — performance of the acquisition machine for a period, against the
 * immediately preceding period of equal length.
 *
 * One bounded aggregate (analytics_performance RPC) + deterministic derivation
 * here. Every metric the surface shows is declared in METRICS with its
 * numerator, denominator, grain, source and whether it is an EVENT in the
 * period or CURRENT STATE (not governed by the period). Nothing is estimated
 * and presented as actual; nothing is generated as prose — "what changed" and
 * the story of the period are rules over these numbers.
 *
 * Shared definitions (not re-derived): war-room's intent sets and canary
 * exclusion, Pipeline's stage order / groups / stall thresholds / synthetic-
 * history rule, the canonical market system.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { INTERNAL_TEST_PHONE_SET } from '@/lib/config/internal-phones.js'
import { OPTOUT_INTENTS, POSITIVE_INTENTS } from '@/lib/domain/metrics/war-room-service.js'
import { DORMANT_DAYS, STAGE_GROUPS, STAGE_INDEX, STAGE_MAX_DAYS } from '@/lib/domain/opportunity/pipeline-command-service.js'
import { UNIVERSAL_STAGE_LABELS, UNIVERSAL_STAGE_ORDER } from '@/lib/domain/opportunity/universal-pipeline-registry.js'

const DAY = 86_400_000
const clean = (v) => String(v ?? '').trim()
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const arr = (v) => (Array.isArray(v) ? v : [])
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

/* ── metric contract ──────────────────────────────────────────────────── */

const SQ = 'send_queue (canary excluded)'
const ME = 'message_events inbound (canary excluded)'
export const METRICS = {
  delivered_conversations: { label: 'Sellers reached', unit: 'sellers', kind: 'event', grain: 'distinct conversations', definition: 'Distinct seller conversations with a delivered message created in the period', source: SQ, good: 'neutral' },
  delivered: { label: 'Messages delivered', unit: 'messages', kind: 'event', grain: 'messages', definition: 'send_queue rows created in the period that delivered', source: SQ, good: 'neutral' },
  sent: { label: 'Messages sent', unit: 'messages', kind: 'event', grain: 'messages', definition: 'send_queue rows created in the period that were sent', source: SQ, good: 'neutral' },
  replied_conversations: { label: 'Sellers replied', unit: 'sellers', kind: 'event', grain: 'distinct conversations', definition: 'Distinct seller conversations with an inbound reply in the period', source: ME, good: 'up' },
  positive_conversations: { label: 'Positive replies', unit: 'sellers', kind: 'event', grain: 'distinct conversations', definition: 'Conversations whose reply intent was interest, ownership confirmed, asking price or asks for an offer', source: `${ME}.detected_intent`, good: 'up' },
  opt_out_conversations: { label: 'Opt-outs', unit: 'sellers', kind: 'event', grain: 'distinct conversations', definition: 'Conversations that opted out in the period (flag, keyword or opt-out intent)', source: ME, good: 'down' },
  reply_rate: { label: 'Reply rate', unit: '%', kind: 'rate', grain: 'conversations', definition: 'Sellers replied ÷ sellers reached (distinct conversations, same period)', numerator: 'replied_conversations', denominator: 'delivered_conversations', source: `${SQ} + ${ME}`, good: 'up' },
  delivery_rate: { label: 'Delivery rate', unit: '%', kind: 'rate', grain: 'messages', definition: 'Delivered ÷ sent (messages created in the period)', numerator: 'delivered', denominator: 'sent', source: SQ, good: 'up' },
  opt_out_rate: { label: 'Opt-out rate', unit: '%', kind: 'rate', grain: 'conversations', definition: 'Opt-outs ÷ sellers reached', numerator: 'opt_out_conversations', denominator: 'delivered_conversations', source: `${SQ} + ${ME}`, good: 'down' },
  opportunities_created: { label: 'Opportunities created', unit: 'opportunities', kind: 'event', grain: 'opportunities', definition: 'opportunity_created events in the period (the June backfill has none)', source: 'acquisition_opportunity_history', good: 'up' },
  stage_advancements: { label: 'Stage advancements', unit: 'transitions', kind: 'event', grain: 'transitions', definition: 'stage_transition events in the period, certification/probe rows excluded', source: 'acquisition_opportunity_history', good: 'up' },
  offers_issued: { label: 'Offers issued', unit: 'offers', kind: 'event', grain: 'offers', definition: 'seller_offers created in the period (not seller counters)', source: 'seller_offers', good: 'up' },
  contracts: { label: 'Contracts', unit: 'contracts', kind: 'event', grain: 'closing cases', definition: 'Closing cases with a contract signed date in the period', source: 'closing_cases.contract_signed_date', good: 'up' },
  closed: { label: 'Closed', unit: 'deals', kind: 'event', grain: 'closing cases', definition: 'Closing cases recorded or funded in the period (actual, not projected)', source: 'closing_cases.recording_date / funding_date', good: 'up' },
  failed: { label: 'Delivery failures', unit: 'messages', kind: 'event', grain: 'messages', definition: 'Rows that failed (failed / failed_transport / undelivered)', source: SQ, good: 'down' },
  health_guard_blocks: { label: 'Sender-health blocks', unit: 'messages', kind: 'event', grain: 'messages', definition: 'Rows held by the sender / template health guard', source: SQ, good: 'down' },
  content_blocks: { label: 'Content blocks', unit: 'messages', kind: 'event', grain: 'messages', definition: 'Rows blocked for content (blank body, carrier content filter)', source: SQ, good: 'down' },
  buyer_purchases: { label: 'Buyer purchases', unit: 'purchases', kind: 'event', grain: 'recorded transactions', definition: 'Arm’s-length purchases by identity-resolved buyers in the period', source: 'recorded transactions (buyer-resolved)', good: 'neutral' },
  automation_exceptions: { label: 'Automation exceptions', unit: 'runs', kind: 'event', grain: 'automation runs', definition: 'Autopilot runs that failed or were held for review (unclear, missing context, review required)', source: 'seller_automation_executions', good: 'down' },
}

/* ── windows ──────────────────────────────────────────────────────────── */

export const RANGES = ['today', '7d', '30d', '90d', 'ytd', 'custom']
/**
 * Resolve the period. `today`/`ytd` boundaries come from the operator's
 * device (start ISO) when supplied so "today" is THEIR midnight; the prior
 * period is always the equal-length span immediately before.
 */
export function resolvePeriod({ range = '30d', start = null, end = null, now = Date.now() } = {}) {
  const r = RANGES.includes(range) ? range : '30d'
  const endMs = num(Date.parse(end)) ?? now
  let startMs
  if (r === 'custom' || ((r === 'today' || r === 'ytd') && num(Date.parse(start)) !== null)) startMs = Date.parse(start)
  else if (r === 'today') startMs = endMs - (endMs % DAY)
  else if (r === 'ytd') startMs = Date.UTC(new Date(endMs).getUTCFullYear(), 0, 1)
  else startMs = endMs - ({ '7d': 7, '30d': 30, '90d': 90 }[r] ?? 30) * DAY
  if (!Number.isFinite(startMs) || startMs >= endMs) startMs = endMs - 30 * DAY
  startMs = Math.max(startMs, endMs - 400 * DAY)
  const span = endMs - startMs
  const days = span / DAY
  return {
    range: r,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    prevStart: new Date(startMs - span).toISOString(),
    prevEnd: new Date(startMs).toISOString(),
    days: Math.round(days * 10) / 10,
    bucket: days <= 2 ? 'hour' : days <= 62 ? 'day' : 'week',
  }
}

/* ── comparison ───────────────────────────────────────────────────────── */

/** Counts: absolute always; percentage only when the base can carry one. */
export function compareCount(cur, prev, { minBase = 10 } = {}) {
  const c = num(cur) ?? 0
  const p = num(prev) ?? 0
  const delta = c - p
  const pct = p >= minBase ? Math.round((delta / p) * 1000) / 10 : null
  return { cur: c, prev: p, delta, pct, basis: p >= minBase ? 'percent' : 'absolute' }
}

/** Rates: percentage-point change only when both denominators are meaningful. */
export function compareRate(curNum, curDen, prevNum, prevDen, { minDen = 30 } = {}) {
  const rate = (n, d) => (num(d) && num(d) > 0 ? num(n) / num(d) : null)
  const c = rate(curNum, curDen)
  const p = rate(prevNum, prevDen)
  const comparable = (num(curDen) ?? 0) >= minDen && (num(prevDen) ?? 0) >= minDen && c !== null && p !== null
  return {
    cur: c, prev: p,
    pp: comparable ? Math.round((c - p) * 1000) / 10 : null,
    sample: { cur: num(curDen) ?? 0, prev: num(prevDen) ?? 0 },
    reliable: (num(curDen) ?? 0) >= minDen,
  }
}

const tone = (key, delta) => {
  const g = METRICS[key]?.good
  if (!delta || g === 'neutral' || !g) return 'neutral'
  return (delta > 0) === (g === 'up') ? 'good' : 'bad'
}

/**
 * Material change only: counts move ≥ max(5, 25% of the prior base) with a
 * base of ≥10 on either side; rates move ≥ 3 points with ≥30 in both
 * denominators. Everything else is noise and is not reported.
 */
export function whatChanged(cur = {}, prev = {}, markets = []) {
  const out = []
  for (const key of ['replied_conversations', 'delivered_conversations', 'positive_conversations', 'opt_out_conversations', 'opportunities_created', 'stage_advancements', 'failed', 'health_guard_blocks', 'content_blocks']) {
    const c = compareCount(cur[key], prev[key])
    const base = Math.max(c.cur, c.prev)
    if (base < 10 || Math.abs(c.delta) < Math.max(5, 0.25 * c.prev)) continue
    out.push({ key, kind: 'count', label: METRICS[key].label, delta: c.delta, pct: c.pct, cur: c.cur, prev: c.prev, tone: tone(key, c.delta), weight: Math.abs(c.delta) / Math.max(1, c.prev) })
  }
  for (const [key, n, d] of [['reply_rate', 'replied_conversations', 'delivered_conversations'], ['delivery_rate', 'delivered', 'sent'], ['opt_out_rate', 'opt_out_conversations', 'delivered_conversations']]) {
    const r = compareRate(cur[n], cur[d], prev[n], prev[d])
    if (r.pp === null || Math.abs(r.pp) < 3) continue
    out.push({ key, kind: 'rate', label: METRICS[key].label, pp: r.pp, cur: r.cur, prev: r.prev, tone: tone(key, r.pp), weight: Math.abs(r.pp) / 10 })
  }
  for (const m of markets) {
    const d = (num(m.cur?.replied_conversations) ?? 0) - (num(m.prev?.replied_conversations) ?? 0)
    if (Math.abs(d) >= 5) out.push({ key: 'market_replies', kind: 'market', market: m.id, label: m.name, delta: d, cur: m.cur.replied_conversations, prev: m.prev.replied_conversations, tone: d > 0 ? 'good' : 'bad', weight: Math.abs(d) / Math.max(3, m.prev.replied_conversations) })
  }
  return out.sort((a, b) => b.weight - a.weight).slice(0, 8)
}

/* ── lifecycle ────────────────────────────────────────────────────────── */

/** Flow per stage from real transition events + current inventory from state. */
export function buildFlow(transitions = [], active = [], now = Date.now()) {
  const cur = transitions.filter((t) => t.per === 'cur' && t.type === 'stage_transition')
  const created = transitions.filter((t) => t.per === 'cur' && t.type === 'opportunity_created').length
  const stages = UNIVERSAL_STAGE_ORDER.map((code) => {
    const entered = cur.filter((t) => t.to === code)
    const exited = cur.filter((t) => t.from === code)
    const advancedOut = exited.filter((t) => (STAGE_INDEX[t.to] ?? 0) > (STAGE_INDEX[code] ?? 0))
    const dwell = exited.map((t) => (t.prev_at ? (Date.parse(t.at) - Date.parse(t.prev_at)) / 3_600_000 : null)).filter((h) => h !== null && h >= 0)
    const inv = active.filter((o) => o.stage === code)
    const live = inv.filter((o) => o.last_activity_at && now - Date.parse(o.last_activity_at) < DORMANT_DAYS * DAY)
    const ages = live.map((o) => (o.stage_entered_at ? (now - Date.parse(o.stage_entered_at)) / DAY : null)).filter((d) => d !== null && d >= 0)
    const maxDays = STAGE_MAX_DAYS[code] ?? null
    const stalled = maxDays ? live.filter((o) => o.stage_entered_at && (now - Date.parse(o.stage_entered_at)) / DAY > maxDays) : []
    return {
      code, index: STAGE_INDEX[code], label: UNIVERSAL_STAGE_LABELS[code] ?? code,
      entered: entered.length, exited: exited.length, advanced: advancedOut.length,
      medianHoursInStage: dwell.length >= 3 ? Math.round(median(dwell) * 10) / 10 : null, dwellSample: dwell.length,
      active: inv.length, live: live.length, dormant: inv.length - live.length,
      medianAgeDays: ages.length ? Math.round(median(ages) * 10) / 10 : null,
      stalled: stalled.length, stallThresholdDays: maxDays,
      stalledIds: stalled.map((o) => o.id).slice(0, 50),
      enteredIds: entered.map((t) => t.opportunity_id).slice(0, 50),
    }
  })
  // A bottleneck is where LIVE opportunities are aging past the stage's own
  // threshold — never simply the stage with the most rows.
  const candidates = stages.filter((s) => s.live >= 3 && s.stalled >= 2)
  const bottleneck = candidates.sort((a, b) => b.stalled / b.live - a.stalled / a.live || b.stalled - a.stalled)[0] || null
  const bySource = cur.reduce((m, t) => { const k = /autopilot|orchestrator/i.test(`${t.source} ${t.reason}`) ? 'autopilot' : 'operator'; m[k] = (m[k] ?? 0) + 1; return m }, {})
  return {
    created, advancements: cur.length, bySource, stages,
    groups: STAGE_GROUPS.map((g) => ({ key: g.key, label: g.label, active: stages.filter((s) => g.stages.includes(s.code)).reduce((n, s) => n + s.live, 0) })),
    bottleneck: bottleneck ? { code: bottleneck.code, label: bottleneck.label, live: bottleneck.live, stalled: bottleneck.stalled, medianAgeDays: bottleneck.medianAgeDays, thresholdDays: bottleneck.stallThresholdDays, ids: bottleneck.stalledIds } : null,
  }
}

/* ── story ────────────────────────────────────────────────────────────── */

export function storyOfPeriod({ totals, flow, markets, range }) {
  const c = totals.cur
  const lines = []
  if (c.delivered_conversations) lines.push({ k: 'reached', value: c.delivered_conversations, text: `${c.delivered_conversations.toLocaleString('en-US')} sellers reached` })
  if (c.replied_conversations) lines.push({ k: 'replied', value: c.replied_conversations, text: `${c.replied_conversations.toLocaleString('en-US')} replied` })
  if (c.positive_conversations) lines.push({ k: 'positive', value: c.positive_conversations, text: `${c.positive_conversations} showed interest` })
  if (flow.advancements) lines.push({ k: 'advanced', value: flow.advancements, text: `${flow.advancements} stage advancement${flow.advancements === 1 ? '' : 's'}` })
  if (c.offers_issued) lines.push({ k: 'offers', value: c.offers_issued, text: `${c.offers_issued} offer${c.offers_issued === 1 ? '' : 's'} issued` })
  if (c.contracts) lines.push({ k: 'contracts', value: c.contracts, text: `${c.contracts} contract${c.contracts === 1 ? '' : 's'} signed` })
  if (c.closed) lines.push({ k: 'closed', value: c.closed, text: `${c.closed} deal${c.closed === 1 ? '' : 's'} closed` })
  const notes = []
  const topReply = [...markets].sort((a, b) => (b.cur.replied_conversations ?? 0) - (a.cur.replied_conversations ?? 0))[0]
  if (topReply?.cur?.replied_conversations >= 3) notes.push(`${topReply.name} produced the most seller replies (${topReply.cur.replied_conversations}).`)
  if (flow.bottleneck) notes.push(`${flow.bottleneck.label} is where live deals are aging: ${flow.bottleneck.stalled} of ${flow.bottleneck.live} past ${flow.bottleneck.thresholdDays} days.`)
  if (!c.offers_issued && !c.contracts && !c.closed) notes.push('No offers, contracts or closings were recorded in this period.')
  return { range, lines, notes }
}

/* ── markets / campaigns ──────────────────────────────────────────────── */

const rate = (n, d) => (num(d) && num(d) > 0 ? Math.round((num(n) / num(d)) * 1000) / 10 : null)
export function shapeMarket(m) {
  const cur = obj(m.cur)
  const prev = obj(m.prev)
  return {
    id: m.id, name: m.name, state: m.state, lat: num(m.lat), lng: num(m.lng),
    cur, prev,
    replyRate: cur.delivered_conversations >= 20 ? rate(cur.replied_conversations, cur.delivered_conversations) : null,
    prevReplyRate: prev.delivered_conversations >= 20 ? rate(prev.replied_conversations, prev.delivered_conversations) : null,
    optOutRate: cur.delivered_conversations >= 20 ? rate(cur.opt_out_conversations, cur.delivered_conversations) : null,
    activeOpportunities: num(m.active_opportunities) ?? 0,
    dormantOpportunities: num(m.dormant_opportunities) ?? 0,
  }
}

/** Certification / synthetic / proof campaigns are real rows but not business performance. */
export const isTestCampaign = (name) => /^zz[-_ ]|synthetic|certification|\bproof\b|\bcanary\b|\bqa\b/i.test(clean(name))

export function shapeCampaign(c, opps = {}) {
  const o = obj(opps[c.id])
  return {
    test: isTestCampaign(c.name),
    id: c.id, name: clean(c.name) || 'Campaign', status: c.status || null, market: c.market || null,
    sends: num(c.sends) ?? 0, delivered: num(c.delivered) ?? 0, failed: num(c.failed) ?? 0,
    reached: num(c.delivered_conversations) ?? 0, replied: num(c.replied_conversations) ?? 0,
    positive: num(c.positive_conversations) ?? 0, optOuts: num(c.opt_out_conversations) ?? 0,
    replyRate: (num(c.delivered_conversations) ?? 0) >= 20 ? rate(c.replied_conversations, c.delivered_conversations) : null,
    opportunities: num(o.opportunities) ?? 0, reachedAskingPrice: num(o.reached_asking_price) ?? 0, reachedOffer: num(o.reached_offer) ?? 0,
  }
}

/* ── workspace ────────────────────────────────────────────────────────── */

function canaryPhones() {
  const out = new Set()
  for (const p of INTERNAL_TEST_PHONE_SET) {
    const d = String(p).replace(/\D/g, '')
    out.add(String(p)); out.add(d); out.add(`+${d}`); if (d.length === 11) out.add(d.slice(1))
  }
  return [...out]
}

async function disposition(client, period) {
  const safe = async (q) => { try { const r = await q; return r.error ? null : r.count ?? arr(r.data).length } catch { return null } }
  const inP = (q, col) => q.gte(col, period.start).lt(col, period.end)
  const [targets, contacted, offers, selected, committed, agreements, emd] = await Promise.all([
    safe(inP(client.from('buyer_outreach_targets').select('id', { count: 'exact', head: true }), 'created_at')),
    safe(inP(client.from('buyer_outreach_targets').select('id', { count: 'exact', head: true }).in('status', ['sent', 'delivered', 'replied']), 'created_at')),
    safe(inP(client.from('buyer_offers').select('id', { count: 'exact', head: true }), 'created_at')),
    safe(inP(client.from('buyer_offers').select('id', { count: 'exact', head: true }).not('selected_at', 'is', null), 'selected_at')),
    safe(inP(client.from('buyer_offers').select('id', { count: 'exact', head: true }).eq('commitment_status', 'committed'), 'committed_at')),
    safe(inP(client.from('buyer_agreements').select('id', { count: 'exact', head: true }).not('executed_at', 'is', null), 'executed_at')),
    safe(inP(client.from('buyer_offers').select('id', { count: 'exact', head: true }).not('emd_received_at', 'is', null), 'emd_received_at')),
  ])
  return { outreachTargets: targets, contacted, offers, selected, committed, agreementsExecuted: agreements, emdReceived: emd }
}

export async function getAnalyticsPerformance({ range = '30d', start = null, end = null, market = null } = {}, deps = {}) {
  const client = deps.supabase || defaultSupabase
  const period = resolvePeriod({ range, start, end, now: deps.now ?? Date.now() })
  const marketId = clean(market) || null
  const t0 = Date.now()
  const [{ data, error }, dispo] = await Promise.all([
    client.rpc('analytics_performance', {
      p_start: period.start, p_end: period.end, p_prev_start: period.prevStart, p_prev_end: period.prevEnd,
      p_exclude: canaryPhones(), p_positive: [...POSITIVE_INTENTS], p_optout: [...OPTOUT_INTENTS],
      p_market: marketId, p_bucket: period.bucket,
    }),
    disposition(client, period),
  ])
  if (error) throw error
  const raw = obj(data)
  const totals = { cur: obj(raw.totals?.cur), prev: obj(raw.totals?.prev) }
  const markets = arr(raw.markets).map(shapeMarket)
  const flow = buildFlow(arr(raw.transitions), arr(raw.active))
  const c = totals.cur
  const p = totals.prev
  // A prior period before the business had any traffic is not a comparison.
  const priorHasData = (num(p.send_rows) ?? 0) + (num(p.reply_messages) ?? 0) > 0

  // Cohort labels: addresses for the (bounded) property ids we will list.
  const cohortProps = new Set([
    ...arr(raw.reply_cohort).map((r) => r.property_id),
    ...arr(raw.transitions).filter((t) => t.per === 'cur').map((t) => t.property_id),
    ...arr(raw.active).filter((o) => flow.stages.some((s) => s.stalledIds.includes(o.id))).map((o) => o.property_id),
  ].filter(Boolean).slice(0, 300))
  const addrRes = cohortProps.size
    ? await client.from('properties').select('property_id, property_address_full, latitude, longitude').in('property_id', [...cohortProps])
    : { data: [] }
  const addr = new Map(arr(addrRes.data).map((r) => [clean(r.property_id), r]))
  const marketName = new Map(markets.map((m) => [m.id, m.name]))
  const where = (pid, mkt) => ({ address: clean(addr.get(clean(pid))?.property_address_full) || null, market: marketName.get(mkt) ?? null, lat: num(addr.get(clean(pid))?.latitude), lng: num(addr.get(clean(pid))?.longitude) })

  return {
    generatedAt: new Date().toISOString(),
    queryMs: Date.now() - t0,
    period,
    scope: { market: marketId, marketName: marketId ? marketName.get(marketId) ?? null : null },
    metrics: METRICS,
    totals,
    rates: {
      reply_rate: compareRate(c.replied_conversations, c.delivered_conversations, p.replied_conversations, p.delivered_conversations),
      delivery_rate: compareRate(c.delivered, c.sent, p.delivered, p.sent),
      opt_out_rate: compareRate(c.opt_out_conversations, c.delivered_conversations, p.opt_out_conversations, p.delivered_conversations),
      positive_share: compareRate(c.positive_conversations, c.replied_conversations, p.positive_conversations, p.replied_conversations, { minDen: 15 }),
    },
    priorHasData,
    compare: priorHasData ? Object.fromEntries(Object.keys(METRICS).filter((k) => METRICS[k].kind === 'event').map((k) => [k, compareCount(c[k], p[k])])) : {},
    latency: { medianMinutes: num(raw.latency?.median_minutes), sample: num(raw.latency?.sample) ?? 0 },
    series: arr(raw.series).map((s) => ({ at: s.at, delivered: s.delivered, failed: s.failed, replied: s.replied_conversations, optOuts: s.opt_outs, advancements: s.advancements })),
    changes: priorHasData ? whatChanged(c, p, markets) : [],
    story: storyOfPeriod({ totals, flow, markets, range: period.range }),
    flow,
    campaigns: arr(raw.campaigns).map((row) => shapeCampaign(row, obj(raw.campaign_opportunities)))
      .filter((row) => row.sends > 0 || row.replied > 0)
      .sort((a, b) => Number(a.test) - Number(b.test) || b.reached - a.reached),
    markets,
    zips: arr(raw.zips).map((z) => ({ zip: z.zip, market: z.market, lat: num(z.lat), lng: num(z.lng), delivered: num(z.delivered) ?? 0, replied: num(z.replied_conversations) ?? 0, failed: num(z.failed) ?? 0, buyerPurchases: num(z.buyer_purchases) ?? 0 })),
    automation: {
      runs: c.automation_runs ?? 0, succeeded: c.automation_succeeded ?? 0, heldByGate: c.automation_held_by_gate ?? 0,
      needsReview: c.automation_needs_review ?? 0, policyBlocks: c.automation_policy_blocks ?? 0, failed: c.automation_failed ?? 0,
      decisions: c.decisions ?? 0, escalated: c.decisions_escalated ?? 0,
      blockReasons: obj(raw.automation_block_reasons), decisionActions: obj(raw.decision_actions),
      sendsAutomated: c.sends_automated ?? 0, sendsOperator: c.sends_operator ?? 0,
      sendsUnattributed: Math.max(0, (c.sent ?? 0) - (c.sends_automated ?? 0) - (c.sends_operator ?? 0)),
    },
    operations: {
      failed: c.failed ?? 0, failedTransport: c.failed_transport ?? 0, healthGuardBlocks: c.health_guard_blocks ?? 0, contentBlocks: c.content_blocks ?? 0,
      expired: c.expired ?? 0, cancelled: c.cancelled ?? 0, medianSendDelayMin: num(c.median_send_delay_min),
      backlogPending: num(raw.backlog?.pending) ?? 0, backlogOldest: raw.backlog?.oldest_scheduled ?? null,
    },
    deals: {
      offers: arr(raw.offers).filter((o) => o.per === 'cur').map((o) => ({ ...o, ...where(o.property_id, o.market) })),
      closings: arr(raw.closings).map((x) => ({ ...x, ...where(x.property_id, x.market) })),
    },
    disposition: dispo,
    buyers: { purchases: c.buyer_purchases ?? 0, entities: c.buyer_entities ?? 0, repeatPurchases: c.repeat_buyer_purchases ?? 0, dataThrough: raw.buyer_data_through ?? null },
    cohorts: {
      replies: arr(raw.reply_cohort).map((r) => ({ threadKey: r.thread_key, at: r.at, intent: r.intent || null, optOut: !!r.opt_out, positive: !!r.positive, propertyId: r.property_id || null, ...where(r.property_id, r.market) })),
      transitions: arr(raw.transitions).filter((t) => t.per === 'cur').map((t) => ({ opportunityId: t.opportunity_id, type: t.type, from: t.from, to: t.to, at: t.at, source: t.source, reason: t.reason, propertyId: t.property_id, ...where(t.property_id, t.market) })),
      stalled: arr(raw.active).filter((o) => flow.stages.some((s) => s.stalledIds.includes(o.id))).map((o) => ({ opportunityId: o.id, stage: o.stage, stageEnteredAt: o.stage_entered_at, propertyId: o.property_id, ...where(o.property_id, o.market) })),
    },
    unresolved: obj(raw.unresolved),
    lineage: {
      canary: 'Internal test phones and canary rows excluded (same rule as war-room).',
      stages: 'Stage transitions from acquisition_opportunity_history; certification, probe and fixture rows excluded.',
      geography: 'Property → canonical market; replies inherit the market of the send that prompted them. Unresolved rows are counted, never assigned.',
      buyers: 'Identity-resolved buyers’ arm’s-length recorded purchases; ZIP → canonical market via reviewed ZIP membership.',
    },
  }
}
