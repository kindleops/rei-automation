import { callBackend } from '../api/backendClient'

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
  bestTemplate?: string
  activeConversations: number
  contractsInfluenced: number
  badges: string[]
}

export interface TemplatePerformance {
  templateId: string
  name?: string
  agentPersona?: string
  stage?: string
  topMarket?: string
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
  positiveRate: number
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

// ══════════════════════════════════════════════════════════════════════════════
// War Room endpoint integration
// ──────────────────────────────────────────────────────────────────────────────
// All KPI sections are served by a single real-data endpoint:
//   GET /api/cockpit/metrics/war-room
// which aggregates public.send_queue + message_events + sms_templates + campaigns
// server-side (service role). The loaders below fetch that payload once per
// filter signature (shared promise cache) and map into the typed shapes the
// MetricsWarRoom UI already consumes. No direct browser Supabase queries.
// ══════════════════════════════════════════════════════════════════════════════

interface WarRoomPayload {
  ok?: boolean
  degraded?: boolean
  window: string
  channel: string
  generated_at: string
  source_audit: Record<string, unknown> & { notes?: string[] }
  kpis: {
    sentCount: number; deliveredCount: number; repliedCount: number; positiveReplies: number
    optOutCount: number; failedCount: number; deliveryRate: number; replyRate: number
    positiveRate: number; optOutRate: number; spendPeriod: number
    costPerReply: number | null; costPerPositive: number | null
    queueHealth: 'good' | 'warning' | 'critical'; automationHealthScore: number
    buyerDemandScore: number; dataQualityScore: number
  }
  timeseries: Array<{ date: string; sent: number; delivered: number; replied: number; positive: number; optOut: number; failed: number; spend: number }>
  funnel: Array<{ id: string; label: string; count: number; isEstimate: boolean; prevCount: number; conversionRate: number | null; dropOffRate: number | null; trend: 'up' | 'down' | 'neutral' }>
  state_leaderboard: Array<Record<string, unknown>>
  market_leaderboard: Array<Record<string, unknown>>
  agent_leaderboard: Array<Record<string, unknown>>
  sms_template_leaderboard: Array<Record<string, unknown>>
  email_template_leaderboard: Array<Record<string, unknown>>
  campaign_leaderboard: Array<Record<string, unknown>>
  alerts: Array<{ id: string; severity: KpiAlert['severity']; category: string; message: string; affectedEntity?: string; suggestedAction?: string }>
  carrier_intelligence: Array<Record<string, unknown>>
  textgrid_numbers_health: { totalNumbers: number; activeNumbers: number; numbers: Array<Record<string, unknown>> }
  email_health: Record<string, unknown> & { wired?: boolean }
  data_automation_health: Record<string, unknown>
  buyer_demand: Record<string, unknown> & { wired?: boolean }
}

const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d }
const str = (v: unknown, d = ''): string => (v == null ? d : String(v))

const timeRangeToWindow = (r: KpiTimeRange): string => {
  switch (r) {
    case 'today': return 'today'
    case 'yesterday': return 'yesterday'
    case 'last_7_days': return '7d'
    case 'last_30_days': return '30d'
    case 'last_40_days': return '40d'
    case 'custom': return '30d'
    default: return '7d'
  }
}

// ── Shared per-signature payload cache (so the parallel loader batch = 1 fetch) ─
const WAR_ROOM_TTL_MS = 10_000
const warRoomCache = new Map<string, { ts: number; promise: Promise<WarRoomPayload | null> }>()

const filterSignature = (f: KpiFilters): string =>
  [timeRangeToWindow(f.timeRange), f.channel ?? 'all', f.state ?? 'all', f.market ?? 'all', f.agent ?? 'all'].join('|')

async function fetchWarRoom(filters: KpiFilters): Promise<WarRoomPayload | null> {
  const sig = filterSignature(filters)
  const now = Date.now()
  const cached = warRoomCache.get(sig)
  if (cached && now - cached.ts < WAR_ROOM_TTL_MS) return cached.promise

  const qs = new URLSearchParams({
    window: timeRangeToWindow(filters.timeRange),
    channel: filters.channel ?? 'all',
    state: filters.state || 'all',
    market: filters.market || 'all',
    agent: filters.agent || 'all',
  }).toString()

  const promise = (async () => {
    const res = await callBackend<WarRoomPayload>(`/api/cockpit/metrics/war-room?${qs}`)
    if (!res.ok) {
      console.error('[WAR_ROOM_FETCH_FAILED]', res.status, res.error, res.message)
      return null
    }
    const payload = res.data
    if (!payload || payload.ok === false) {
      console.error('[WAR_ROOM_DEGRADED]', payload)
      return payload && payload.kpis ? payload : null
    }
    if (typeof console !== 'undefined') {
      console.log('[WAR_ROOM_SCHEMA_AUDIT]', payload.source_audit)
    }
    return payload
  })()

  warRoomCache.set(sig, { ts: now, promise })
  return promise
}

// ── loadKpiDashboardSummary ────────────────────────────────────────────────────

export const loadKpiDashboardSummary = async (filters: KpiFilters): Promise<KpiSummary> => {
  const empty: KpiSummary = {
    sentCount: 0, deliveredCount: 0, repliedCount: 0, positiveReplies: 0,
    optOutCount: 0, failedCount: 0, deliveryRate: 0, replyRate: 0,
    positiveRate: 0, optOutRate: 0, prevSentCount: 0, prevRepliedCount: 0,
    prevPositiveReplies: 0, offersCreated: 0, contractsSent: 0,
    underContract: 0, closedDeals: 0, spendPeriod: 0,
    costPerReply: null, costPerPositive: null,
    projectedMonthlyRevenue: null, pipelineValue: null,
    automationHealthScore: 100, buyerDemandScore: 0, queueHealth: 'good',
    dataQualityScore: 0, periodLabel: filters.timeRange,
    lastUpdated: new Date().toISOString(), isLive: false,
  }
  const p = await fetchWarRoom(filters)
  if (!p?.kpis) return empty
  const k = p.kpis
  return {
    ...empty,
    sentCount: k.sentCount, deliveredCount: k.deliveredCount, repliedCount: k.repliedCount,
    positiveReplies: k.positiveReplies, optOutCount: k.optOutCount, failedCount: k.failedCount,
    deliveryRate: k.deliveryRate, replyRate: k.replyRate, positiveRate: k.positiveRate, optOutRate: k.optOutRate,
    spendPeriod: k.spendPeriod, costPerReply: k.costPerReply, costPerPositive: k.costPerPositive,
    automationHealthScore: k.automationHealthScore, buyerDemandScore: k.buyerDemandScore,
    queueHealth: k.queueHealth, dataQualityScore: k.dataQualityScore,
    lastUpdated: p.generated_at, isLive: true,
  }
}

// ── loadKpiTimeSeries ──────────────────────────────────────────────────────────

export const loadKpiTimeSeries = async (filters: KpiFilters): Promise<TimeSeriesPoint[]> => {
  const p = await fetchWarRoom(filters)
  if (!p?.timeseries) return []
  return p.timeseries.map((t): TimeSeriesPoint => ({
    date: t.date, sent: t.sent, delivered: t.delivered, replied: t.replied,
    positive: t.positive, optOut: t.optOut, failed: t.failed,
    offers: 0, contracts: 0, spend: t.spend,
  }))
}

// ── loadStatePerformance ───────────────────────────────────────────────────────

export const loadStatePerformance = async (filters: KpiFilters): Promise<StatePerformance[]> => {
  const p = await fetchWarRoom(filters)
  if (!p?.state_leaderboard) return []
  return p.state_leaderboard.map((s): StatePerformance => {
    const state = str(s.state)
    return {
      state, stateName: STATE_NAMES[state] ?? state,
      sent: num(s.sent), delivered: num(s.delivered), replied: num(s.replied),
      positive: num(s.positive), optOut: num(s.optOut), contracts: 0, revenue: null,
      topMarket: str(s.topMarket, '—'),
      deliveryRate: num(s.deliveryRate), replyRate: num(s.replyRate),
      positiveRate: num(s.positiveRate), optOutRate: num(s.optOutRate),
      status: (str(s.status, 'quiet') as StatePerformance['status']),
      recommendation: (str(s.recommendation, 'No Data') as StatePerformance['recommendation']),
    }
  })
}

// ── loadMarketPerformance ──────────────────────────────────────────────────────

export const loadMarketPerformance = async (filters: KpiFilters): Promise<MarketPerformance[]> => {
  const p = await fetchWarRoom(filters)
  if (!p?.market_leaderboard) return []
  return p.market_leaderboard.map((m): MarketPerformance => ({
    market: str(m.market), state: str(m.state, '—'),
    sent: num(m.sent), delivered: num(m.delivered), replied: num(m.replied),
    positive: num(m.positive), optOut: num(m.optOut), hotLeads: num(m.positive),
    offers: 0, contracts: 0, revenue: null,
    buyerDemandScore: num(m.buyerDemandScore),
    deliveryRate: num(m.deliveryRate), replyRate: num(m.replyRate),
    positiveRate: num(m.positiveRate), optOutRate: num(m.optOutRate),
    recommendation: (str(m.recommendation, 'No Data') as MarketPerformance['recommendation']),
  }))
}

// ── loadAgentPerformance ───────────────────────────────────────────────────────

export const loadAgentPerformance = async (filters: KpiFilters): Promise<AgentPerformance[]> => {
  const p = await fetchWarRoom(filters)
  if (!p?.agent_leaderboard) return []
  return p.agent_leaderboard.map((a): AgentPerformance => {
    const agent = str(a.agent, 'Unknown')
    const replyRate = num(a.replyRate), positiveRate = num(a.positiveRate), optOutRate = num(a.optOutRate)
    const badges: string[] = []
    if (replyRate > 8) badges.push('#1 Reply Rate')
    if (positiveRate > 30) badges.push('#1 Positive')
    if (optOutRate < 0.5 && num(a.sent) > 20) badges.push('Lowest Opt-Out')
    return {
      agentId: agent, agentName: agent,
      sent: num(a.sent), delivered: num(a.delivered), replied: num(a.replied),
      positive: num(a.positive), optOut: num(a.optOut),
      replyRate, positiveRate, optOutRate,
      bestMarket: str(a.bestMarket, '—'), bestTemplate: str(a.bestTemplate, '—'),
      activeConversations: 0, contractsInfluenced: 0, badges,
    }
  })
}

// ── loadTemplatePerformance (SMS) ──────────────────────────────────────────────

export const loadTemplatePerformance = async (filters: KpiFilters): Promise<TemplatePerformance[]> => {
  const p = await fetchWarRoom(filters)
  if (!p?.sms_template_leaderboard) return []
  return p.sms_template_leaderboard.map((t): TemplatePerformance => {
    const optOutRate = num(t.optOutRate)
    const flags: string[] = []
    if (optOutRate > 2) flags.push('High Opt-Out')
    if (num(t.sent) < 10) flags.push('Low Data')
    if (num(t.replyRate) > 8) flags.push('Strong Performer')
    if (num(t.positiveRate) > 30) flags.push('Top Converter')
    const preview = str(t.preview) || str(t.name) || str(t.templateId)
    return {
      templateId: str(t.templateId),
      name: str(t.name) || undefined,
      agentPersona: str(t.agentPersona) || undefined,
      stage: str(t.stage) || undefined,
      topMarket: str(t.topMarket) || undefined,
      preview,
      language: str(t.language, 'en'),
      useCase: str(t.useCase, '—'),
      sent: num(t.sent), delivered: num(t.delivered), replied: num(t.replied),
      positive: num(t.positive), optOut: num(t.optOut),
      wrongNumber: num(t.wrongNumber), deliveryFailed: Math.max(0, num(t.sent) - num(t.delivered)),
      replyRate: num(t.replyRate), positiveRate: num(t.positiveRate),
      stopRate: optOutRate, deliveryRate: num(t.deliveryRate),
      recommendation: (str(t.recommendation, 'Needs Data') as TemplatePerformance['recommendation']),
      flags, trafficWeight: null,
    }
  })
}

// ── loadChannelPerformance (SMS real, Email honest-empty) ───────────────────────

export const loadChannelPerformance = async (filters: KpiFilters): Promise<ChannelPerformance[]> => {
  const emptyEmail: ChannelPerformance = {
    channel: 'email', sent: 0, delivered: 0, replied: 0, positive: 0, optOut: 0, bounced: 0,
    spend: 0, costPerReply: null, costPerPositive: null, deliveryRate: 0, replyRate: 0, positiveRate: 0, isWired: false,
  }
  const p = await fetchWarRoom(filters)
  if (!p?.kpis) return [{ ...emptyEmail, channel: 'sms', isWired: false }, emptyEmail]
  const k = p.kpis
  const sms: ChannelPerformance = {
    channel: 'sms', sent: k.sentCount, delivered: k.deliveredCount, replied: k.repliedCount,
    positive: k.positiveReplies, optOut: k.optOutCount, bounced: k.failedCount,
    spend: k.spendPeriod, costPerReply: k.costPerReply, costPerPositive: k.costPerPositive,
    deliveryRate: k.deliveryRate, replyRate: k.replyRate, positiveRate: k.positiveRate, isWired: true,
  }
  return [sms, { ...emptyEmail, isWired: Boolean(p.email_health?.wired) }]
}

// ── loadSpendPerformance ───────────────────────────────────────────────────────

const REVENUE_ASSUMPTIONS = {
  conservative: { contracts: 1, avgRevenue: 18000 },
  base: { contracts: 4, avgRevenue: 25000 },
  aggressive: { contracts: 10, avgRevenue: 35000 },
}

export const loadSpendPerformance = async (filters: KpiFilters, preloadedSummary?: KpiSummary): Promise<SpendPerformance> => {
  const summary = preloadedSummary ?? await loadKpiDashboardSummary(filters)
  const spend = summary.spendPeriod
  return {
    periodLabel: filters.timeRange,
    smsSend: spend, emailSend: 0, dataAcquisition: 0, totalSpend: spend,
    costPerSent: summary.sentCount > 0 ? Math.round((spend / summary.sentCount) * 10000) / 10000 : null,
    costPerDelivered: summary.deliveredCount > 0 ? Math.round((spend / summary.deliveredCount) * 10000) / 10000 : null,
    costPerReply: summary.costPerReply,
    costPerPositive: summary.costPerPositive,
    costPerOffer: null,
    costPerContract: null,
    projectedROI: null,
    conservative: { ...REVENUE_ASSUMPTIONS.conservative, totalRevenue: REVENUE_ASSUMPTIONS.conservative.contracts * REVENUE_ASSUMPTIONS.conservative.avgRevenue },
    base: { ...REVENUE_ASSUMPTIONS.base, totalRevenue: REVENUE_ASSUMPTIONS.base.contracts * REVENUE_ASSUMPTIONS.base.avgRevenue },
    aggressive: { ...REVENUE_ASSUMPTIONS.aggressive, totalRevenue: REVENUE_ASSUMPTIONS.aggressive.contracts * REVENUE_ASSUMPTIONS.aggressive.avgRevenue },
  }
}

export const loadRevenueForecast = async (_filters: KpiFilters): Promise<[]> => []

// ── loadFunnelPerformance ──────────────────────────────────────────────────────

export const loadFunnelPerformance = async (filters: KpiFilters): Promise<FunnelStage[]> => {
  const p = await fetchWarRoom(filters)
  if (!p?.funnel) return []
  return p.funnel.map((s): FunnelStage => ({
    id: s.id, label: s.label, count: num(s.count), prevCount: num(s.prevCount),
    conversionRate: s.conversionRate == null ? null : num(s.conversionRate),
    dropOffRate: s.dropOffRate == null ? null : num(s.dropOffRate),
    trend: s.trend ?? 'neutral', isEstimate: Boolean(s.isEstimate),
  }))
}

// ── loadDataQualityMetrics ─────────────────────────────────────────────────────

export const loadDataQualityMetrics = async (filters: KpiFilters): Promise<DataQualityMetrics> => {
  const empty: DataQualityMetrics = {
    missingPhone: 0, missingEmail: 0, missingOwnerName: 0, missingZip: 0,
    invalidPhone: 0, dncCount: 0, wrongNumber: 0, duplicate: 0,
    routingBlocked: 0, noSenderCoverage: 0, failedQueueRows: 0, blankBody: 0,
    deliveryLag: null, queueLatency: null, autoReplyBlocked: 0, manualReviewCount: 0,
    healthScore: 0,
  }
  const p = await fetchWarRoom(filters)
  const d = p?.data_automation_health
  if (!d) return empty
  return {
    ...empty,
    failedQueueRows: num(d.failedQueueRows),
    blankBody: num(d.blankBodyRows),
    routingBlocked: num(d.routingBlocked),
    healthScore: num(p?.kpis?.dataQualityScore),
  }
}

// ── loadBuyerDemandMetrics ─────────────────────────────────────────────────────

export const loadBuyerDemandMetrics = async (filters: KpiFilters): Promise<BuyerDemandMetrics> => {
  const p = await fetchWarRoom(filters)
  const b = p?.buyer_demand
  return {
    totalMatches: num(b?.totalMatches), topMarkets: [], avgConfidence: num(b?.avgConfidence),
    buyerResponseRate: null, assignedCount: 0, isWired: Boolean(b?.wired),
  }
}

// ── loadOfferContractMetrics (not wired) ───────────────────────────────────────

export const loadOfferContractMetrics = async (_filters: KpiFilters): Promise<OfferContractMetrics> => ({
  offersCreated: 0, offersSent: 0, offersAccepted: 0, offersRejected: 0,
  contractsGenerated: 0, contractsSent: 0, sellerSigned: 0, fullyExecuted: 0,
  sentToTitle: 0, closed: 0, cancelled: 0,
  offerConversionRate: null, contractConversionRate: null,
  avgSpread: null, projectedRevenue: null, isWired: false,
})

// ── loadTextgridNumberHealth ───────────────────────────────────────────────────

export const calculateNumberHealthScore = (m: {
  deliveryRate: number; optOutRate: number; failureRate: number; blacklistEvents: number; dailyCapUsedPct: number
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
  const p = await fetchWarRoom(filters)
  const nums = p?.textgrid_numbers_health?.numbers
  if (!nums?.length) return []
  return nums.map((n): TextgridNumberHealth => {
    const sent = num(n.sent)
    const deliveryRate = num(n.deliveryRate)
    const failureRate = sent > 0 ? Math.round((num(n.failed) / sent) * 1000) / 10 : 0
    const optOutRate = num(n.optOutRate)
    const healthScore = calculateNumberHealthScore({ deliveryRate, optOutRate, failureRate, blacklistEvents: 0, dailyCapUsedPct: 0 })
    const recommendation: TextgridNumberHealth['recommendation'] =
      sent === 0 ? 'Add More' :
      healthScore < 40 ? 'Replace' :
      healthScore < 60 ? 'Pause' :
      optOutRate >= 3 ? 'Throttle' :
      healthScore < 75 ? 'Watch' : 'Healthy'
    return {
      numberId: str(n.numberId), phoneNumber: str(n.phoneNumber),
      friendlyName: str(n.friendlyName, str(n.phoneNumber)),
      market: str(n.market, '—'), state: str(n.state, '—'), isActive: n.isActive !== false,
      sentToday: sent, sentLast7: 0, sentLast30: 0,
      delivered: num(n.delivered), deliveryRate, failed: num(n.failed), failureRate,
      replies: num(n.replies), replyRate: num(n.replyRate), positiveRate: num(n.positiveRate),
      positiveReplies: 0, optOuts: num(n.optOuts), optOutRate,
      wrongNumbers: 0, blacklistEvents: 0, dailyCapUsedPct: 0, healthScore, recommendation,
    }
  })
}

// ── loadCarrierPerformance ─────────────────────────────────────────────────────

export const loadCarrierPerformance = async (filters: KpiFilters): Promise<CarrierPerformance[]> => {
  const p = await fetchWarRoom(filters)
  const carriers = p?.carrier_intelligence
  if (!carriers?.length) return []
  return carriers.map((c): CarrierPerformance => ({
    carrier: str(c.carrier, 'Unknown'), lineType: str(c.lineType, 'unknown'),
    sent: num(c.sent), delivered: num(c.delivered), deliveryRate: num(c.deliveryRate),
    replied: num(c.replied), replyRate: num(c.replyRate),
    positive: num(c.positive), optOut: num(c.optOut), optOutRate: num(c.optOutRate),
    failed: num(c.failed), avgLatencyMs: null, topFailureReason: null, isWired: true,
  }))
}

export const loadNumberCarrierMatrix = async (_filters: KpiFilters): Promise<NumberCarrierMatrix> =>
  ({ carriers: [], markets: [], cells: {} })

export const loadNumberHealthAlerts = async (filters: KpiFilters): Promise<NumberHealthAlert[]> => {
  const numbers = await loadTextgridNumberHealth(filters)
  const alerts: NumberHealthAlert[] = []
  for (const n of numbers) {
    if (n.optOutRate > 2 && n.sentToday > 20) {
      alerts.push({ severity: 'warning', type: 'high_opt_out', message: `${n.phoneNumber}: ${n.optOutRate}% opt-out rate — review template targeting`, affectedNumber: n.phoneNumber, affectedMarket: n.market })
    }
  }
  return alerts
}

// ── loadKpiAlerts (real, server-derived) ───────────────────────────────────────

export interface KpiAlertsInput {
  states?: StatePerformance[]
  templates?: TemplatePerformance[]
  numbers?: TextgridNumberHealth[]
  quality?: DataQualityMetrics
}

export const loadKpiAlerts = async (filters: KpiFilters, _prefetched?: KpiAlertsInput): Promise<KpiAlert[]> => {
  const p = await fetchWarRoom(filters)
  if (!p?.alerts?.length) {
    return [{ id: '0', severity: 'info', category: 'System', message: 'No active alerts — system operating normally.' }]
  }
  return p.alerts.map((a): KpiAlert => ({
    id: a.id, severity: a.severity, category: a.category, message: a.message,
    affectedEntity: a.affectedEntity, suggestedAction: a.suggestedAction,
  }))
}
