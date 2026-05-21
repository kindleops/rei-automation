import type { HomeActivityItem, HomeBriefingInsight } from '../../modules/home/home.types'
import { getSupabaseClient } from '../supabaseClient'
import {
  asNumber,
  asString,
  getFirst,
  normalizeStatus,
  safeArray,
  type AnyRecord,
} from './shared'

export interface HomeDashboardSnapshot {
  briefingInsights: HomeBriefingInsight[]
  topMarkets: string[]
  activeMarkets: number
  leadPulses: number
  highPressureZones: number
  aiScanStatus: string
  activities: HomeActivityItem[]
  widgetMetrics: Record<string, string>
}

const asMarket = (row: AnyRecord): string =>
  asString(getFirst(row, ['market', 'market_name', 'market_slug', 'city']), 'Unknown')

const pushActivity = (
  list: HomeActivityItem[],
  activity: Omit<HomeActivityItem, 'id'>,
) => {
  list.push({
    id: `supabase-${activity.kind}-${list.length + 1}`,
    ...activity,
  })
}

export const fetchHomeDashboardSnapshot = async (): Promise<HomeDashboardSnapshot> => {
  const supabase = getSupabaseClient()

  const [queueResult, eventResult, ownerResult, propertyResult, webhookResult] = await Promise.all([
    supabase
      .from('send_queue')
      .select('id,queue_id,queue_status,priority,market,market_id,retry_count,created_at,scheduled_at,sent_at')
      .order('created_at', { ascending: false })
      .limit(800),
    supabase
      .from('message_events')
      .select('id,market,market_id,direction,requires_response,unread,sentiment,created_at,message_body')
      .order('created_at', { ascending: false })
      .limit(800),
    supabase
      .from('master_owners')
      .select('master_owner_id,market,motivation_score,priority_score,updated_at')
      .limit(1000),
    supabase
      .from('properties')
      .select('property_id,market,structured_motivation_score,estimated_value,updated_at')
      .limit(1000),
    supabase
      .from('webhook_logs')
      .select('webhook_id,source,status,error,message,created_at')
      .order('created_at', { ascending: false })
      .limit(120),
  ]).catch(err => {
    console.error('[DashboardData] Promise.all failed:', err)
    return [ {error: err}, {error: null}, {error: null}, {error: null}, {error: null} ] as any[]
  })

  if (queueResult?.error) console.warn('[DashboardData] send_queue error:', queueResult.error.message)
  if (eventResult?.error) console.warn('[DashboardData] message_events error:', eventResult.error.message)
  if (ownerResult?.error) console.warn('[DashboardData] master_owners error:', ownerResult.error.message)
  if (propertyResult?.error) console.warn('[DashboardData] properties error:', propertyResult.error.message)
  if (webhookResult?.error) console.warn('[DashboardData] webhook_logs error:', webhookResult.error.message)

  const queueRows = safeArray(queueResult?.data as AnyRecord[])
  const eventRows = safeArray(eventResult?.data as AnyRecord[])
  const ownerRows = safeArray(ownerResult?.data as AnyRecord[])
  const propertyRows = safeArray(propertyResult?.data as AnyRecord[])
  const webhookRows = safeArray(webhookResult?.data as AnyRecord[])

  const markets = new Map<string, { queue: number; inbound: number; pressure: number }>()
  for (const row of queueRows) {
    const market = asMarket(row)
    const status = normalizeStatus(getFirst(row, ['status', 'queue_status', 'delivery_status']))
    const entry = markets.get(market) ?? { queue: 0, inbound: 0, pressure: 0 }
    entry.queue += 1
    if (status === 'failed' || status === 'retry' || status === 'held') entry.pressure += 1
    markets.set(market, entry)
  }

  const recentEvents = eventRows.slice(0, 200)
  for (const row of recentEvents) {
    const market = asMarket(row)
    const direction = normalizeStatus(getFirst(row, ['direction']))
    const entry = markets.get(market) ?? { queue: 0, inbound: 0, pressure: 0 }
    if (direction === 'inbound') entry.inbound += 1
    markets.set(market, entry)
  }

  const sortedMarkets = [...markets.entries()].sort((a, b) => {
    const scoreA = a[1].inbound * 2 + a[1].queue
    const scoreB = b[1].inbound * 2 + b[1].queue
    return scoreB - scoreA
  })

  const failedSends = queueRows.filter((row) => {
    const status = normalizeStatus(getFirst(row, ['status', 'queue_status', 'delivery_status']))
    return status === 'failed' || status === 'retry'
  }).length
  const awaitingApproval = queueRows.filter((row) => normalizeStatus(getFirst(row, ['status', 'queue_status'])) === 'approval').length
  const readyNow = queueRows.filter((row) => normalizeStatus(getFirst(row, ['status', 'queue_status'])) === 'ready').length
  const highPriorityOwners = ownerRows.filter((row) => {
    const score = asNumber(getFirst(row, ['motivation_score', 'priority_score']), 0)
    return score >= 70
  }).length
  const highPressureZones = sortedMarkets.filter(([, stat]) => stat.pressure >= 4).length

  const unreadEvents = eventRows.filter((row) => {
    const unread = getFirst(row, ['unread'])
    return unread === true || unread === 1
  }).length

  const activities: HomeActivityItem[] = []

  const newestInbound = eventRows.find((row) => normalizeStatus(getFirst(row, ['direction'])) === 'inbound')
  if (newestInbound) {
    pushActivity(activities, {
      kind: 'reply',
      source: 'Inbox',
      severity: 'info',
      title: 'New inbound seller reply',
      detail: `${asMarket(newestInbound)} owner sent a new message`,
      time: 'just now',
    })
  }

  if (failedSends > 0) {
    pushActivity(activities, {
      kind: 'failed-send',
      source: 'Queue',
      severity: 'critical',
      title: 'Failed sends require recovery',
      detail: `${failedSends} queue items need retry or intervention`,
      time: 'live',
    })
  }

  const openOffers = propertyRows.filter((row) => {
    const score = asNumber(getFirst(row, ['structured_motivation_score']), 0)
    return score >= 80 // Treat high motivation as active offer candidate
  }).length
  if (openOffers > 0) {
    pushActivity(activities, {
      kind: 'offer',
      source: 'Deals',
      severity: 'warning',
      title: 'Offers in motion',
      detail: `${openOffers} properties are in offer workflow`,
      time: 'live',
    })
  }

  const webhookErrors = webhookRows.filter((row) => {
    const status = normalizeStatus(getFirst(row, ['status']))
    return status === 'failed' || status === 'error'
  }).length
  if (webhookErrors > 0) {
    pushActivity(activities, {
      kind: 'webhook',
      source: 'Automation',
      severity: 'critical',
      title: 'Webhook failures detected',
      detail: `${webhookErrors} webhook events require replay`,
      time: 'live',
    })
  }

  const insights: HomeBriefingInsight[] = [
    {
      id: 'hot-replies',
      label: 'Hot replies waiting',
      value: String(unreadEvents),
      tone: unreadEvents > 0 ? 'warning' : 'success',
    },
    {
      id: 'failed-sends',
      label: 'Failed sends needing recovery',
      value: String(failedSends),
      tone: failedSends > 0 ? 'danger' : 'success',
    },
    {
      id: 'market-pressure',
      label: 'Highest pressure market',
      value: sortedMarkets[0]?.[0] ?? 'N/A',
      tone: 'neutral',
    },
    {
      id: 'title-blockers',
      label: 'Offer/contract action needed',
      value: `${openOffers} files`,
      tone: openOffers > 0 ? 'warning' : 'success',
    },
    {
      id: 'automation-health',
      label: 'Automation health',
      value: webhookErrors > 0 ? 'degraded' : 'healthy',
      tone: webhookErrors > 0 ? 'danger' : 'success',
    },
  ]

  const widgetMetrics: Record<string, string> = {
    'inbox-hot-replies': String(unreadEvents),
    'queue-ready-now': String(readyNow),
    'queue-awaiting-approval': String(awaitingApproval),
    'queue-failed-sends': String(failedSends),
    'dossier-hot-sellers': String(highPriorityOwners),
    'market-heat': `${Math.max(sortedMarkets.length, 0)} markets`,
    'market-pressure-zones': `${highPressureZones} zones`,
    'automation-webhook-failures': String(webhookErrors),
  }

  const ownerScanCount = ownerRows.length
  const propertyScanCount = propertyRows.length
  const scanBase = ownerScanCount + propertyScanCount

  return {
    briefingInsights: insights,
    topMarkets: sortedMarkets.slice(0, 6).map(([market]) => market),
    activeMarkets: sortedMarkets.length,
    leadPulses: unreadEvents,
    highPressureZones,
    aiScanStatus: scanBase > 0 ? `AI scan live (${scanBase})` : 'AI scan ready',
    activities: activities.slice(0, 8),
    widgetMetrics,
  }
}
