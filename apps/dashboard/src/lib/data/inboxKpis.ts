import { getCockpitOpsMetrics } from '../api/backendClient'

export interface OperationalKpi {
  id: string
  label: string
  value: string | number
  unit?: string
  trend?: 'up' | 'down' | 'neutral'
  status?: 'good' | 'warning' | 'critical' | 'neutral'
  description?: string
  category: 'messaging' | 'quality' | 'automation' | 'pipeline' | 'financial'
  timeWindow: 'today' | '24h' | '7d' | '30d'
  isAvailable: boolean
}

export interface OperationalKpis {
  messaging: OperationalKpi[]
  quality: OperationalKpi[]
  automation: OperationalKpi[]
  pipeline: OperationalKpi[]
  financial: OperationalKpi[]
  volume: Array<{
    id: string
    label: string
    value: number
    tone: 'good' | 'warning' | 'critical' | 'neutral'
  }>
  diagnostics?: any
  lastUpdated: string
}

type OperationalVolumeTone = OperationalKpis['volume'][number]['tone']

export const buildOperationalKpis = (metrics: any, timeWindow: OperationalKpi['timeWindow']): OperationalKpis => {
  const getTrend = (curr: number, prev: number): OperationalKpi['trend'] => {
    if (curr > prev) return 'up'
    if (curr < prev) return 'down'
    return 'neutral'
  }
  const prevBaseline = 0

  const formatNumber = (value: number | undefined | null, digits = 1): string => {
    const n = Number(value)
    return Number.isFinite(n) ? n.toFixed(digits) : "0.0"
  }

  // Recalculate rates securely
  const sent = metrics.sent_count || 0
  const delivered = metrics.delivered_count || 0
  const replies = metrics.received_count || 0
  
  const delivery_rate = sent > 0 ? (delivered / sent) * 100 : 0
  const reply_rate = delivered > 0 ? (replies / delivered) * 100 : 0
  const failure_rate = sent > 0 ? ((metrics.failed_count || 0) / sent) * 100 : 0
  const opt_out_rate = delivered > 0 ? ((metrics.opt_out_count || 0) / delivered) * 100 : 0
  // Note: we can use metrics.positive_rate etc. if present, otherwise default 0
  const positive_rate = metrics.positive_rate || 0
  const negative_rate = metrics.negative_rate || 0

  const messaging: OperationalKpi[] = [
    { id: 'reply-rate', label: 'Reply Rate', value: formatNumber(reply_rate), unit: '%', description: 'Inbound replies / delivered outbound', category: 'messaging', timeWindow, isAvailable: true, trend: getTrend(reply_rate, prevBaseline), status: reply_rate > 15 ? 'good' : 'warning' },
    { id: 'pos-reply-rate', label: 'Positive Rate', value: formatNumber(positive_rate), unit: '%', description: 'Interested replies from inbound flow', category: 'messaging', timeWindow, isAvailable: true, trend: getTrend(positive_rate, prevBaseline), status: positive_rate > 10 ? 'good' : 'neutral' },
    { id: 'negative-rate', label: 'Negative Rate', value: formatNumber(negative_rate), unit: '%', description: 'Negative or blocking replies from inbound flow', category: 'messaging', timeWindow, isAvailable: true, trend: getTrend(prevBaseline, negative_rate), status: negative_rate < 8 ? 'good' : negative_rate < 18 ? 'warning' : 'critical' },
    { id: 'delivery-rate', label: 'Delivery Rate', value: formatNumber(delivery_rate), unit: '%', description: 'Carrier-delivered / accepted outbound', category: 'messaging', timeWindow, isAvailable: true, trend: getTrend(delivery_rate, prevBaseline), status: delivery_rate > 95 ? 'good' : 'critical' },
    { id: 'failure-rate', label: 'Failure Rate', value: formatNumber(failure_rate), unit: '%', description: 'Final provider/carrier failures', category: 'messaging', timeWindow, isAvailable: true, trend: getTrend(prevBaseline, failure_rate), status: failure_rate < 5 ? 'good' : 'critical' },
    { id: 'opt-out-rate', label: 'Opt-Out Rate', value: formatNumber(opt_out_rate), unit: '%', description: 'Opt-outs across delivered sends', category: 'messaging', timeWindow, isAvailable: true, trend: getTrend(prevBaseline, opt_out_rate), status: opt_out_rate < 3 ? 'good' : 'warning' }
  ]

  const volume: Array<{ id: string; label: string; value: number; tone: OperationalVolumeTone }> = [
    { id: 'sent', label: 'Sent', value: sent, tone: sent > 0 ? 'neutral' : 'warning' },
    { id: 'delivered', label: 'Delivered', value: delivered, tone: delivery_rate > 95 ? 'good' : delivered > 0 ? 'warning' : 'critical' },
    { id: 'failed', label: 'Failed', value: metrics.failed_count || 0, tone: (metrics.failed_count || 0) === 0 ? 'good' : (metrics.failed_count || 0) < 5 ? 'warning' : 'critical' },
    { id: 'received', label: 'Received', value: replies, tone: replies > 0 ? 'good' : 'neutral' },
  ]

  const automation: OperationalKpi[] = [
    { id: 'queue-pending', label: 'In Queue', value: metrics.queue_waiting_count || 0, description: 'Queued, pending, or scheduled sends', category: 'automation', timeWindow, isAvailable: true, status: (metrics.queue_waiting_count || 0) > 50 ? 'warning' : 'good' },
    { id: 'queue-failed', label: 'Queue Failures', value: metrics.queue_failed_today_count || 0, description: 'Failed send_queue rows (ops failures)', category: 'automation', timeWindow, isAvailable: true, status: (metrics.queue_failed_today_count || 0) > 0 ? 'critical' : 'good' }
  ]

  const noVerifiedData = sent === 0 && replies === 0
  const quality: OperationalKpi[] = [
    { id: 'hot-leads', label: 'Priority Leads', value: noVerifiedData ? 'No verified data yet' : (metrics.priority_threads || 0), description: 'Threads flagged with high priority or hot intent', category: 'quality', timeWindow, isAvailable: !noVerifiedData, status: (metrics.priority_threads || 0) > 0 ? 'good' : 'neutral' },
    { id: 'suppressed', label: 'Suppressed', value: noVerifiedData ? 'No verified data yet' : (metrics.suppressed_threads || 0), description: 'Threads actively suppressed from outreach', category: 'quality', timeWindow, isAvailable: !noVerifiedData, status: 'neutral' }
  ]

  const pipeline: OperationalKpi[] = [
    { id: 'underwrites', label: 'Total Threads', value: metrics.threads_total || 0, description: 'Total conversations across all inbox states', category: 'pipeline', timeWindow, isAvailable: true, status: 'neutral' },
    { id: 'offers-ready', label: 'Offers Ready', value: 'No verified data yet', description: 'Awaiting verified offer source rows', category: 'pipeline', timeWindow, isAvailable: false, status: 'neutral' }
  ]

  const avgArv = 0
  const avgOffer = 0

  const financial: OperationalKpi[] = [
    { id: 'avg-arv', label: 'Avg ARV', value: Math.round(avgArv).toLocaleString(), unit: '$', description: 'Average estimated after-repair value', category: 'financial', timeWindow, isAvailable: false, status: 'neutral' },
    { id: 'avg-offer', label: 'Avg Offer', value: Math.round(avgOffer).toLocaleString(), unit: '$', description: 'Average active offer amount', category: 'financial', timeWindow, isAvailable: false, status: 'neutral' }
  ]

  return {
    messaging,
    quality,
    automation,
    pipeline,
    financial,
    volume,
    diagnostics: metrics,
    lastUpdated: new Date().toISOString()
  }
}

export const fetchOperationalKpis = async (timeWindow: OperationalKpi['timeWindow'] = '24h'): Promise<OperationalKpis> => {
  try {
    const metricsRes = await getCockpitOpsMetrics(timeWindow)
    if (!metricsRes.ok) {
      throw new Error(metricsRes.message || metricsRes.error || 'ops_metrics_unavailable')
    }
    const metrics = metricsRes.data?.diagnostics
    if (!metrics) throw new Error('ops_metrics_missing_diagnostics')

    return buildOperationalKpis(metrics, timeWindow)
  } catch (err) {
    console.error('[KPI] Unexpected error:', err)
    throw err // Rethrow so the hook can catch it
  }
}
