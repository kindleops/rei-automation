import { getCockpitOpsMetrics, type CockpitOpsSections, type OpsMessageTypeSection, type OpsQueueHealthSection } from '../api/backendClient'

export type { OpsMessageTypeSection, OpsQueueHealthSection }

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
  sections: CockpitOpsSections | null
  lastUpdated: string
}

type OperationalVolumeTone = OperationalKpis['volume'][number]['tone']

export const fetchOperationalKpis = async (timeWindow: OperationalKpi['timeWindow'] = '24h'): Promise<OperationalKpis> => {
  try {
    const metricsRes = await getCockpitOpsMetrics(timeWindow)
    if (!metricsRes.ok) {
      throw new Error(metricsRes.message || metricsRes.error || 'ops_metrics_unavailable')
    }
    const metrics = metricsRes.data?.diagnostics
    if (!metrics) throw new Error('ops_metrics_missing_diagnostics')

    const getTrend = (curr: number, prev: number): OperationalKpi['trend'] => {
      if (curr > prev) return 'up'
      if (curr < prev) return 'down'
      return 'neutral'
    }
    const prevBaseline = 0

    const messaging: OperationalKpi[] = [
      { id: 'reply-rate', label: 'Reply Rate', value: metrics.reply_rate.toFixed(1), unit: '%', description: 'Inbound replies / delivered outbound', category: 'messaging', timeWindow, isAvailable: true, trend: getTrend(metrics.reply_rate, prevBaseline), status: metrics.reply_rate > 15 ? 'good' : 'warning' },
      { id: 'pos-reply-rate', label: 'Positive Rate', value: metrics.positive_rate.toFixed(1), unit: '%', description: 'Interested replies from inbound flow', category: 'messaging', timeWindow, isAvailable: true, trend: getTrend(metrics.positive_rate, prevBaseline), status: metrics.positive_rate > 10 ? 'good' : 'neutral' },
      { id: 'negative-rate', label: 'Negative Rate', value: metrics.negative_rate.toFixed(1), unit: '%', description: 'Negative or blocking replies from inbound flow', category: 'messaging', timeWindow, isAvailable: true, trend: getTrend(prevBaseline, metrics.negative_rate), status: metrics.negative_rate < 8 ? 'good' : metrics.negative_rate < 18 ? 'warning' : 'critical' },
      { id: 'delivery-rate', label: 'Delivery Rate', value: metrics.delivery_rate.toFixed(1), unit: '%', description: 'Carrier-delivered / accepted outbound', category: 'messaging', timeWindow, isAvailable: true, trend: getTrend(metrics.delivery_rate, prevBaseline), status: metrics.delivery_rate > 95 ? 'good' : 'critical' },
      { id: 'failure-rate', label: 'Failure Rate', value: metrics.failure_rate.toFixed(1), unit: '%', description: 'Final provider/carrier failures', category: 'messaging', timeWindow, isAvailable: true, trend: getTrend(prevBaseline, metrics.failure_rate), status: metrics.failure_rate < 5 ? 'good' : 'critical' },
      { id: 'opt-out-rate', label: 'Opt-Out Rate', value: metrics.opt_out_rate.toFixed(1), unit: '%', description: 'Opt-outs across delivered sends', category: 'messaging', timeWindow, isAvailable: true, trend: getTrend(prevBaseline, metrics.opt_out_rate), status: metrics.opt_out_rate < 3 ? 'good' : 'warning' }
    ]

    const volume: Array<{ id: string; label: string; value: number; tone: OperationalVolumeTone }> = [
      { id: 'sent', label: 'Sent', value: metrics.sent_count, tone: metrics.sent_count > 0 ? 'neutral' : 'warning' },
      { id: 'delivered', label: 'Delivered', value: metrics.delivered_count, tone: metrics.delivery_rate > 95 ? 'good' : metrics.delivered_count > 0 ? 'warning' : 'critical' },
      { id: 'failed', label: 'Failed', value: metrics.failed_count, tone: metrics.failed_count === 0 ? 'good' : metrics.failed_count < 5 ? 'warning' : 'critical' },
      { id: 'received', label: 'Received', value: metrics.received_count, tone: metrics.received_count > 0 ? 'good' : 'neutral' },
    ]

    const automation: OperationalKpi[] = [
      { id: 'queue-pending', label: 'In Queue', value: metrics.queue_waiting_count, description: 'Queued, pending, or scheduled sends', category: 'automation', timeWindow, isAvailable: true, status: metrics.queue_waiting_count > 50 ? 'warning' : 'good' },
      { id: 'queue-failed', label: 'Queue Failures', value: metrics.queue_failed_today_count, description: 'Failed send_queue rows (ops failures)', category: 'automation', timeWindow, isAvailable: true, status: metrics.queue_failed_today_count > 0 ? 'critical' : 'good' }
    ]

    const noVerifiedData = metrics.metric_source_debug?.message_rows === 0
    const quality: OperationalKpi[] = [
      { id: 'hot-leads', label: 'Hot Leads', value: noVerifiedData ? 'No verified data yet' : 0, description: 'Threads flagged with high intent', category: 'quality', timeWindow, isAvailable: !noVerifiedData, status: 'neutral' },
      { id: 'avg-acq-score', label: 'Avg Acq Score', value: noVerifiedData ? 'No verified data yet' : '0', description: 'Mean acquisition score across inbox', category: 'quality', timeWindow, isAvailable: !noVerifiedData, status: 'neutral' }
    ]

    const pipeline: OperationalKpi[] = [
      { id: 'underwrites', label: 'Total Underwrites', value: 'No verified data yet', description: 'Awaiting verified underwriting source rows', category: 'pipeline', timeWindow, isAvailable: false, status: 'neutral' },
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
      sections: metrics.sections ?? null,
      lastUpdated: new Date().toISOString()
    }
  } catch (err) {
    console.error('[KPI] Unexpected error:', err)
    throw err // Rethrow so the hook can catch it
  }
}
