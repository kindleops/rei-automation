/**
 * ANALYTICS — client for /api/cockpit/analytics/performance.
 *
 * The server declares every metric's contract and computes every number,
 * comparison and "what changed" rule; this client never aggregates. It only
 * sends the operator's local midnight / Jan 1 so "Today" and "YTD" mean the
 * operator's day, not the server's.
 */
import { callBackend } from '../../lib/api/backendClient'

export type RangeKey = 'today' | '7d' | '30d' | '90d' | 'ytd'
export const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: 'today', label: 'Today' }, { key: '7d', label: '7D' }, { key: '30d', label: '30D' }, { key: '90d', label: '90D' }, { key: 'ytd', label: 'YTD' },
]

export type MetricContract = { label: string; unit: string; kind: 'event' | 'rate' | 'state'; grain: string; definition: string; source: string; good: 'up' | 'down' | 'neutral'; numerator?: string; denominator?: string }
export type CountCompare = { cur: number; prev: number; delta: number; pct: number | null; basis: 'percent' | 'absolute' }
export type RateCompare = { cur: number | null; prev: number | null; pp: number | null; sample: { cur: number; prev: number }; reliable: boolean }
export type Totals = Record<string, number | null>

export type Change = { key: string; kind: 'count' | 'rate' | 'market'; label: string; delta?: number; pct?: number | null; pp?: number; cur: number | null; prev: number | null; tone: 'good' | 'bad' | 'neutral'; market?: string }

export type Stage = {
  code: string; index: number; label: string; entered: number; exited: number; advanced: number
  medianHoursInStage: number | null; dwellSample: number; active: number; live: number; dormant: number
  medianAgeDays: number | null; stalled: number; stallThresholdDays: number | null; stalledIds: string[]; enteredIds: string[]
}

export type MarketRow = {
  id: string; name: string; state: string; lat: number | null; lng: number | null
  cur: Record<string, number>; prev: Record<string, number>
  replyRate: number | null; prevReplyRate: number | null; optOutRate: number | null
  activeOpportunities: number; dormantOpportunities: number
}

export type CampaignRow = {
  id: string; name: string; status: string | null; market: string | null; test: boolean
  sends: number; delivered: number; failed: number; reached: number; replied: number; positive: number; optOuts: number
  replyRate: number | null; opportunities: number; reachedAskingPrice: number; reachedOffer: number
}

export type Place = { address: string | null; market: string | null; lat: number | null; lng: number | null }

export type AnalyticsPerformance = {
  generatedAt: string
  queryMs: number
  period: { range: string; start: string; end: string; prevStart: string; prevEnd: string; days: number; bucket: 'hour' | 'day' | 'week' }
  scope: { market: string | null; marketName: string | null }
  metrics: Record<string, MetricContract>
  totals: { cur: Totals; prev: Totals }
  priorHasData: boolean
  rates: { reply_rate: RateCompare; delivery_rate: RateCompare; opt_out_rate: RateCompare; positive_share: RateCompare }
  compare: Record<string, CountCompare>
  latency: { medianMinutes: number | null; sample: number }
  series: Array<{ at: string; delivered: number; failed: number; replied: number; optOuts: number; advancements: number }>
  changes: Change[]
  story: { range: string; lines: Array<{ k: string; value: number; text: string }>; notes: string[] }
  flow: {
    created: number; advancements: number; bySource: Record<string, number>; stages: Stage[]
    groups: Array<{ key: string; label: string; active: number }>
    bottleneck: { code: string; label: string; live: number; stalled: number; medianAgeDays: number | null; thresholdDays: number | null; ids: string[] } | null
  }
  campaigns: CampaignRow[]
  markets: MarketRow[]
  zips: Array<{ zip: string; market: string | null; lat: number | null; lng: number | null; delivered: number; replied: number; failed: number; buyerPurchases: number }>
  automation: {
    runs: number; succeeded: number; heldByGate: number; needsReview: number; policyBlocks: number; failed: number
    decisions: number; escalated: number; blockReasons: Record<string, number>; decisionActions: Record<string, number>
    sendsAutomated: number; sendsOperator: number; sendsUnattributed: number
  }
  operations: { failed: number; failedTransport: number; healthGuardBlocks: number; contentBlocks: number; expired: number; cancelled: number; medianSendDelayMin: number | null; backlogPending: number; backlogOldest: string | null }
  deals: { offers: Array<Record<string, unknown> & Place>; closings: Array<Record<string, unknown> & Place> }
  disposition: Record<string, number | null>
  buyers: { purchases: number; entities: number; repeatPurchases: number; dataThrough: string | null }
  cohorts: {
    replies: Array<{ threadKey: string; at: string; intent: string | null; optOut: boolean; positive: boolean; propertyId: string | null } & Place>
    transitions: Array<{ opportunityId: string; type: string; from: string | null; to: string | null; at: string; source: string; reason: string; propertyId: string | null } & Place>
    stalled: Array<{ opportunityId: string; stage: string; stageEnteredAt: string | null; propertyId: string | null } & Place>
  }
  unresolved: Record<string, number>
  lineage: Record<string, string>
}

function localStart(range: RangeKey): string | null {
  const d = new Date()
  if (range === 'today') { d.setHours(0, 0, 0, 0); return d.toISOString() }
  if (range === 'ytd') { return new Date(d.getFullYear(), 0, 1).toISOString() }
  return null
}

export async function fetchAnalyticsPerformance(params: { range: RangeKey; market?: string | null }, signal?: AbortSignal): Promise<AnalyticsPerformance> {
  const qs = new URLSearchParams({ range: params.range })
  const start = localStart(params.range)
  if (start) qs.set('start', start)
  if (params.market) qs.set('market', params.market)
  const res = await callBackend<{ ok: boolean; data: AnalyticsPerformance }>(`/api/cockpit/analytics/performance?${qs.toString()}`, { signal, timeoutMs: 45_000 })
  if (!res.ok) {
    const upstream = (res as { upstream?: { error?: string } }).upstream
    throw new Error(upstream?.error || res.error || 'analytics_failed')
  }
  if (!res.data?.data) throw new Error('analytics_empty')
  return res.data.data
}

/* ── formatting: tabular, compact, explicit units ── */
export const fmtInt = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : n >= 10_000 ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n) : Math.round(n).toLocaleString('en-US'))
export const fmtPct = (r: number | null | undefined, digits = 1) => (r === null || r === undefined || !Number.isFinite(r) ? '—' : `${(r * 100).toFixed(digits)}%`)
export const fmtPctPts = (p: number | null | undefined) => (p === null || p === undefined ? null : `${p > 0 ? '+' : ''}${p.toFixed(1)} pts`)
export const fmtDelta = (c: CountCompare | undefined) => {
  if (!c) return null
  if (c.basis === 'percent' && c.pct !== null) return `${c.pct > 0 ? '+' : ''}${c.pct.toFixed(Math.abs(c.pct) >= 100 ? 0 : 1)}%`
  return `${c.delta > 0 ? '+' : ''}${c.delta}`
}
export const fmtDuration = (hours: number | null | undefined) => {
  if (hours === null || hours === undefined) return '—'
  if (hours < 1) return `${Math.round(hours * 60)}m`
  if (hours < 48) return `${Math.floor(hours)}h ${Math.round((hours % 1) * 60)}m`
  return `${(hours / 24).toFixed(1)} days`
}
export const fmtMinutes = (m: number | null | undefined) => (m === null || m === undefined ? '—' : fmtDuration(m / 60))
