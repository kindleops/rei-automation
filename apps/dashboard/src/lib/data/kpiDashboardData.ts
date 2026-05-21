import { getSupabaseClient } from '../supabaseClient'

// ── Filter types ──────────────────────────────────────────────────────────────

export type KpiTimeRange =
  | 'today'
  | 'yesterday'
  | 'last_7_days'
  | 'last_30_days'
  | 'last_40_days'
  | 'custom'

export interface KpiFilters {
  timeRange: KpiTimeRange
  state?: string
  market?: string
  agent?: string
  template?: string
  channel?: 'sms' | 'email' | 'all'
  assetType?: string
  campaign?: string
  source?: string
  status?: string
  customStart?: string
  customEnd?: string
}

export interface KpiDateRange {
  start: string
  end: string
  prevStart: string
  prevEnd: string
}

export const getKpiDateRange = (filters: KpiFilters): KpiDateRange => {
  const now = new Date()
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const todayEnd = new Date(now)
  todayEnd.setHours(23, 59, 59, 999)

  let start: Date
  let end: Date
  let prevStart: Date
  let prevEnd: Date

  switch (filters.timeRange) {
    case 'today':
      start = new Date(todayStart)
      end = new Date(todayEnd)
      prevStart = new Date(todayStart)
      prevStart.setDate(prevStart.getDate() - 1)
      prevEnd = new Date(todayEnd)
      prevEnd.setDate(prevEnd.getDate() - 1)
      break
    case 'yesterday':
      start = new Date(todayStart)
      start.setDate(start.getDate() - 1)
      end = new Date(todayStart)
      end.setMilliseconds(end.getMilliseconds() - 1)
      prevStart = new Date(start)
      prevStart.setDate(prevStart.getDate() - 1)
      prevEnd = new Date(end)
      prevEnd.setDate(prevEnd.getDate() - 1)
      break
    case 'last_7_days':
      start = new Date(todayStart)
      start.setDate(start.getDate() - 7)
      end = new Date(todayEnd)
      prevStart = new Date(start)
      prevStart.setDate(prevStart.getDate() - 7)
      prevEnd = new Date(start)
      prevEnd.setMilliseconds(prevEnd.getMilliseconds() - 1)
      break
    case 'last_30_days':
      start = new Date(todayStart)
      start.setDate(start.getDate() - 30)
      end = new Date(todayEnd)
      prevStart = new Date(start)
      prevStart.setDate(prevStart.getDate() - 30)
      prevEnd = new Date(start)
      prevEnd.setMilliseconds(prevEnd.getMilliseconds() - 1)
      break
    case 'last_40_days':
      start = new Date(todayStart)
      start.setDate(start.getDate() - 40)
      end = new Date(todayEnd)
      prevStart = new Date(start)
      prevStart.setDate(prevStart.getDate() - 40)
      prevEnd = new Date(start)
      prevEnd.setMilliseconds(prevEnd.getMilliseconds() - 1)
      break
    case 'custom': {
      start = filters.customStart ? new Date(filters.customStart) : (() => { const d = new Date(todayStart); d.setDate(d.getDate() - 7); return d })()
      end = filters.customEnd ? new Date(filters.customEnd) : new Date(todayEnd)
      const diff = end.getTime() - start.getTime()
      prevEnd = new Date(start)
      prevEnd.setMilliseconds(prevEnd.getMilliseconds() - 1)
      prevStart = new Date(prevEnd.getTime() - diff)
      break
    }
    default:
      start = new Date(todayStart)
      start.setDate(start.getDate() - 7)
      end = new Date(todayEnd)
      prevStart = new Date(start)
      prevStart.setDate(prevStart.getDate() - 7)
      prevEnd = new Date(start)
      prevEnd.setMilliseconds(prevEnd.getMilliseconds() - 1)
  }

  return {
    start: start.toISOString(),
    end: end.toISOString(),
    prevStart: prevStart.toISOString(),
    prevEnd: prevEnd.toISOString(),
  }
}

// ── Cost constant (stub — wire from real billing data when available) ──────────
// $0.0079 per outbound SMS segment
const SMS_COST_PER_MSG = 0.0079

// ── Intent classifiers ────────────────────────────────────────────────────────

const POSITIVE_INTENTS = new Set([
  'seller_interested', 'price_interest', 'positive', 'warm',
  'asking_price_provided', 'asks_offer', 'ownership_confirmed', 'price_anchor',
])
const OPTOUT_INTENTS = new Set([
  'stop', 'opt_out', 'unsubscribe', 'remove',
])
const WRONG_NUM_INTENTS = new Set(['wrong_number', 'wrong_contact'])

// ── Return types ──────────────────────────────────────────────────────────────

export interface KpiSummary {
  sentCount: number
  deliveredCount: number
  repliedCount: number
  positiveReplies: number
  optOutCount: number
  failedCount: number
  deliveryRate: number
  replyRate: number
  positiveRate: number
  optOutRate: number
  prevSentCount: number
  prevRepliedCount: number
  prevPositiveReplies: number
  offersCreated: number
  contractsSent: number
  underContract: number
  closedDeals: number
  spendPeriod: number
  costPerReply: number | null
  costPerPositive: number | null
  projectedMonthlyRevenue: number | null
  pipelineValue: number | null
  automationHealthScore: number
  buyerDemandScore: number
  queueHealth: 'good' | 'warning' | 'critical'
  dataQualityScore: number
  periodLabel: string
  lastUpdated: string
  isLive: boolean
}

export interface TimeSeriesPoint {
  date: string
  sent: number
  delivered: number
  replied: number
  positive: number
  optOut: number
  failed: number
  offers: number
  contracts: number
  spend: number
}

export interface StatePerformance {
  state: string
  stateName: string
  sent: number
  delivered: number
  replied: number
  positive: number
  optOut: number
  contracts: number
  revenue: number | null
  topMarket: string
  deliveryRate: number
  replyRate: number
  positiveRate: number
  optOutRate: number
  status: 'active' | 'strong' | 'warning' | 'blocked' | 'quiet' | 'contracting'
  recommendation: 'Scale' | 'Watch' | 'Pause' | 'Investigate' | 'No Data'
}

export interface MarketPerformance {
  market: string
  state: string
  sent: number
  delivered: number
  replied: number
  positive: number
  optOut: number
  hotLeads: number
  offers: number
  contracts: number
  revenue: number | null
  buyerDemandScore: number
  deliveryRate: number
  replyRate: number
  positiveRate: number
  optOutRate: number
  recommendation: 'Scale' | 'Watch' | 'Pause' | 'Investigate' | 'No Data'
}

export interface AgentPerformance {
  agentId: string
  agentName: string
  sent: number
  delivered: number
  replied: number
  positive: number
  optOut: number
  replyRate: number
  positiveRate: number
  optOutRate: number
  bestMarket: string
  activeConversations: number
  contractsInfluenced: number
  badges: string[]
}

export interface TemplatePerformance {
  templateId: string
  preview: string
  language: string
  useCase: string
  sent: number
  delivered: number
  replied: number
  positive: number
  optOut: number
  wrongNumber: number
  deliveryFailed: number
  replyRate: number
  positiveRate: number
  stopRate: number
  deliveryRate: number
  recommendation: 'Scale' | 'Testing' | 'Pause' | 'Kill' | 'Needs Data'
  flags: string[]
  trafficWeight: number | null
}

export interface ChannelPerformance {
  channel: 'sms' | 'email'
  sent: number
  delivered: number
  replied: number
  positive: number
  optOut: number
  bounced: number
  spend: number
  costPerReply: number | null
  costPerPositive: number | null
  deliveryRate: number
  replyRate: number
  positiveRate: number
  isWired: boolean
}

export interface SpendPerformance {
  periodLabel: string
  smsSend: number
  emailSend: number
  dataAcquisition: number
  totalSpend: number
  costPerSent: number | null
  costPerDelivered: number | null
  costPerReply: number | null
  costPerPositive: number | null
  costPerOffer: number | null
  costPerContract: number | null
  projectedROI: number | null
  conservative: { contracts: number; avgRevenue: number; totalRevenue: number }
  base: { contracts: number; avgRevenue: number; totalRevenue: number }
  aggressive: { contracts: number; avgRevenue: number; totalRevenue: number }
}

export interface FunnelStage {
  id: string
  label: string
  count: number
  prevCount: number
  conversionRate: number | null
  dropOffRate: number | null
  trend: 'up' | 'down' | 'neutral'
  isEstimate: boolean
}

export interface DataQualityMetrics {
  missingPhone: number
  missingEmail: number
  missingOwnerName: number
  missingZip: number
  invalidPhone: number
  dncCount: number
  wrongNumber: number
  duplicate: number
  routingBlocked: number
  noSenderCoverage: number
  failedQueueRows: number
  blankBody: number
  deliveryLag: number | null
  queueLatency: number | null
  autoReplyBlocked: number
  manualReviewCount: number
  healthScore: number
}

export interface BuyerDemandMetrics {
  totalMatches: number
  topMarkets: Array<{ market: string; score: number; matches: number }>
  avgConfidence: number
  buyerResponseRate: number | null
  assignedCount: number
  isWired: boolean
}

export interface OfferContractMetrics {
  offersCreated: number
  offersSent: number
  offersAccepted: number
  offersRejected: number
  contractsGenerated: number
  contractsSent: number
  sellerSigned: number
  fullyExecuted: number
  sentToTitle: number
  closed: number
  cancelled: number
  offerConversionRate: number | null
  contractConversionRate: number | null
  avgSpread: number | null
  projectedRevenue: number | null
  isWired: boolean
}

export interface TextgridNumberHealth {
  numberId: string
  phoneNumber: string
  friendlyName: string
  market: string
  state: string
  isActive: boolean
  sentToday: number
  sentLast7: number
  sentLast30: number
  delivered: number
  deliveryRate: number
  failed: number
  failureRate: number
  replies: number
  replyRate: number
  positiveReplies: number
  optOuts: number
  optOutRate: number
  wrongNumbers: number
  blacklistEvents: number
  dailyCapUsedPct: number
  healthScore: number
  recommendation: 'Healthy' | 'Watch' | 'Throttle' | 'Pause' | 'Replace' | 'Add More'
}

export interface CarrierPerformance {
  carrier: string
  lineType: string
  sent: number
  delivered: number
  deliveryRate: number
  replied: number
  replyRate: number
  positive: number
  optOut: number
  optOutRate: number
  failed: number
  avgLatencyMs: number | null
  topFailureReason: string | null
  isWired: boolean
}

export interface NumberCarrierMatrix {
  carriers: string[]
  markets: string[]
  cells: Record<string, Record<string, { sent: number; deliveryRate: number; replyRate: number; optOutRate: number }>>
}

export interface KpiAlert {
  id: string
  severity: 'critical' | 'warning' | 'opportunity' | 'info'
  category: string
  message: string
  affectedEntity?: string
  suggestedAction?: string
}

export interface NumberHealthAlert {
  severity: 'critical' | 'warning' | 'info'
  type: string
  message: string
  affectedNumber?: string
  affectedMarket?: string
}

// ── State names map ───────────────────────────────────────────────────────────

export const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'Wash. D.C.',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const pct = (num: number, den: number, decimals = 0) =>
  den > 0 ? Math.round((num / den) * Math.pow(10, decimals + 2)) / Math.pow(10, decimals) : 0

const stateRec = (recommendation: StatePerformance['recommendation']): StatePerformance['recommendation'] => recommendation

// ══════════════════════════════════════════════════════════════════════════════
// loadKpiDashboardSummary
// ══════════════════════════════════════════════════════════════════════════════

export const loadKpiDashboardSummary = async (filters: KpiFilters): Promise<KpiSummary> => {
  const supabase = getSupabaseClient()
  const { start, end, prevStart, prevEnd } = getKpiDateRange(filters)

  const empty: KpiSummary = {
    sentCount: 0, deliveredCount: 0, repliedCount: 0, positiveReplies: 0,
    optOutCount: 0, failedCount: 0, deliveryRate: 0, replyRate: 0,
    positiveRate: 0, optOutRate: 0, prevSentCount: 0, prevRepliedCount: 0,
    prevPositiveReplies: 0, offersCreated: 0, contractsSent: 0,
    underContract: 0, closedDeals: 0, spendPeriod: 0,
    costPerReply: null, costPerPositive: null,
    projectedMonthlyRevenue: null, pipelineValue: null,
    automationHealthScore: 100, buyerDemandScore: 0, queueHealth: 'good',
    dataQualityScore: 75, periodLabel: filters.timeRange,
    lastUpdated: new Date().toISOString(), isLive: true,
  }

  try {
    const [currRes, prevRes, queueRes] = await Promise.all([
      supabase
        .from('message_events')
        .select('direction,delivery_status,detected_intent')
        .gte('created_at', start)
        .lte('created_at', end)
        .limit(10000),
      supabase
        .from('message_events')
        .select('direction,delivery_status,detected_intent')
        .gte('created_at', prevStart)
        .lte('created_at', prevEnd)
        .limit(10000),
      supabase
        .from('send_queue')
        .select('queue_status')
        .gte('created_at', start)
        .limit(5000),
    ])

    const evs = currRes.data ?? []
    const prevEvs = prevRes.data ?? []
    const qItems = queueRes.data ?? []

    const out = evs.filter(e => e.direction === 'outbound')
    const inn = evs.filter(e => e.direction === 'inbound')
    const sentCount = out.length
    const deliveredCount = out.filter(e => e.delivery_status === 'delivered').length
    const failedCount = out.filter(e => ['failed', 'undelivered'].includes(e.delivery_status ?? '')).length
    const repliedCount = inn.length
    const positiveReplies = inn.filter(e => POSITIVE_INTENTS.has(e.detected_intent ?? '')).length
    const optOutCount = inn.filter(e => OPTOUT_INTENTS.has(e.detected_intent ?? '')).length

    const prevOut = prevEvs.filter(e => e.direction === 'outbound')
    const prevInn = prevEvs.filter(e => e.direction === 'inbound')
    const prevSentCount = prevOut.length
    const prevRepliedCount = prevInn.length
    const prevPositiveReplies = prevInn.filter(e => POSITIVE_INTENTS.has(e.detected_intent ?? '')).length

    const failedQ = qItems.filter(q => q.queue_status === 'failed').length
    const totalQ = qItems.length
    const queueHealth: KpiSummary['queueHealth'] =
      totalQ === 0 ? 'good' :
      failedQ / totalQ > 0.15 ? 'critical' :
      failedQ / totalQ > 0.05 ? 'warning' : 'good'

    const spendPeriod = sentCount * SMS_COST_PER_MSG

    return {
      ...empty,
      sentCount, deliveredCount, repliedCount, positiveReplies,
      optOutCount, failedCount,
      deliveryRate: pct(deliveredCount, sentCount),
      replyRate: pct(repliedCount, sentCount, 1),
      positiveRate: pct(positiveReplies, repliedCount),
      optOutRate: pct(optOutCount, sentCount, 1),
      prevSentCount, prevRepliedCount, prevPositiveReplies,
      spendPeriod: Math.round(spendPeriod * 100) / 100,
      costPerReply: repliedCount > 0 ? Math.round((spendPeriod / repliedCount) * 100) / 100 : null,
      costPerPositive: positiveReplies > 0 ? Math.round((spendPeriod / positiveReplies) * 100) / 100 : null,
      queueHealth,
      automationHealthScore: Math.max(0, 100 - pct(failedCount, Math.max(sentCount, 1))),
      dataQualityScore: 75,
      lastUpdated: new Date().toISOString(),
      isLive: true,
    }
  } catch {
    return empty
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// loadKpiTimeSeries
// ══════════════════════════════════════════════════════════════════════════════

export const loadKpiTimeSeries = async (filters: KpiFilters): Promise<TimeSeriesPoint[]> => {
  const supabase = getSupabaseClient()
  const { start, end } = getKpiDateRange(filters)

  try {
    const { data } = await supabase
      .from('message_events')
      .select('direction,delivery_status,detected_intent,created_at')
      .gte('created_at', start)
      .lte('created_at', end)
      .order('created_at', { ascending: true })
      .limit(20000)

    if (!data?.length) return []

    const byDay = new Map<string, TimeSeriesPoint>()
    for (const ev of data) {
      const day = (ev.created_at as string | null)?.slice(0, 10) ?? 'unknown'
      if (!byDay.has(day)) {
        byDay.set(day, {
          date: day, sent: 0, delivered: 0, replied: 0,
          positive: 0, optOut: 0, failed: 0, offers: 0, contracts: 0, spend: 0,
        })
      }
      const p = byDay.get(day)!
      if (ev.direction === 'outbound') {
        p.sent++
        p.spend += SMS_COST_PER_MSG
        if (ev.delivery_status === 'delivered') p.delivered++
        if (['failed', 'undelivered'].includes(ev.delivery_status ?? '')) p.failed++
      } else if (ev.direction === 'inbound') {
        p.replied++
        if (POSITIVE_INTENTS.has(ev.detected_intent ?? '')) p.positive++
        if (OPTOUT_INTENTS.has(ev.detected_intent ?? '')) p.optOut++
      }
    }

    return Array.from(byDay.values())
      .filter(p => p.date !== 'unknown')
      .sort((a, b) => a.date.localeCompare(b.date))
  } catch {
    return []
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// loadStatePerformance
// ══════════════════════════════════════════════════════════════════════════════

export const loadStatePerformance = async (filters: KpiFilters): Promise<StatePerformance[]> => {
  const supabase = getSupabaseClient()
  const { start, end } = getKpiDateRange(filters)

  try {
    let q = supabase
      .from('message_events')
      .select('direction,delivery_status,detected_intent,state,market')
      .gte('created_at', start)
      .lte('created_at', end)
      .limit(20000)

    if (filters.state) q = q.eq('state', filters.state)

    const { data } = await q
    if (!data?.length) return []

    type StateAcc = { sent: number; delivered: number; replied: number; positive: number; optOut: number; markets: string[] }
    const sm = new Map<string, StateAcc>()

    for (const ev of data) {
      const s = (ev.state as string | null) ?? 'Unknown'
      if (s === 'Unknown' || !s) continue
      if (!sm.has(s)) sm.set(s, { sent: 0, delivered: 0, replied: 0, positive: 0, optOut: 0, markets: [] })
      const acc = sm.get(s)!
      const mkt = ev.market as string | null
      if (mkt && !acc.markets.includes(mkt)) acc.markets.push(mkt)
      if (ev.direction === 'outbound') {
        acc.sent++
        if (ev.delivery_status === 'delivered') acc.delivered++
      } else if (ev.direction === 'inbound') {
        acc.replied++
        if (POSITIVE_INTENTS.has(ev.detected_intent ?? '')) acc.positive++
        if (OPTOUT_INTENTS.has(ev.detected_intent ?? '')) acc.optOut++
      }
    }

    return Array.from(sm.entries())
      .map(([state, s]): StatePerformance => {
        const deliveryRate = pct(s.delivered, s.sent)
        const replyRate = pct(s.replied, s.sent, 1)
        const positiveRate = pct(s.positive, s.replied)
        const optOutRate = pct(s.optOut, s.sent, 1)

        const recommendation = stateRec(
          s.sent < 5 ? 'No Data' :
          optOutRate > 3 ? 'Investigate' :
          optOutRate > 1.5 ? 'Pause' :
          positiveRate > 20 && optOutRate < 1 ? 'Scale' :
          'Watch'
        )

        const status: StatePerformance['status'] =
          s.positive > 0 && optOutRate < 1 ? 'strong' :
          optOutRate > 2 ? 'warning' :
          s.replied > 0 ? 'active' :
          s.sent > 0 ? 'active' : 'quiet'

        return {
          state, stateName: STATE_NAMES[state] ?? state,
          sent: s.sent, delivered: s.delivered, replied: s.replied,
          positive: s.positive, optOut: s.optOut, contracts: 0, revenue: null,
          topMarket: s.markets[0] ?? '—',
          deliveryRate, replyRate, positiveRate, optOutRate,
          status, recommendation,
        }
      })
      .sort((a, b) => b.sent - a.sent)
  } catch {
    return []
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// loadMarketPerformance
// ══════════════════════════════════════════════════════════════════════════════

export const loadMarketPerformance = async (filters: KpiFilters): Promise<MarketPerformance[]> => {
  const supabase = getSupabaseClient()
  const { start, end } = getKpiDateRange(filters)

  try {
    let q = supabase
      .from('message_events')
      .select('direction,delivery_status,detected_intent,state,market')
      .gte('created_at', start)
      .lte('created_at', end)
      .limit(20000)

    if (filters.state) q = q.eq('state', filters.state)
    if (filters.market) q = q.eq('market', filters.market)

    const { data } = await q
    if (!data?.length) return []

    type MktAcc = { state: string; sent: number; delivered: number; replied: number; positive: number; optOut: number }
    const mm = new Map<string, MktAcc>()

    for (const ev of data) {
      const mkt = (ev.market as string | null) ?? ''
      if (!mkt) continue
      if (!mm.has(mkt)) mm.set(mkt, { state: (ev.state as string | null) ?? '—', sent: 0, delivered: 0, replied: 0, positive: 0, optOut: 0 })
      const acc = mm.get(mkt)!
      if (ev.direction === 'outbound') {
        acc.sent++
        if (ev.delivery_status === 'delivered') acc.delivered++
      } else if (ev.direction === 'inbound') {
        acc.replied++
        if (POSITIVE_INTENTS.has(ev.detected_intent ?? '')) acc.positive++
        if (OPTOUT_INTENTS.has(ev.detected_intent ?? '')) acc.optOut++
      }
    }

    return Array.from(mm.entries())
      .map(([market, m]): MarketPerformance => {
        const deliveryRate = pct(m.delivered, m.sent)
        const replyRate = pct(m.replied, m.sent, 1)
        const positiveRate = pct(m.positive, m.replied)
        const optOutRate = pct(m.optOut, m.sent, 1)
        const recommendation: MarketPerformance['recommendation'] =
          m.sent < 5 ? 'No Data' :
          optOutRate > 3 ? 'Investigate' :
          optOutRate > 1.5 ? 'Pause' :
          positiveRate > 20 ? 'Scale' : 'Watch'
        return {
          market, state: m.state,
          sent: m.sent, delivered: m.delivered, replied: m.replied,
          positive: m.positive, optOut: m.optOut, hotLeads: m.positive,
          offers: 0, contracts: 0, revenue: null,
          buyerDemandScore: Math.min(100, m.positive * 12 + m.replied * 3),
          deliveryRate, replyRate, positiveRate, optOutRate, recommendation,
        }
      })
      .sort((a, b) => b.replied - a.replied)
      .slice(0, 50)
  } catch {
    return []
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// loadAgentPerformance
// ══════════════════════════════════════════════════════════════════════════════

export const loadAgentPerformance = async (filters: KpiFilters): Promise<AgentPerformance[]> => {
  const supabase = getSupabaseClient()
  const { start, end } = getKpiDateRange(filters)

  try {
    let q = supabase
      .from('message_events')
      .select('direction,delivery_status,detected_intent,sender_name,market')
      .gte('created_at', start)
      .lte('created_at', end)
      .limit(20000)

    if (filters.state) q = q.eq('state', filters.state)
    if (filters.market) q = q.eq('market', filters.market)

    const { data } = await q
    if (!data?.length) return []

    type AgtAcc = { sent: number; delivered: number; replied: number; positive: number; optOut: number; markets: string[] }
    const am = new Map<string, AgtAcc>()

    for (const ev of data) {
      const name = (ev.sender_name as string | null) ?? 'Unknown'
      if (name === 'Unknown' || !name) continue
      if (!am.has(name)) am.set(name, { sent: 0, delivered: 0, replied: 0, positive: 0, optOut: 0, markets: [] })
      const acc = am.get(name)!
      const mkt = ev.market as string | null
      if (mkt && !acc.markets.includes(mkt)) acc.markets.push(mkt)
      if (ev.direction === 'outbound') {
        acc.sent++
        if (ev.delivery_status === 'delivered') acc.delivered++
      } else if (ev.direction === 'inbound') {
        acc.replied++
        if (POSITIVE_INTENTS.has(ev.detected_intent ?? '')) acc.positive++
        if (OPTOUT_INTENTS.has(ev.detected_intent ?? '')) acc.optOut++
      }
    }

    return Array.from(am.entries())
      .map(([agentId, a]): AgentPerformance => {
        const replyRate = pct(a.replied, a.sent, 1)
        const positiveRate = pct(a.positive, a.replied)
        const optOutRate = pct(a.optOut, a.sent, 1)
        const badges: string[] = []
        if (replyRate > 8) badges.push('#1 Reply Rate')
        if (positiveRate > 30) badges.push('#1 Positive')
        if (optOutRate < 0.5 && a.sent > 20) badges.push('Lowest Opt-Out')
        return {
          agentId, agentName: agentId,
          sent: a.sent, delivered: a.delivered, replied: a.replied,
          positive: a.positive, optOut: a.optOut,
          replyRate, positiveRate, optOutRate,
          bestMarket: a.markets[0] ?? '—',
          activeConversations: 0, contractsInfluenced: 0, badges,
        }
      })
      .sort((a, b) => b.replied - a.replied)
      .slice(0, 20)
  } catch {
    return []
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// loadTemplatePerformance
// ══════════════════════════════════════════════════════════════════════════════

export const loadTemplatePerformance = async (filters: KpiFilters): Promise<TemplatePerformance[]> => {
  const supabase = getSupabaseClient()
  const { start, end } = getKpiDateRange(filters)

  try {
    let q = supabase
      .from('message_events')
      .select('direction,delivery_status,detected_intent,template_id,message_body')
      .gte('created_at', start)
      .lte('created_at', end)
      .limit(20000)

    if (filters.state) q = q.eq('state', filters.state)
    if (filters.market) q = q.eq('market', filters.market)

    const { data } = await q
    if (!data?.length) return []

    type TplAcc = { preview: string; sent: number; delivered: number; replied: number; positive: number; optOut: number; wrongNumber: number; deliveryFailed: number }
    const tm = new Map<string, TplAcc>()

    for (const ev of data) {
      const tplId = ev.template_id ? String(ev.template_id) : null
      if (!tplId) continue
      if (!tm.has(tplId)) {
        tm.set(tplId, {
          preview: String(ev.message_body ?? '').slice(0, 80),
          sent: 0, delivered: 0, replied: 0, positive: 0, optOut: 0, wrongNumber: 0, deliveryFailed: 0,
        })
      }
      const acc = tm.get(tplId)!
      if (ev.direction === 'outbound') {
        acc.sent++
        if (ev.delivery_status === 'delivered') acc.delivered++
        if (['failed', 'undelivered'].includes(ev.delivery_status ?? '')) acc.deliveryFailed++
      } else if (ev.direction === 'inbound') {
        acc.replied++
        if (POSITIVE_INTENTS.has(ev.detected_intent ?? '')) acc.positive++
        if (OPTOUT_INTENTS.has(ev.detected_intent ?? '')) acc.optOut++
        if (WRONG_NUM_INTENTS.has(ev.detected_intent ?? '')) acc.wrongNumber++
      }
    }

    return Array.from(tm.entries())
      .map(([templateId, t]): TemplatePerformance => {
        const replyRate = pct(t.replied, t.sent, 1)
        const positiveRate = pct(t.positive, t.replied)
        const stopRate = pct(t.optOut, t.sent, 1)
        const deliveryRate = pct(t.delivered, t.sent)
        const flags: string[] = []
        if (stopRate > 2) flags.push('High Opt-Out')
        if (t.sent < 10) flags.push('Low Data')
        if (replyRate > 8) flags.push('Strong Performer')
        if (positiveRate > 30) flags.push('Top Converter')
        if (!t.preview) flags.push('Missing Preview')
        const recommendation: TemplatePerformance['recommendation'] =
          t.sent < 5 ? 'Needs Data' :
          stopRate > 3 ? 'Kill' :
          stopRate > 1.5 ? 'Pause' :
          replyRate > 6 ? 'Scale' :
          t.sent < 30 ? 'Testing' : 'Pause'
        return {
          templateId, preview: t.preview, language: 'en', useCase: 'outbound',
          sent: t.sent, delivered: t.delivered, replied: t.replied,
          positive: t.positive, optOut: t.optOut,
          wrongNumber: t.wrongNumber, deliveryFailed: t.deliveryFailed,
          replyRate, positiveRate, stopRate, deliveryRate,
          recommendation, flags, trafficWeight: null,
        }
      })
      .sort((a, b) => b.sent - a.sent)
      .slice(0, 30)
  } catch {
    return []
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// loadChannelPerformance
// ══════════════════════════════════════════════════════════════════════════════

export const loadChannelPerformance = async (filters: KpiFilters): Promise<ChannelPerformance[]> => {
  const supabase = getSupabaseClient()
  const { start, end } = getKpiDateRange(filters)

  try {
    const { data } = await supabase
      .from('message_events')
      .select('direction,delivery_status,detected_intent,channel')
      .gte('created_at', start)
      .lte('created_at', end)
      .limit(20000)

    const evs = data ?? []
    const smsEvs = evs.filter(e => !e.channel || e.channel === 'sms')
    const emailEvs = evs.filter(e => e.channel === 'email')

    const buildChannel = (ces: typeof evs, channel: 'sms' | 'email', isWired: boolean): ChannelPerformance => {
      const out = ces.filter(e => e.direction === 'outbound')
      const inn = ces.filter(e => e.direction === 'inbound')
      const sent = out.length
      const delivered = out.filter(e => e.delivery_status === 'delivered').length
      const replied = inn.length
      const positive = inn.filter(e => POSITIVE_INTENTS.has(e.detected_intent ?? '')).length
      const optOut = inn.filter(e => OPTOUT_INTENTS.has(e.detected_intent ?? '')).length
      const bounced = out.filter(e => ['failed', 'undelivered'].includes(e.delivery_status ?? '')).length
      const spend = sent * SMS_COST_PER_MSG
      return {
        channel, sent, delivered, replied, positive, optOut, bounced,
        spend: Math.round(spend * 100) / 100,
        costPerReply: replied > 0 ? Math.round((spend / replied) * 100) / 100 : null,
        costPerPositive: positive > 0 ? Math.round((spend / positive) * 100) / 100 : null,
        deliveryRate: pct(delivered, sent),
        replyRate: pct(replied, sent, 1),
        positiveRate: pct(positive, replied),
        isWired,
      }
    }

    return [
      buildChannel(smsEvs, 'sms', true),
      buildChannel(emailEvs, 'email', emailEvs.length > 0),
    ]
  } catch {
    return [
      { channel: 'sms', sent: 0, delivered: 0, replied: 0, positive: 0, optOut: 0, bounced: 0, spend: 0, costPerReply: null, costPerPositive: null, deliveryRate: 0, replyRate: 0, positiveRate: 0, isWired: false },
      { channel: 'email', sent: 0, delivered: 0, replied: 0, positive: 0, optOut: 0, bounced: 0, spend: 0, costPerReply: null, costPerPositive: null, deliveryRate: 0, replyRate: 0, positiveRate: 0, isWired: false },
    ]
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// loadSpendPerformance
// ══════════════════════════════════════════════════════════════════════════════

// Revenue assumptions — configurable, not hardcoded as real revenue.
// Update these when real contract/closing data is available.
const REVENUE_ASSUMPTIONS = {
  conservative: { contracts: 1, avgRevenue: 18000 },
  base: { contracts: 4, avgRevenue: 25000 },
  aggressive: { contracts: 10, avgRevenue: 35000 },
}

export const loadSpendPerformance = async (filters: KpiFilters, preloadedSummary?: KpiSummary): Promise<SpendPerformance> => {
  try {
    const summary = preloadedSummary ?? await loadKpiDashboardSummary(filters)
    const spend = summary.spendPeriod
    return {
      periodLabel: filters.timeRange,
      smsSend: spend, emailSend: 0, dataAcquisition: 0, totalSpend: spend,
      costPerSent: summary.sentCount > 0 ? Math.round((spend / summary.sentCount) * 10000) / 10000 : null,
      costPerDelivered: summary.deliveredCount > 0 ? Math.round((spend / summary.deliveredCount) * 10000) / 10000 : null,
      costPerReply: summary.costPerReply,
      costPerPositive: summary.costPerPositive,
      costPerOffer: null, // TODO: wire when offers table available
      costPerContract: null, // TODO: wire when contracts table available
      projectedROI: null, // TODO: wire when revenue data available
      conservative: { ...REVENUE_ASSUMPTIONS.conservative, totalRevenue: REVENUE_ASSUMPTIONS.conservative.contracts * REVENUE_ASSUMPTIONS.conservative.avgRevenue },
      base: { ...REVENUE_ASSUMPTIONS.base, totalRevenue: REVENUE_ASSUMPTIONS.base.contracts * REVENUE_ASSUMPTIONS.base.avgRevenue },
      aggressive: { ...REVENUE_ASSUMPTIONS.aggressive, totalRevenue: REVENUE_ASSUMPTIONS.aggressive.contracts * REVENUE_ASSUMPTIONS.aggressive.avgRevenue },
    }
  } catch {
    return {
      periodLabel: filters.timeRange,
      smsSend: 0, emailSend: 0, dataAcquisition: 0, totalSpend: 0,
      costPerSent: null, costPerDelivered: null, costPerReply: null, costPerPositive: null,
      costPerOffer: null, costPerContract: null, projectedROI: null,
      conservative: { ...REVENUE_ASSUMPTIONS.conservative, totalRevenue: 18000 },
      base: { ...REVENUE_ASSUMPTIONS.base, totalRevenue: 100000 },
      aggressive: { ...REVENUE_ASSUMPTIONS.aggressive, totalRevenue: 350000 },
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// loadRevenueForecast — returns empty until closing data is wired
// ══════════════════════════════════════════════════════════════════════════════

export const loadRevenueForecast = async (_filters: KpiFilters): Promise<[]> => {
  // TODO: wire real closed/revenue records when offers/contracts/closings tables are available
  return []
}

// ══════════════════════════════════════════════════════════════════════════════
// loadFunnelPerformance
// ══════════════════════════════════════════════════════════════════════════════

export const loadFunnelPerformance = async (filters: KpiFilters): Promise<FunnelStage[]> => {
  const supabase = getSupabaseClient()
  const { start, end } = getKpiDateRange(filters)

  try {
    const [evRes, qRes] = await Promise.all([
      supabase
        .from('message_events')
        .select('direction,delivery_status,detected_intent')
        .gte('created_at', start)
        .lte('created_at', end)
        .limit(20000),
      supabase
        .from('send_queue')
        .select('queue_status')
        .gte('created_at', start)
        .limit(5000),
    ])

    const evs = evRes.data ?? []
    const qItems = qRes.data ?? []

    const queued = qItems.length
    const out = evs.filter(e => e.direction === 'outbound')
    const inn = evs.filter(e => e.direction === 'inbound')
    const sent = out.length
    const delivered = out.filter(e => e.delivery_status === 'delivered').length
    const replied = inn.length
    const positive = inn.filter(e => POSITIVE_INTENTS.has(e.detected_intent ?? '')).length

    const rawStages: Array<{ id: string; label: string; count: number; isEstimate: boolean }> = [
      { id: 'queued', label: 'Queued', count: queued, isEstimate: false },
      { id: 'sent', label: 'Sent', count: sent, isEstimate: false },
      { id: 'delivered', label: 'Delivered', count: delivered, isEstimate: false },
      { id: 'replied', label: 'Replied', count: replied, isEstimate: false },
      { id: 'positive', label: 'Positive Intent', count: positive, isEstimate: false },
      { id: 'qualified', label: 'Qualified', count: Math.round(positive * 0.6), isEstimate: true },
      { id: 'underwritten', label: 'Underwritten', count: Math.round(positive * 0.3), isEstimate: true },
      { id: 'offer_created', label: 'Offer Created', count: 0, isEstimate: false }, // TODO: wire offers
      { id: 'offer_sent', label: 'Offer Sent', count: 0, isEstimate: false },       // TODO: wire offers
      { id: 'contract_sent', label: 'Contract Sent', count: 0, isEstimate: false }, // TODO: wire contracts
      { id: 'under_contract', label: 'Under Contract', count: 0, isEstimate: false },
      { id: 'closed', label: 'Closed', count: 0, isEstimate: false },               // TODO: wire closings
    ]

    return rawStages.map((stage, i): FunnelStage => {
      const prevStageCount = i > 0 ? rawStages[i - 1].count : stage.count
      const conversionRate = prevStageCount > 0 ? pct(stage.count, prevStageCount) : null
      const dropOffRate = conversionRate !== null ? 100 - conversionRate : null
      return {
        ...stage,
        prevCount: 0,
        conversionRate,
        dropOffRate,
        trend: 'neutral',
      }
    })
  } catch {
    return []
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// loadDataQualityMetrics
// ══════════════════════════════════════════════════════════════════════════════

export const loadDataQualityMetrics = async (filters: KpiFilters): Promise<DataQualityMetrics> => {
  const supabase = getSupabaseClient()
  const { start, end } = getKpiDateRange(filters)

  const empty: DataQualityMetrics = {
    missingPhone: 0, missingEmail: 0, missingOwnerName: 0, missingZip: 0,
    invalidPhone: 0, dncCount: 0, wrongNumber: 0, duplicate: 0,
    routingBlocked: 0, noSenderCoverage: 0, failedQueueRows: 0, blankBody: 0,
    deliveryLag: null, queueLatency: null, autoReplyBlocked: 0, manualReviewCount: 0,
    healthScore: 75,
  }

  try {
    const [qRes, evRes] = await Promise.all([
      supabase
        .from('send_queue')
        .select('queue_status,failure_reason,message_body')
        .gte('created_at', start)
        .lte('created_at', end)
        .limit(5000),
      supabase
        .from('message_events')
        .select('detected_intent,direction')
        .gte('created_at', start)
        .lte('created_at', end)
        .limit(10000),
    ])

    const qItems = qRes.data ?? []
    const evs = evRes.data ?? []

    const failedQueueRows = qItems.filter(i => i.queue_status === 'failed').length
    const blankBody = qItems.filter(i => !String(i.message_body ?? '').trim()).length
    const routingBlocked = qItems.filter(i => ['blocked', 'routing_error', 'no_sender'].includes(i.failure_reason ?? '')).length
    const wrongNumber = evs.filter(e => e.direction === 'inbound' && WRONG_NUM_INTENTS.has(e.detected_intent ?? '')).length
    const autoReplyBlocked = qItems.filter(i => i.queue_status === 'held').length
    const manualReviewCount = qItems.filter(i => i.queue_status === 'approval').length

    const issues = failedQueueRows + blankBody + routingBlocked + wrongNumber + autoReplyBlocked
    const total = Math.max(qItems.length + evs.length, 1)
    const healthScore = Math.max(0, Math.round(100 - (issues / total) * 100))

    return {
      ...empty,
      failedQueueRows, blankBody, routingBlocked, wrongNumber,
      autoReplyBlocked, manualReviewCount, healthScore,
    }
  } catch {
    return empty
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// loadBuyerDemandMetrics — not wired yet
// ══════════════════════════════════════════════════════════════════════════════

export const loadBuyerDemandMetrics = async (_filters: KpiFilters): Promise<BuyerDemandMetrics> => {
  // TODO: wire buyer_match table when available
  return {
    totalMatches: 0, topMarkets: [], avgConfidence: 0,
    buyerResponseRate: null, assignedCount: 0, isWired: false,
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// loadOfferContractMetrics — not wired yet
// ══════════════════════════════════════════════════════════════════════════════

export const loadOfferContractMetrics = async (_filters: KpiFilters): Promise<OfferContractMetrics> => {
  // TODO: wire offers/contracts/closings tables when available
  return {
    offersCreated: 0, offersSent: 0, offersAccepted: 0, offersRejected: 0,
    contractsGenerated: 0, contractsSent: 0, sellerSigned: 0, fullyExecuted: 0,
    sentToTitle: 0, closed: 0, cancelled: 0,
    offerConversionRate: null, contractConversionRate: null,
    avgSpread: null, projectedRevenue: null, isWired: false,
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// loadTextgridNumberHealth
// ══════════════════════════════════════════════════════════════════════════════

export const calculateNumberHealthScore = (m: {
  deliveryRate: number
  optOutRate: number
  failureRate: number
  blacklistEvents: number
  dailyCapUsedPct: number
}): number => {
  let score = 100
  score -= Math.max(0, 95 - m.deliveryRate) * 0.5
  score -= Math.min(30, m.optOutRate * 10)
  score -= Math.min(20, m.failureRate * 8)
  score -= Math.min(40, m.blacklistEvents * 20)
  if (m.dailyCapUsedPct > 90) score -= 15
  else if (m.dailyCapUsedPct > 75) score -= 8
  return Math.max(0, Math.round(score))
}

export const loadTextgridNumberHealth = async (filters: KpiFilters): Promise<TextgridNumberHealth[]> => {
  const supabase = getSupabaseClient()
  const { start, end } = getKpiDateRange(filters)

  try {
    const { data: numbers, error } = await supabase
      .from('textgrid_numbers')
      .select('id,phone_number,friendly_name,market,state,is_active,daily_cap')
      .limit(200)

    if (error || !numbers?.length) return []

    const { data: events } = await supabase
      .from('message_events')
      .select('direction,delivery_status,detected_intent,from_number')
      .gte('created_at', start)
      .lte('created_at', end)
      .limit(20000)

    const evs = events ?? []

    return numbers.map((n): TextgridNumberHealth => {
      const phone = String(n.phone_number ?? '')
      const numEvs = evs.filter(e => (e.from_number as string | null) === phone)
      const out = numEvs.filter(e => e.direction === 'outbound')
      const inn = numEvs.filter(e => e.direction === 'inbound')

      const sentToday = out.length
      const delivered = out.filter(e => e.delivery_status === 'delivered').length
      const failed = out.filter(e => ['failed', 'undelivered'].includes(e.delivery_status ?? '')).length
      const replies = inn.length
      const positive = inn.filter(e => POSITIVE_INTENTS.has(e.detected_intent ?? '')).length
      const optOuts = inn.filter(e => OPTOUT_INTENTS.has(e.detected_intent ?? '')).length
      const blacklistEvents = out.filter(e => ['blacklisted', '21610'].includes(e.delivery_status ?? '')).length

      const deliveryRate = pct(delivered, sentToday)
      const failureRate = pct(failed, sentToday)
      const replyRate = pct(replies, sentToday, 1)
      const optOutRate = pct(optOuts, sentToday, 1)
      const dailyCap = (n.daily_cap as number | null) ?? 500
      const dailyCapUsedPct = sentToday > 0 ? Math.round((sentToday / dailyCap) * 100) : 0

      const healthScore = calculateNumberHealthScore({ deliveryRate, optOutRate, failureRate, blacklistEvents, dailyCapUsedPct })

      const recommendation: TextgridNumberHealth['recommendation'] =
        blacklistEvents > 0 ? 'Pause' :
        healthScore < 40 ? 'Replace' :
        healthScore < 60 ? 'Pause' :
        dailyCapUsedPct > 90 ? 'Throttle' :
        healthScore < 75 ? 'Watch' : 'Healthy'

      return {
        numberId: String(n.id ?? ''),
        phoneNumber: phone,
        friendlyName: String(n.friendly_name ?? phone),
        market: String(n.market ?? '—'),
        state: String(n.state ?? '—'),
        isActive: n.is_active !== false,
        sentToday, sentLast7: 0, sentLast30: 0,
        delivered, deliveryRate, failed, failureRate,
        replies, replyRate, positiveReplies: positive,
        optOuts, optOutRate, wrongNumbers: 0, blacklistEvents,
        dailyCapUsedPct, healthScore, recommendation,
      }
    }).sort((a, b) => b.sentToday - a.sentToday)
  } catch {
    return []
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// loadCarrierPerformance
// ══════════════════════════════════════════════════════════════════════════════

export const loadCarrierPerformance = async (filters: KpiFilters): Promise<CarrierPerformance[]> => {
  const supabase = getSupabaseClient()
  const { start, end } = getKpiDateRange(filters)

  try {
    const { data } = await supabase
      .from('message_events')
      .select('direction,delivery_status,detected_intent,carrier_name,line_type')
      .gte('created_at', start)
      .lte('created_at', end)
      .limit(20000)

    const evs = data ?? []
    if (!evs.some(e => e.carrier_name)) return [] // no carrier data

    type CarrAcc = { lineType: string; sent: number; delivered: number; replied: number; positive: number; optOut: number; failed: number }
    const cm = new Map<string, CarrAcc>()

    for (const ev of evs) {
      const carrier = (ev.carrier_name as string | null) ?? 'Unknown'
      const lineType = (ev.line_type as string | null) ?? 'unknown'
      if (!cm.has(carrier)) cm.set(carrier, { lineType, sent: 0, delivered: 0, replied: 0, positive: 0, optOut: 0, failed: 0 })
      const acc = cm.get(carrier)!
      if (ev.direction === 'outbound') {
        acc.sent++
        if (ev.delivery_status === 'delivered') acc.delivered++
        if (['failed', 'undelivered'].includes(ev.delivery_status ?? '')) acc.failed++
      } else {
        acc.replied++
        if (POSITIVE_INTENTS.has(ev.detected_intent ?? '')) acc.positive++
        if (OPTOUT_INTENTS.has(ev.detected_intent ?? '')) acc.optOut++
      }
    }

    return Array.from(cm.entries())
      .map(([carrier, c]): CarrierPerformance => ({
        carrier, lineType: c.lineType,
        sent: c.sent, delivered: c.delivered, deliveryRate: pct(c.delivered, c.sent),
        replied: c.replied, replyRate: pct(c.replied, c.sent, 1),
        positive: c.positive, optOut: c.optOut, optOutRate: pct(c.optOut, c.sent, 1),
        failed: c.failed, avgLatencyMs: null, topFailureReason: null, isWired: true,
      }))
      .sort((a, b) => b.sent - a.sent)
  } catch {
    return []
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// loadNumberCarrierMatrix
// ══════════════════════════════════════════════════════════════════════════════

export const loadNumberCarrierMatrix = async (_filters: KpiFilters): Promise<NumberCarrierMatrix> => {
  // TODO: wire when carrier + market cross-tab data available in message_events
  return { carriers: [], markets: [], cells: {} }
}

// ══════════════════════════════════════════════════════════════════════════════
// loadNumberHealthAlerts
// ══════════════════════════════════════════════════════════════════════════════

export const loadNumberHealthAlerts = async (filters: KpiFilters): Promise<NumberHealthAlert[]> => {
  try {
    const numbers = await loadTextgridNumberHealth(filters)
    const alerts: NumberHealthAlert[] = []

    for (const n of numbers) {
      if (n.blacklistEvents > 0) {
        alerts.push({
          severity: 'critical', type: 'blacklist_event',
          message: `Blacklist/21610 event on ${n.phoneNumber} (${n.market}) — pause immediately`,
          affectedNumber: n.phoneNumber, affectedMarket: n.market,
        })
      }
      if (n.dailyCapUsedPct > 85) {
        alerts.push({
          severity: 'warning', type: 'cap_overuse',
          message: `${n.phoneNumber} at ${n.dailyCapUsedPct}% daily cap — consider throttling`,
          affectedNumber: n.phoneNumber, affectedMarket: n.market,
        })
      }
      if (n.optOutRate > 2 && n.sentToday > 20) {
        alerts.push({
          severity: 'warning', type: 'high_opt_out',
          message: `${n.phoneNumber}: ${n.optOutRate}% opt-out rate — review template targeting`,
          affectedNumber: n.phoneNumber, affectedMarket: n.market,
        })
      }
    }

    return alerts
  } catch {
    return []
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// loadKpiAlerts — derives AI-style recommendations from real data thresholds
// ══════════════════════════════════════════════════════════════════════════════

export interface KpiAlertsInput {
  states?: StatePerformance[]
  templates?: TemplatePerformance[]
  numbers?: TextgridNumberHealth[]
  quality?: DataQualityMetrics
}

export const loadKpiAlerts = async (filters: KpiFilters, prefetched?: KpiAlertsInput): Promise<KpiAlert[]> => {
  try {
    const [states, templates, numbers, quality] = prefetched
      ? [
          prefetched.states  ?? await loadStatePerformance(filters),
          prefetched.templates ?? await loadTemplatePerformance(filters),
          prefetched.numbers ?? await loadTextgridNumberHealth(filters),
          prefetched.quality ?? await loadDataQualityMetrics(filters),
        ]
      : await Promise.all([
          loadStatePerformance(filters),
          loadTemplatePerformance(filters),
          loadTextgridNumberHealth(filters),
          loadDataQualityMetrics(filters),
        ])

    const alerts: KpiAlert[] = []
    let id = 0

    for (const s of states.filter(x => x.recommendation === 'Scale').slice(0, 2)) {
      alerts.push({
        id: String(++id), severity: 'opportunity', category: 'Market Intelligence',
        message: `Scale ${s.stateName}: ${s.positiveRate}% positive rate, ${s.optOutRate}% opt-out`,
        affectedEntity: s.state,
        suggestedAction: `Increase volume allocation for ${s.stateName}`,
      })
    }

    for (const s of states.filter(x => x.recommendation === 'Investigate').slice(0, 2)) {
      alerts.push({
        id: String(++id), severity: 'warning', category: 'State Performance',
        message: `Investigate ${s.stateName}: ${s.optOutRate}% opt-out rate`,
        affectedEntity: s.state,
        suggestedAction: `Audit templates and targeting for ${s.stateName}`,
      })
    }

    for (const t of templates.filter(x => x.recommendation === 'Kill' || x.recommendation === 'Pause').slice(0, 3)) {
      alerts.push({
        id: String(++id),
        severity: t.recommendation === 'Kill' ? 'critical' : 'warning',
        category: 'Template Performance',
        message: `Template ${t.templateId}: ${t.stopRate}% stop rate — ${t.recommendation}`,
        affectedEntity: t.templateId,
        suggestedAction: `${t.recommendation} template ${t.templateId}`,
      })
    }

    for (const t of templates.filter(x => x.recommendation === 'Scale').slice(0, 1)) {
      alerts.push({
        id: String(++id), severity: 'opportunity', category: 'Template Performance',
        message: `Template ${t.templateId}: ${t.replyRate}% reply rate — scale traffic`,
        affectedEntity: t.templateId,
        suggestedAction: `Increase traffic weight for template ${t.templateId}`,
      })
    }

    for (const n of numbers.filter(x => x.blacklistEvents > 0).slice(0, 2)) {
      alerts.push({
        id: String(++id), severity: 'critical', category: 'Numbers Health',
        message: `${n.phoneNumber} (${n.market}): 21610/blacklist event — pause immediately`,
        affectedEntity: n.phoneNumber,
        suggestedAction: `Pause and replace ${n.phoneNumber}`,
      })
    }

    if (quality.failedQueueRows > 50) {
      alerts.push({
        id: String(++id), severity: 'warning', category: 'Queue Health',
        message: `${quality.failedQueueRows} failed queue items — review routing and data`,
        suggestedAction: 'Audit failed queue rows for common failure reasons',
      })
    }

    if (!alerts.length) {
      alerts.push({
        id: String(++id), severity: 'info', category: 'System',
        message: 'No active alerts — system operating normally',
      })
    }

    return alerts
  } catch {
    return [{
      id: '1', severity: 'info', category: 'System',
      message: 'Alert engine requires data — check Supabase connection',
    }]
  }
}
