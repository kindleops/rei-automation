/**
 * Nexus Metrics War Room — production data service.
 *
 * Aggregates REAL Supabase data only. Primary fact tables:
 *   - public.send_queue      → outbound volume + attribution (state/market/agent/template/campaign)
 *   - public.message_events  → inbound replies + intents (attributed to a thread via thread_key)
 *   - public.sms_templates   → template metadata (name, persona, language, use_case, stage)
 *   - public.campaigns       → real campaign inventory
 *   - public.email_templates / email_events → email channel (currently unwired / empty)
 *
 * No mock / fallback / placeholder data. When a source is empty we return [] and
 * record the reason in source_audit so the UI can show an honest "not wired" state.
 */

import { supabase } from '../lib/supabase/client.js'

const SMS_COST_PER_MSG = 0.0079

// ── Intent classification (mirrors api/cockpit/ops/metrics/_shared.js) ────────
const POSITIVE_INTENTS = new Set([
  'seller_interested', 'asking_price_provided', 'asks_offer',
  'ownership_confirmed', 'price_anchor', 'price_interest',
])
const OPTOUT_INTENTS = new Set(['opt_out', 'stop', 'unsubscribe', 'remove'])
const WRONG_NUM_INTENTS = new Set(['wrong_number', 'wrong_person', 'not_owner', 'wrong_contact'])

const US_STATE_ABBRS = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
])

// Body-derived agent fallback (only used when explicit agent fields + persona absent)
const AGENT_BODY_PATTERNS = [
  /\bthis is (Helen|Jake|Carlos|Carmen|Ernesto|Nathan|Michael|Greg|Sean|Crystal)\b/i,
  /\bsoy (Carlos|Carmen|Ernesto|Nathan|Helen|Jake)\b/i,
  /^(?:Hi|Hello|Hey)[,!]?\s+(?:this is\s+)?(Helen|Jake|Carlos|Carmen|Ernesto|Nathan|Michael|Greg|Sean|Crystal)\b/i,
]

// ── Helpers ───────────────────────────────────────────────────────────────────
const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()

function safeRate(num, den, decimals = 1) {
  if (!den) return 0
  return Number(((num / den) * 100).toFixed(decimals))
}

function parseStateFromMarket(market) {
  if (!market) return null
  const m = String(market).match(/,\s*([A-Z]{2})\s*$/) || String(market).match(/\s([A-Z]{2})\s*$/)
  const abbr = m?.[1] ?? null
  return abbr && US_STATE_ABBRS.has(abbr) ? abbr : null
}

function deriveState(row) {
  const explicit = clean(row.property_address_state).toUpperCase()
  if (explicit && US_STATE_ABBRS.has(explicit)) return explicit
  return parseStateFromMarket(row.market)
}

function parseAgentFromBody(body) {
  if (!body) return null
  for (const pat of AGENT_BODY_PATTERNS) {
    const m = String(body).match(pat)
    if (m?.[1]) return m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()
  }
  return null
}

function isSentRow(row) {
  if (row.sent_at) return true
  return ['sent', 'delivered'].includes(lower(row.queue_status))
}
function isDeliveredRow(row) {
  if (row.delivered_at) return true
  if (lower(row.queue_status) === 'delivered') return true
  const dc = lower(row.delivery_confirmed)
  return dc === 'true' || dc === 'delivered' || dc === 'yes'
}
function isFailedRow(row) {
  // True send/delivery failures only. failed_reason is also set on expired/
  // cancelled/blocked queue rows that were never sent, so it is NOT used here.
  return ['failed', 'failed_transport', 'undelivered'].includes(lower(row.queue_status))
}
function isBlockedRow(row) {
  const s = lower(row.queue_status)
  if (['blocked', 'duplicate_blocked'].includes(s)) return true
  return Boolean(clean(row.blocked_reason) || clean(row.blocked_reasons))
}

// ── Window resolution ───────────────────────────────────────────────────────
function resolveWindow(windowParam) {
  const w = lower(windowParam || '7d')
  const now = new Date()
  const dayMs = 24 * 60 * 60 * 1000
  const days = (n) => ({ start: new Date(now.getTime() - n * dayMs), end: now, label: `${n}d` })

  switch (w) {
    case 'today': {
      const s = new Date(now); s.setHours(0, 0, 0, 0)
      return { start: s, end: now, label: 'today', days: 1 }
    }
    case 'yesterday': {
      const s = new Date(now); s.setHours(0, 0, 0, 0); s.setDate(s.getDate() - 1)
      const e = new Date(now); e.setHours(0, 0, 0, 0); e.setMilliseconds(-1)
      return { start: s, end: e, label: 'yesterday', days: 1 }
    }
    case '24h': return { ...days(1), label: '24h', days: 1 }
    case '48h': return { ...days(2), label: '48h', days: 2 }
    case '7d': case 'last_7_days': return { ...days(7), label: '7d', days: 7 }
    case '30d': case 'last_30_days': return { ...days(30), label: '30d', days: 30 }
    case '40d': case 'last_40_days': return { ...days(40), label: '40d', days: 40 }
    default: return { ...days(7), label: '7d', days: 7 }
  }
}

// Maps to the `time_window` enum used by template_performance_kpis_v.
function windowToViewKey(days, label) {
  if (label === '24h' || label === 'today' || label === 'yesterday') return '24h'
  if (days <= 7) return '7d'
  if (days <= 30) return '30d'
  return 'all_time'
}

// ── Recommendation rules (per production contract) ──────────────────────────
function templateRecommendation({ sent, replyRate, optOutRate, deliveryRate }) {
  if (sent < 10) return 'Needs Data'
  if (optOutRate >= 5) return 'Kill'
  if (replyRate >= 10 && optOutRate < 3) return 'Scale'
  if (deliveryRate < 85 || optOutRate >= 3) return 'Pause'
  return 'Testing'
}

function stateStatus({ sent, replyRate, optOutRate, deliveryRate }) {
  if (sent === 0) return 'quiet'
  if (deliveryRate < 85) return 'blocked'
  if (optOutRate >= 3) return 'warning'
  if (replyRate >= 10 && optOutRate < 2) return 'strong'
  return 'active'
}

function stateRecommendation({ sent, replyRate, optOutRate, deliveryRate }) {
  if (sent < 5) return 'No Data'
  if (optOutRate >= 3) return 'Investigate'
  if (deliveryRate < 85) return 'Pause'
  if (replyRate >= 10 && optOutRate < 1.5) return 'Scale'
  return 'Watch'
}

// Major campaign states always rendered on the tactical map, even at zero volume.
const MAJOR_STATES = ['FL','TX','CA','GA','NC','SC','TN','NV','AZ','MO','MN','IL','MI','OH','PA','MD','VA','OK','AR','AL','MS']

// ── Core builder ──────────────────────────────────────────────────────────────
export async function buildWarRoom(params = {}) {
  const startedAt = Date.now()
  const window = resolveWindow(params.window)
  const channel = lower(params.channel || 'all') || 'all'
  const filterState = clean(params.state).toUpperCase()
  const filterMarket = clean(params.market)
  const filterAgent = clean(params.agent)
  const startIso = window.start.toISOString()
  const endIso = window.end.toISOString()

  const notes = []

  // ── Fetch primary fact tables ─────────────────────────────────────────────
  const SQ_COLS = 'id,queue_status,created_at,sent_at,delivered_at,failed_reason,delivery_confirmed,' +
    'blocked_reason,blocked_reasons,market,property_address_state,property_address_city,' +
    'template_id,selected_template_id,template_key,agent_name,selected_agent_id,sms_agent_id,' +
    'campaign_id,thread_key,message_body,rendered_message,estimated_cost,detected_intent,from_phone_number'
  // message_events has no carrier_name/line_type columns — carrier intel stays unwired.
  const ME_COLS = 'id,direction,delivery_status,provider_delivery_status,detected_intent,is_opt_out,' +
    'opt_out_keyword,thread_key,template_id,market,created_at,from_phone_number'

  // PostgREST caps responses at max-rows (typically 1000) regardless of .limit(),
  // so page through the windowed cohort with .range() to capture every row.
  const fetchAllInWindow = async (table, cols) => {
    const pageSize = 1000
    let from = 0
    const all = []
    for (;;) {
      const { data, error } = await supabase
        .from(table).select(cols)
        .gte('created_at', startIso).lte('created_at', endIso)
        .order('created_at', { ascending: true })
        .range(from, from + pageSize - 1)
      if (error) return { data: all, error }
      const batch = data || []
      all.push(...batch)
      if (batch.length < pageSize) break
      from += pageSize
      if (from > 500000) break // hard safety cap
    }
    return { data: all, error: null }
  }

  const [sqRes, meRes, campRes, emailTplRes, emailEvtRes, agentAttrRes, tgRes] = await Promise.all([
    fetchAllInWindow('send_queue', SQ_COLS),
    fetchAllInWindow('message_events', ME_COLS),
    supabase.from('campaigns').select('id,name,status,objective,market,state,agent_persona,language_policy,daily_cap,total_cap,auto_send_enabled,created_at').limit(500),
    supabase.from('email_templates').select('id,template_id,template_name,subject,use_case,language,agent_persona,is_active').limit(2000),
    supabase.from('email_events').select('id,direction,event_type,opened_at,clicked_at,failed_at').gte('created_at', startIso).limit(20000),
    supabase.from('agent_attribution_metrics_v').select('*').maybeSingle(),
    supabase.from('textgrid_numbers').select('id,phone_number,friendly_name,market,state,is_active,daily_cap').limit(500),
  ])

  const sqRows = (sqRes.data || []).filter((r) => {
    if (filterState && deriveState(r) !== filterState) return false
    if (filterMarket && clean(r.market) !== filterMarket) return false
    return true
  })
  const meRows = meRes.data || []
  const campaigns = campRes.data || []
  const emailTemplates = emailTplRes.data || []
  const emailEvents = emailEvtRes.data || []
  const agentAttr = agentAttrRes.data || null
  const textgridNumbers = tgRes.data || []

  if (sqRes.error) notes.push(`send_queue query error: ${sqRes.error.message}`)
  if (meRes.error) notes.push(`message_events query error: ${meRes.error.message}`)

  // ── Template metadata map (sms_templates) ──────────────────────────────────
  const referencedTplIds = new Set()
  for (const r of sqRows) {
    const id = clean(r.template_id) || clean(r.selected_template_id) || clean(r.template_key)
    if (id) referencedTplIds.add(id)
  }
  let tplMeta = new Map()
  if (referencedTplIds.size) {
    const ids = [...referencedTplIds]
    // Chunk the IN filter to stay within URL limits.
    for (let i = 0; i < ids.length; i += 300) {
      const chunk = ids.slice(i, i + 300)
      const { data } = await supabase
        .from('sms_templates')
        .select('template_id,template_name,use_case,stage_code,stage_label,language,agent_persona,template_body,is_active,reply_mode,safe_for_auto_reply')
        .in('template_id', chunk)
      for (const t of data || []) tplMeta.set(clean(t.template_id), t)
    }
  }

  const tplFor = (r) => {
    const id = clean(r.template_id) || clean(r.selected_template_id) || clean(r.template_key)
    return { id, meta: id ? tplMeta.get(id) : undefined }
  }

  const agentFor = (r, meta) => {
    const explicit = clean(r.agent_name) || clean(r.selected_agent_id) || clean(r.sms_agent_id)
    if (explicit) return { agent: explicit, source: 'explicit' }
    const persona = clean(meta?.agent_persona)
    if (persona) return { agent: persona, source: 'persona' }
    const body = parseAgentFromBody(r.message_body || r.rendered_message)
    if (body) return { agent: body, source: 'body' }
    return { agent: 'Unknown', source: 'unknown' }
  }

  // ── Outbound thread → dimension map (for attributing inbound replies) ───────
  // Keep the most recent outbound row per thread.
  const threadDim = new Map()
  for (const r of sqRows) {
    const tk = clean(r.thread_key)
    if (!tk) continue
    const ts = new Date(r.sent_at || r.created_at || 0).getTime()
    const prev = threadDim.get(tk)
    if (prev && prev.ts >= ts) continue
    const { id, meta } = tplFor(r)
    threadDim.set(tk, {
      ts,
      state: deriveState(r),
      market: clean(r.market) || null,
      city: clean(r.property_address_city) || null,
      templateId: id || null,
      agent: agentFor(r, meta).agent,
    })
  }

  // ── Inbound reply classification ───────────────────────────────────────────
  const inbound = meRows.filter((r) => lower(r.direction) === 'inbound')
  const classifyInbound = (r) => {
    const intent = lower(r.detected_intent)
    return {
      isReply: true,
      isPositive: POSITIVE_INTENTS.has(intent),
      isOptOut: r.is_opt_out === true || Boolean(clean(r.opt_out_keyword)) || OPTOUT_INTENTS.has(intent),
      isWrong: WRONG_NUM_INTENTS.has(intent),
    }
  }

  // ── Generic dimension accumulator ──────────────────────────────────────────
  const newAcc = () => ({ sent: 0, delivered: 0, failed: 0, blocked: 0, replied: 0, positive: 0, optOut: 0, wrong: 0, spend: 0, markets: new Map(), templates: new Map(), agents: new Map() })
  const bump = (m, key, n = 1) => m.set(key, (m.get(key) || 0) + n)

  const byState = new Map()
  const byMarket = new Map()
  const byAgent = new Map()
  const byTemplate = new Map()
  const byCampaign = new Map()
  const carrierAcc = new Map()
  const numberAcc = new Map()
  const totals = newAcc()

  const get = (map, key) => { if (!map.has(key)) map.set(key, newAcc()); return map.get(key) }

  // Outbound aggregation from send_queue
  for (const r of sqRows) {
    const sent = isSentRow(r)
    const delivered = isDeliveredRow(r)
    const failed = isFailedRow(r)
    const blocked = isBlockedRow(r)
    const cost = Number.isFinite(r.estimated_cost) ? Number(r.estimated_cost) : (sent ? SMS_COST_PER_MSG : 0)
    const state = deriveState(r)
    const market = clean(r.market) || null
    const { id: tplId, meta } = tplFor(r)
    const { agent } = agentFor(r, meta)
    const phone = clean(r.from_phone_number) || null

    const applyOut = (acc) => {
      if (sent) { acc.sent++; acc.spend += cost }
      if (delivered) acc.delivered++
      if (failed) acc.failed++
      if (blocked) acc.blocked++
    }
    applyOut(totals)
    if (filterAgent && agent !== filterAgent) {
      // still counted in totals above; skip dimensional breakdowns
    }
    if (state) { const a = get(byState, state); applyOut(a); if (market) bump(a.markets, market); if (tplId) bump(a.templates, tplId); bump(a.agents, agent) }
    if (market) { const a = get(byMarket, market); applyOut(a); if (tplId) bump(a.templates, tplId); bump(a.agents, agent); a._state = state }
    if (agent) { const a = get(byAgent, agent); applyOut(a); if (market) bump(a.markets, market); if (tplId) bump(a.templates, tplId) }
    if (tplId) { const a = get(byTemplate, tplId); applyOut(a); if (market) bump(a.markets, market) }
    if (r.campaign_id) { const a = get(byCampaign, String(r.campaign_id)); applyOut(a) }
    if (phone) { const a = get(numberAcc, phone); applyOut(a) }
  }

  // Inbound aggregation, attributed via thread_key → dimension.
  // When a state/market filter is active, threadDim only contains the filtered
  // cohort, so replies whose thread isn't in it must be excluded from totals too.
  const hasGeoFilter = Boolean(filterState || filterMarket)
  let unattributedReplies = 0
  for (const r of inbound) {
    const c = classifyInbound(r)
    const tk = clean(r.thread_key)
    const dim = tk ? threadDim.get(tk) : null
    if (hasGeoFilter && !dim) continue

    totals.replied++
    if (c.isPositive) totals.positive++
    if (c.isOptOut) totals.optOut++
    if (c.isWrong) totals.wrong++

    if (!dim) { unattributedReplies++; continue }

    const applyIn = (acc) => {
      acc.replied++
      if (c.isPositive) acc.positive++
      if (c.isOptOut) acc.optOut++
      if (c.isWrong) acc.wrong++
    }
    if (dim.state && byState.has(dim.state)) applyIn(byState.get(dim.state))
    if (dim.market && byMarket.has(dim.market)) applyIn(byMarket.get(dim.market))
    if (dim.agent && byAgent.has(dim.agent)) applyIn(byAgent.get(dim.agent))
    if (dim.templateId && byTemplate.has(dim.templateId)) applyIn(byTemplate.get(dim.templateId))

    // Carrier (from message_events directly when available)
    const carrier = clean(r.carrier_name)
    if (carrier) { const a = get(carrierAcc, carrier); applyIn(a) }
  }
  // Carrier outbound from message_events
  for (const r of meRows.filter((x) => lower(x.direction) === 'outbound')) {
    const carrier = clean(r.carrier_name)
    if (!carrier) continue
    const a = get(carrierAcc, carrier)
    a.sent++
    if (lower(r.delivery_status) === 'delivered' || lower(r.provider_delivery_status) === 'delivered') a.delivered++
  }

  // ── Rate helpers for a dimension accumulator ───────────────────────────────
  const rates = (a) => {
    const deliveryRate = safeRate(a.delivered, a.sent, 0)
    const replyRate = safeRate(a.replied, a.delivered || a.sent, 1)
    const positiveRate = safeRate(a.positive, a.replied, 0)
    const optOutRate = safeRate(a.optOut, a.delivered || a.sent, 1)
    return { deliveryRate, replyRate, positiveRate, optOutRate }
  }
  const topKey = (m) => { let best = null, n = -1; for (const [k, v] of m) if (v > n) { n = v; best = k }; return best }

  // ── KPIs ────────────────────────────────────────────────────────────────────
  const t = totals
  const tr = rates(t)
  const failedQueue = sqRows.filter(isFailedRow).length
  const blockedQueue = sqRows.filter(isBlockedRow).length
  const blankBody = sqRows.filter((r) => !clean(r.message_body) && !clean(r.rendered_message)).length
  const routingBlocked = blockedQueue
  const queueFailRate = sqRows.length ? failedQueue / sqRows.length : 0
  const queueHealth = queueFailRate > 0.15 ? 'critical' : queueFailRate > 0.05 ? 'warning' : 'good'

  // channel toggle: SMS is the only wired channel; email metrics are empty.
  const channelZero = channel === 'email'
  const spend = Math.round(t.spend * 100) / 100

  const kpis = {
    sentCount: channelZero ? 0 : t.sent,
    deliveredCount: channelZero ? 0 : t.delivered,
    repliedCount: channelZero ? 0 : t.replied,
    positiveReplies: channelZero ? 0 : t.positive,
    optOutCount: channelZero ? 0 : t.optOut,
    failedCount: channelZero ? 0 : t.failed,
    deliveryRate: channelZero ? 0 : tr.deliveryRate,
    replyRate: channelZero ? 0 : tr.replyRate,
    positiveRate: channelZero ? 0 : tr.positiveRate,
    optOutRate: channelZero ? 0 : tr.optOutRate,
    spendPeriod: channelZero ? 0 : spend,
    costPerReply: t.replied > 0 ? Math.round((spend / t.replied) * 100) / 100 : null,
    costPerPositive: t.positive > 0 ? Math.round((spend / t.positive) * 100) / 100 : null,
    queueHealth,
    automationHealthScore: Math.max(0, 100 - Math.round(queueFailRate * 100)),
    buyerDemandScore: 0,
    dataQualityScore: Math.max(0, 100 - Math.round(((failedQueue + blankBody + routingBlocked) / Math.max(sqRows.length, 1)) * 100)),
  }

  // ── Timeseries (zero-filled by date across window) ──────────────────────────
  const dayKeys = []
  {
    const d0 = new Date(window.start); d0.setHours(0, 0, 0, 0)
    const d1 = new Date(window.end); d1.setHours(0, 0, 0, 0)
    for (let d = new Date(d0); d <= d1; d.setDate(d.getDate() + 1)) dayKeys.push(d.toISOString().slice(0, 10))
  }
  const tsMap = new Map(dayKeys.map((d) => [d, { date: d, sent: 0, delivered: 0, replied: 0, positive: 0, optOut: 0, failed: 0, spend: 0 }]))
  if (!channelZero) {
    for (const r of sqRows) {
      const day = (r.sent_at || r.created_at || '').slice(0, 10)
      const p = tsMap.get(day); if (!p) continue
      if (isSentRow(r)) { p.sent++; p.spend += Number.isFinite(r.estimated_cost) ? Number(r.estimated_cost) : SMS_COST_PER_MSG }
      if (isDeliveredRow(r)) p.delivered++
      if (isFailedRow(r)) p.failed++
    }
    for (const r of inbound) {
      const day = (r.created_at || '').slice(0, 10)
      const p = tsMap.get(day); if (!p) continue
      const c = classifyInbound(r)
      p.replied++
      if (c.isPositive) p.positive++
      if (c.isOptOut) p.optOut++
    }
  }
  const timeseries = dayKeys.map((d) => { const p = tsMap.get(d); p.spend = Math.round(p.spend * 100) / 100; return p })

  // ── Funnel ──────────────────────────────────────────────────────────────────
  const queuedTotal = sqRows.length
  const funnel = [
    { id: 'queued', label: 'Queued', count: queuedTotal, isEstimate: false },
    { id: 'sent', label: 'Sent', count: t.sent, isEstimate: false },
    { id: 'delivered', label: 'Delivered', count: t.delivered, isEstimate: false },
    { id: 'replied', label: 'Replied', count: t.replied, isEstimate: false },
    { id: 'positive', label: 'Positive Intent', count: t.positive, isEstimate: false },
    { id: 'offer_created', label: 'Offer Created', count: 0, isEstimate: false },
    { id: 'contract_sent', label: 'Contract Sent', count: 0, isEstimate: false },
    { id: 'closed', label: 'Closed', count: 0, isEstimate: false },
  ].map((s, i, arr) => {
    const prev = i > 0 ? arr[i - 1].count : s.count
    return { ...s, prevCount: 0, conversionRate: prev > 0 ? safeRate(s.count, prev, 0) : null, dropOffRate: null, trend: 'neutral' }
  })

  // ── State leaderboard + map ─────────────────────────────────────────────────
  const stateRows = [...byState.entries()].map(([state, a]) => {
    const r = rates(a)
    return {
      state, sent: a.sent, delivered: a.delivered, replied: a.replied, positive: a.positive, optOut: a.optOut,
      ...r, topMarket: topKey(a.markets) || '—', topAgent: topKey(a.agents) || '—', topTemplate: topKey(a.templates) || null,
      status: stateStatus({ sent: a.sent, ...r }), recommendation: stateRecommendation({ sent: a.sent, ...r }),
    }
  }).sort((x, y) => y.sent - x.sent)

  // map_states includes every state with data + all major campaign states (quiet at zero)
  const stateByAbbr = new Map(stateRows.map((s) => [s.state, s]))
  const mapAbbrs = new Set([...stateByAbbr.keys(), ...MAJOR_STATES])
  const map_states = [...mapAbbrs].map((abbr) => stateByAbbr.get(abbr) || {
    state: abbr, sent: 0, delivered: 0, replied: 0, positive: 0, optOut: 0,
    deliveryRate: 0, replyRate: 0, positiveRate: 0, optOutRate: 0,
    topMarket: '—', topAgent: '—', topTemplate: null, status: 'quiet', recommendation: 'No Data',
  })

  // ── Market leaderboard ───────────────────────────────────────────────────────
  const market_leaderboard = [...byMarket.entries()].map(([market, a]) => {
    const r = rates(a)
    return {
      market, state: a._state || parseStateFromMarket(market) || '—',
      sent: a.sent, delivered: a.delivered, replied: a.replied, positive: a.positive, optOut: a.optOut, ...r,
      topTemplate: topKey(a.templates) || null, topAgent: topKey(a.agents) || '—',
      status: stateStatus({ sent: a.sent, ...r }), recommendation: stateRecommendation({ sent: a.sent, ...r }),
      buyerDemandScore: Math.min(100, a.positive * 12 + a.replied * 3),
    }
  }).sort((x, y) => y.sent - x.sent).slice(0, 60)

  // ── Agent leaderboard ────────────────────────────────────────────────────────
  const agent_leaderboard = [...byAgent.entries()].map(([agent, a]) => {
    const r = rates(a)
    return {
      agent, sent: a.sent, delivered: a.delivered, replied: a.replied, positive: a.positive, optOut: a.optOut, ...r,
      bestMarket: topKey(a.markets) || '—', bestTemplate: topKey(a.templates) || '—',
    }
  }).sort((x, y) => y.sent - x.sent).slice(0, 30)

  // ── SMS template leaderboard ───────────────────────────────────────────────
  const sms_template_leaderboard = [...byTemplate.entries()].map(([templateId, a]) => {
    const meta = tplMeta.get(templateId)
    const r = rates(a)
    return {
      templateId,
      name: clean(meta?.template_name) || templateId,
      preview: clean(meta?.template_body).slice(0, 120) || null,
      useCase: clean(meta?.use_case) || null,
      stage: clean(meta?.stage_label) || clean(meta?.stage_code) || null,
      language: clean(meta?.language) || 'en',
      agentPersona: clean(meta?.agent_persona) || null,
      sent: a.sent, delivered: a.delivered, replied: a.replied, positive: a.positive, optOut: a.optOut, wrongNumber: a.wrong,
      ...r,
      topMarket: topKey(a.markets) || '—',
      recommendation: templateRecommendation({ sent: a.sent, ...r }),
      metaResolved: Boolean(meta),
    }
  }).sort((x, y) => y.sent - x.sent).slice(0, 60)

  const unresolvedTemplates = sms_template_leaderboard.filter((t2) => !t2.metaResolved).length
  if (unresolvedTemplates > 0) notes.push(`${unresolvedTemplates} template id(s) in send_queue not found in sms_templates`)

  // ── Email template leaderboard (real inventory, metrics if events exist) ────
  const email_template_leaderboard = emailTemplates.map((e) => ({
    templateId: clean(e.template_id) || String(e.id),
    name: clean(e.template_name) || clean(e.template_id),
    subject: clean(e.subject) || null,
    useCase: clean(e.use_case) || null,
    language: clean(e.language) || null,
    agentPersona: clean(e.agent_persona) || null,
    isActive: e.is_active !== false,
    sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, unsubscribed: 0,
    metricsAvailable: false,
  }))

  // ── Campaign leaderboard (real campaign inventory + attributed sends) ───────
  const campaign_leaderboard = campaigns.map((c) => {
    const a = byCampaign.get(String(c.id))
    const r = a ? rates(a) : { deliveryRate: 0, replyRate: 0, positiveRate: 0, optOutRate: 0 }
    return {
      id: c.id, name: clean(c.name) || c.id, status: clean(c.status) || null,
      objective: clean(c.objective) || null, market: clean(c.market) || null, state: clean(c.state) || null,
      agentPersona: clean(c.agent_persona) || null, autoSend: c.auto_send_enabled === true,
      dailyCap: c.daily_cap ?? null, totalCap: c.total_cap ?? null,
      sent: a?.sent || 0, delivered: a?.delivered || 0, replied: a?.replied || 0, positive: a?.positive || 0, optOut: a?.optOut || 0,
      ...r,
    }
  }).sort((x, y) => y.sent - x.sent || clean(x.status).localeCompare(clean(y.status)))

  const attributedCampaignSends = [...byCampaign.values()].reduce((s, a) => s + a.sent, 0)
  if (attributedCampaignSends === 0) notes.push('send_queue.campaign_id not populated — campaign rows show config inventory; per-campaign send metrics unavailable')

  // ── Carrier intelligence ─────────────────────────────────────────────────────
  const carrier_intelligence = [...carrierAcc.entries()].map(([carrier, a]) => {
    const r = rates(a)
    return { carrier, sent: a.sent, delivered: a.delivered, replied: a.replied, optOut: a.optOut, ...r }
  }).sort((x, y) => y.sent - x.sent)
  if (carrier_intelligence.length === 0) notes.push('message_events.carrier_name not populated — carrier intelligence unavailable')

  // ── TextGrid number health ─────────────────────────────────────────────────
  const textgrid_numbers_health = {
    totalNumbers: textgridNumbers.length,
    activeNumbers: textgridNumbers.filter((n) => n.is_active !== false).length,
    numbers: textgridNumbers.map((n) => {
      const a = numberAcc.get(clean(n.phone_number))
      const r = a ? rates(a) : { deliveryRate: 0, replyRate: 0, positiveRate: 0, optOutRate: 0 }
      return {
        numberId: String(n.id), phoneNumber: clean(n.phone_number), friendlyName: clean(n.friendly_name) || clean(n.phone_number),
        market: clean(n.market) || '—', state: clean(n.state) || '—', isActive: n.is_active !== false,
        sent: a?.sent || 0, delivered: a?.delivered || 0, failed: a?.failed || 0, replies: a?.replied || 0, optOuts: a?.optOut || 0,
        ...r,
      }
    }).sort((x, y) => y.sent - x.sent),
  }

  // ── Email + automation + buyer health ───────────────────────────────────────
  const email_health = {
    templatesAvailable: emailTemplates.length,
    activeTemplates: emailTemplates.filter((e) => e.is_active !== false).length,
    eventsInWindow: emailEvents.length,
    sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, unsubscribed: 0,
    wired: emailTemplates.length > 0 && emailEvents.length > 0,
    note: emailTemplates.length === 0
      ? 'No rows in public.email_templates — email channel has no template inventory yet.'
      : emailEvents.length === 0
        ? 'email_templates exist but public.email_events is empty — send/open/click metrics unavailable.'
        : null,
  }

  const data_automation_health = {
    queueRows: sqRows.length,
    failedQueueRows: failedQueue,
    blockedRows: blockedQueue,
    blankBodyRows: blankBody,
    routingBlocked,
    queueHealth,
    automationHealthScore: kpis.automationHealthScore,
    unattributedReplies,
    agentAttribution: agentAttr ? {
      attributionCoveragePct: Number(agentAttr.attribution_coverage_pct) || 0,
      unknownAgentPct: Number(agentAttr.unknown_agent_pct) || 0,
      confidence: agentAttr.agent_attribution_confidence || null,
    } : null,
  }

  const buyer_demand = { totalMatches: 0, topMarkets: [], avgConfidence: 0, wired: false, note: 'Buyer demand not wired into war room — connect buyer_match tables to enable.' }

  // ── Alerts (derived from real metrics only) ─────────────────────────────────
  const alerts = []
  let aid = 0
  for (const tpl of sms_template_leaderboard.filter((x) => x.recommendation === 'Kill').slice(0, 4)) {
    alerts.push({ id: String(++aid), severity: 'critical', category: 'SMS Template', message: `${tpl.name}: ${tpl.optOutRate}% opt-out on ${tpl.sent} sends — KILL`, affectedEntity: tpl.templateId, suggestedAction: `Retire template ${tpl.templateId}` })
  }
  for (const tpl of sms_template_leaderboard.filter((x) => x.recommendation === 'Scale' && x.replyRate >= 15).slice(0, 3)) {
    alerts.push({ id: String(++aid), severity: 'opportunity', category: 'SMS Template', message: `${tpl.name}: ${tpl.replyRate}% reply rate — scale traffic`, affectedEntity: tpl.templateId, suggestedAction: `Increase volume for template ${tpl.templateId}` })
  }
  for (const s of stateRows.filter((x) => x.sent >= 20 && x.optOutRate >= 3).slice(0, 3)) {
    alerts.push({ id: String(++aid), severity: 'warning', category: 'State Performance', message: `${s.state}: ${s.optOutRate}% opt-out across ${s.sent} sends`, affectedEntity: s.state, suggestedAction: `Audit templates/targeting in ${s.state}` })
  }
  for (const m of market_leaderboard.filter((x) => x.sent >= 30 && x.deliveryRate < 90).slice(0, 3)) {
    alerts.push({ id: String(++aid), severity: 'warning', category: 'Market Delivery', message: `${m.market}: ${m.deliveryRate}% delivery on ${m.sent} sends`, affectedEntity: m.market, suggestedAction: `Check sender health / carrier filtering in ${m.market}` })
  }
  const unknownAgentPct = data_automation_health.agentAttribution?.unknownAgentPct ?? null
  if (unknownAgentPct != null && unknownAgentPct >= 40) {
    alerts.push({ id: String(++aid), severity: 'warning', category: 'Agent Attribution', message: `Unknown agent attribution at ${unknownAgentPct}% — fix send_queue.agent_name / template persona mapping.`, suggestedAction: 'Populate agent_name or template agent_persona on outbound rows' })
  }
  if (failedQueue > 0) alerts.push({ id: String(++aid), severity: 'warning', category: 'Queue Health', message: `${failedQueue} failed send_queue rows in window`, suggestedAction: 'Review failed_reason distribution' })
  if (blankBody > 0) alerts.push({ id: String(++aid), severity: 'warning', category: 'Data Quality', message: `${blankBody} queue rows with blank message body`, suggestedAction: 'Audit template rendering' })
  if (routingBlocked > 0) alerts.push({ id: String(++aid), severity: 'warning', category: 'Routing', message: `${routingBlocked} routing-blocked rows`, suggestedAction: 'Review blocked_reason values' })
  if (!alerts.length) alerts.push({ id: '0', severity: 'info', category: 'System', message: 'No active alerts — system operating normally.' })

  // ── Source audit ─────────────────────────────────────────────────────────────
  const source_audit = {
    sms_templates_source: `public.sms_templates (${tplMeta.size} of ${referencedTplIds.size} referenced ids resolved)`,
    email_templates_source: `public.email_templates (${emailTemplates.length} rows)`,
    send_queue_source: `public.send_queue (${sqRows.length} rows in window${filterState || filterMarket ? ', filtered' : ''})`,
    message_events_source: `public.message_events (${meRows.length} rows in window, ${inbound.length} inbound)`,
    campaigns_source: `public.campaigns (${campaigns.length} rows, ${attributedCampaignSends} attributed sends)`,
    properties_source: 'send_queue.property_address_state / market (state parsed from market "City, ST")',
    buyer_source: 'not wired',
    state_field_used: 'send_queue.property_address_state → fallback parse from send_queue.market',
    market_field_used: 'send_queue.market',
    agent_field_used: 'send_queue.agent_name|selected_agent_id|sms_agent_id → sms_templates.agent_persona → body parse',
    template_field_used: 'send_queue.template_id → sms_templates.template_id',
    email_template_field_used: 'public.email_templates.template_id',
    notes,
  }

  return {
    window: window.label,
    channel,
    generated_at: new Date().toISOString(),
    source_audit,
    kpis,
    timeseries,
    funnel,
    map_states,
    state_leaderboard: stateRows,
    market_leaderboard,
    agent_leaderboard,
    sms_template_leaderboard,
    email_template_leaderboard,
    campaign_leaderboard,
    alerts,
    carrier_intelligence,
    textgrid_numbers_health,
    email_health,
    data_automation_health,
    buyer_demand,
    query_ms: Date.now() - startedAt,
  }
}
