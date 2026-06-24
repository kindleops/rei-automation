import type { HomeActivityItem, HomeBriefingInsight } from '../../shared/home/home.types'
import { fetchInboxCounts, getQueueStatus } from '../api/backendClient'
import {
  asNumber,
  asString,
  getFirst,
  normalizeStatus,
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
  const [queueStatusRes, inboxCountsRes] = await Promise.all([
    getQueueStatus().catch((err) => {
      console.error('[DashboardData] queue status failed:', err)
      return null
    }),
    fetchInboxCounts().catch((err) => {
      console.error('[DashboardData] inbox counts failed:', err)
      return null
    }),
  ])

  const queueCounts = (queueStatusRes?.ok
    ? (((queueStatusRes.data as AnyRecord)?.diagnostics as AnyRecord)?.counts as AnyRecord)
    : null) ?? {}
  const inboxCounts = (inboxCountsRes?.ok
    ? (((inboxCountsRes.data as AnyRecord)?.counts as AnyRecord)
      ?? ((inboxCountsRes.data as AnyRecord)?.data as AnyRecord)?.counts as AnyRecord)
    : null) ?? {}

  const queueRows: AnyRecord[] = []
  const eventRows: AnyRecord[] = []
  const ownerRows: AnyRecord[] = []
  const propertyRows: AnyRecord[] = []
  const webhookRows: AnyRecord[] = []

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

  const failedSends = Number(queueCounts.failed || 0) + Number(queueCounts.retry || 0)
  const awaitingApproval = Number(queueCounts.approval || 0) + Number(queueCounts.awaiting_approval || 0)
  const readyNow = Number(queueCounts.ready || 0) + Number(queueCounts.queued || 0)
  const highPriorityOwners = ownerRows.filter((row) => {
    const score = asNumber(getFirst(row, ['motivation_score', 'priority_score']), 0)
    return score >= 70
  }).length
  const highPressureZones = sortedMarkets.filter(([, stat]) => stat.pressure >= 4).length

  const unreadEvents = Number(inboxCounts.new_replies || inboxCounts.needs_reply || 0)

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
