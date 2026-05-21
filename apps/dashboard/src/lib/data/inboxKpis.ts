import { getSupabaseClient } from '../supabaseClient'
import { asNumber } from './shared'

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
  lastUpdated: string
}

type OperationalVolumeTone = OperationalKpis['volume'][number]['tone']

const POSITIVE_INTENTS = ['seller_interested', 'asking_price_provided', 'asks_offer', 'ownership_confirmed', 'price_anchor']
const NEGATIVE_INTENTS = ['negative', 'not_interested', 'opt_out', 'wrong_number', 'hostile', 'hostile_or_legal']

export const fetchOperationalKpis = async (timeWindow: OperationalKpi['timeWindow'] = '24h'): Promise<OperationalKpis> => {
  const supabase = getSupabaseClient()
  const now = new Date()
  const startDate = new Date()
  const prevStartDate = new Date()
  
  if (timeWindow === 'today') {
    startDate.setHours(0, 0, 0, 0)
    prevStartDate.setDate(startDate.getDate() - 1)
    prevStartDate.setHours(0, 0, 0, 0)
  } else if (timeWindow === '24h') {
    startDate.setHours(now.getHours() - 24)
    prevStartDate.setHours(startDate.getHours() - 24)
  } else if (timeWindow === '7d') {
    startDate.setDate(now.getDate() - 7)
    prevStartDate.setDate(startDate.getDate() - 7)
  } else if (timeWindow === '30d') {
    startDate.setDate(now.getDate() - 30)
    prevStartDate.setDate(startDate.getDate() - 30)
  }

  const startIso = startDate.toISOString()
  const prevStartIso = prevStartDate.toISOString()

  try {
    // 1. Messaging Performance (Current & Previous)
    const { data: currentMsgs } = await supabase
      .from('message_events')
      .select('direction, delivery_status, detected_intent, is_opt_out, is_final_failure')
      .gte('created_at', startIso)

    const { data: prevMsgs } = await supabase
      .from('message_events')
      .select('direction, delivery_status, detected_intent, is_opt_out, is_final_failure')
      .gte('created_at', prevStartIso)
      .lt('created_at', startIso)

    const calcMsgKpis = (data: { direction: string; delivery_status?: string; detected_intent?: string; is_opt_out?: boolean; is_final_failure?: boolean; }[] | null) => {
      if (!data) return { sent: 0, delivered: 0, failedCount: 0, received: 0, replyRate: 0, posRate: 0, negativeRate: 0, optOutRate: 0, deliveryRate: 0, failRate: 0 }
      const inbound = data.filter(m => m.direction === 'inbound')
      const outbound = data.filter(m => m.direction === 'outbound')
      const delivered = outbound.filter(m => m.delivery_status === 'delivered')
      const failed = outbound.filter(m => m.delivery_status === 'failed' || m.is_final_failure)
      const positive = inbound.filter(m => POSITIVE_INTENTS.includes(String(m.detected_intent)))
      const negative = inbound.filter(m => NEGATIVE_INTENTS.includes(String(m.detected_intent)))
      const optOuts = data.filter(m => m.is_opt_out || String(m.detected_intent) === 'opt_out')

      return {
        sent: outbound.length,
        delivered: delivered.length,
        failedCount: failed.length,
        received: inbound.length,
        replyRate: delivered.length > 0 ? (inbound.length / delivered.length) * 100 : 0,
        posRate: inbound.length > 0 ? (positive.length / inbound.length) * 100 : 0,
        negativeRate: inbound.length > 0 ? (negative.length / inbound.length) * 100 : 0,
        optOutRate: delivered.length > 0 ? (optOuts.length / delivered.length) * 100 : 0,
        deliveryRate: outbound.length > 0 ? (delivered.length / outbound.length) * 100 : 0,
        failRate: outbound.length > 0 ? (failed.length / outbound.length) * 100 : 0
      }
    }

    const currMsg = calcMsgKpis(currentMsgs)
    const prevMsg = calcMsgKpis(prevMsgs)

    const getTrend = (curr: number, prev: number): OperationalKpi['trend'] => {
      if (curr > prev) return 'up'
      if (curr < prev) return 'down'
      return 'neutral'
    }

    const messaging: OperationalKpi[] = [
      { id: 'reply-rate', label: 'Reply Rate', value: currMsg.replyRate.toFixed(1), unit: '%', description: 'Delivered outbound to inbound replies', category: 'messaging', timeWindow, isAvailable: true, trend: getTrend(currMsg.replyRate, prevMsg.replyRate), status: currMsg.replyRate > 15 ? 'good' : 'warning' },
      { id: 'pos-reply-rate', label: 'Positive Rate', value: currMsg.posRate.toFixed(1), unit: '%', description: 'Interested replies from inbound flow', category: 'messaging', timeWindow, isAvailable: true, trend: getTrend(currMsg.posRate, prevMsg.posRate), status: currMsg.posRate > 10 ? 'good' : 'neutral' },
      { id: 'negative-rate', label: 'Negative Rate', value: currMsg.negativeRate.toFixed(1), unit: '%', description: 'Negative or blocking replies from inbound flow', category: 'messaging', timeWindow, isAvailable: true, trend: getTrend(prevMsg.negativeRate, currMsg.negativeRate), status: currMsg.negativeRate < 8 ? 'good' : currMsg.negativeRate < 18 ? 'warning' : 'critical' },
      { id: 'delivery-rate', label: 'Delivery Rate', value: currMsg.deliveryRate.toFixed(1), unit: '%', description: 'Outbound messages reaching carrier delivery', category: 'messaging', timeWindow, isAvailable: true, trend: getTrend(currMsg.deliveryRate, prevMsg.deliveryRate), status: currMsg.deliveryRate > 95 ? 'good' : 'critical' },
      { id: 'failure-rate', label: 'Failure Rate', value: currMsg.failRate.toFixed(1), unit: '%', description: 'Outbound sends ending in final failure', category: 'messaging', timeWindow, isAvailable: true, trend: getTrend(prevMsg.failRate, currMsg.failRate), status: currMsg.failRate < 5 ? 'good' : 'critical' },
      { id: 'opt-out-rate', label: 'Opt-Out Rate', value: currMsg.optOutRate.toFixed(1), unit: '%', description: 'Stops and opt-outs across delivered sends', category: 'messaging', timeWindow, isAvailable: true, trend: getTrend(prevMsg.optOutRate, currMsg.optOutRate), status: currMsg.optOutRate < 3 ? 'good' : 'warning' }
    ]

    const volume: Array<{ id: string; label: string; value: number; tone: OperationalVolumeTone }> = [
      { id: 'sent', label: 'Sent', value: currMsg.sent, tone: currMsg.sent > 0 ? 'neutral' : 'warning' },
      { id: 'delivered', label: 'Delivered', value: currMsg.delivered, tone: currMsg.deliveryRate > 95 ? 'good' : currMsg.delivered > 0 ? 'warning' : 'critical' },
      { id: 'failed', label: 'Failed', value: currMsg.failedCount, tone: currMsg.failedCount === 0 ? 'good' : currMsg.failedCount < 5 ? 'warning' : 'critical' },
      { id: 'received', label: 'Received', value: currMsg.received, tone: currMsg.received > 0 ? 'good' : 'neutral' },
    ]

    // 2. Automation Health
    const { data: queueData } = await supabase
      .from('send_queue')
      .select('queue_status')
      .gte('created_at', startIso)

    const pending = queueData?.filter(q => ['pending', 'queued', 'scheduled'].includes(q.queue_status)).length || 0
    const failedQueue = queueData?.filter(q => q.queue_status === 'failed').length || 0
    
    const automation: OperationalKpi[] = [
      { id: 'queue-pending', label: 'In Queue', value: pending, description: 'Queued, scheduled, or waiting sends', category: 'automation', timeWindow, isAvailable: true, status: pending > 50 ? 'warning' : 'good' },
      { id: 'queue-failed', label: 'Queue Failures', value: failedQueue, description: 'Automation items that hard failed', category: 'automation', timeWindow, isAvailable: true, status: failedQueue > 0 ? 'critical' : 'good' }
    ]

    // 3. Quality & Pipeline (from Command Center View)
    const { data: pipelineData } = await supabase
      .from('inbox_command_center_v')
      .select('is_hot_lead, final_acquisition_score, cash_offer, estimated_value')
      .not('is_archived', 'eq', true)

    const hotLeads = pipelineData?.filter(p => p.is_hot_lead).length || 0
    const underwrites = pipelineData?.filter(p => asNumber(p.final_acquisition_score, 0) > 0).length || 0
    const offersReady = pipelineData?.filter(p => asNumber(p.cash_offer, 0) > 0).length || 0
    
    const quality: OperationalKpi[] = [
      { id: 'hot-leads', label: 'Hot Leads', value: hotLeads, description: 'Threads flagged with high intent', category: 'quality', timeWindow, isAvailable: true, status: hotLeads > 5 ? 'good' : 'neutral' },
      { id: 'avg-acq-score', label: 'Avg Acq Score', value: (pipelineData && pipelineData.length > 0 ? (pipelineData.reduce((sum, p) => sum + asNumber(p.final_acquisition_score, 0), 0) / pipelineData.length).toFixed(1) : '0'), description: 'Mean acquisition score across inbox', category: 'quality', timeWindow, isAvailable: true, status: pipelineData && pipelineData.length > 0 ? 'neutral' : 'warning' }
    ]

    const pipeline: OperationalKpi[] = [
      { id: 'underwrites', label: 'Total Underwrites', value: underwrites, description: 'Threads with a scoring pass complete', category: 'pipeline', timeWindow, isAvailable: true, status: underwrites > 0 ? 'good' : 'neutral' },
      { id: 'offers-ready', label: 'Offers Ready', value: offersReady, description: 'Leads with cash offers staged', category: 'pipeline', timeWindow, isAvailable: true, status: offersReady > 0 ? 'good' : 'neutral' }
    ]

    // 4. Financial
    const activeOffers = pipelineData?.filter(p => asNumber(p.cash_offer, 0) > 0) || []
    const avgArv = activeOffers.length > 0 ? activeOffers.reduce((sum, p) => sum + asNumber(p.estimated_value, 0), 0) / activeOffers.length : 0
    const avgOffer = activeOffers.length > 0 ? activeOffers.reduce((sum, p) => sum + asNumber(p.cash_offer, 0), 0) / activeOffers.length : 0

    const financial: OperationalKpi[] = [
      { id: 'avg-arv', label: 'Avg ARV', value: Math.round(avgArv).toLocaleString(), unit: '$', description: 'Average estimated after-repair value', category: 'financial', timeWindow, isAvailable: true, status: avgArv > 0 ? 'good' : 'neutral' },
      { id: 'avg-offer', label: 'Avg Offer', value: Math.round(avgOffer).toLocaleString(), unit: '$', description: 'Average active offer amount', category: 'financial', timeWindow, isAvailable: true, status: avgOffer > 0 ? 'good' : 'neutral' }
    ]

    return {
      messaging,
      quality,
      automation,
      pipeline,
      financial,
      volume,
      lastUpdated: new Date().toISOString()
    }
  } catch (err) {
    console.error('[KPI] Unexpected error:', err)
    return {
      messaging: [],
      quality: [],
      automation: [],
      pipeline: [],
      financial: [],
      volume: [],
      lastUpdated: new Date().toISOString()
    }
  }
}
