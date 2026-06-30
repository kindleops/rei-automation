import type { QueueItem } from '../../domain/queue/queue.types'
import { BLOCKED_STATUSES, displayName, isDelivered, isFailed } from './queue-ui-helpers'

export const EVENT_ICON: Record<string, string> = {
  sent: 'send',
  delivered: 'check',
  failed: 'alert-circle',
  retry: 'refresh-cw',
  scheduled: 'clock',
  queued: 'clock',
  sending: 'activity',
  blocked: 'shield',
  cancelled: 'close',
  approval: 'zap',
  held: 'pause',
  replied_before_send: 'message',
}

export const TIMELINE_TYPE_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'sent', label: 'Sent' },
  { key: 'failed', label: 'Failed' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'queued', label: 'Queued' },
  { key: 'sending', label: 'Sending' },
  { key: 'retry', label: 'Retry' },
  { key: 'approval', label: 'Approval' },
  { key: 'opt-out', label: 'Opt-out' },
  { key: 'suppression', label: 'Suppression' },
  { key: 'workflow', label: 'Workflow' },
  { key: 'provider receipt', label: 'Receipts' },
] as const

export type TimelineTypeFilter = typeof TIMELINE_TYPE_FILTERS[number]['key']
export type TimelineGroupBy = 'time' | 'campaign' | 'seller' | 'sender' | 'market'

export function eventTimestamp(item: QueueItem): string {
  return item.lastEventAt ?? item.updatedAt ?? item.createdAt
}

export function matchesTimelineFilter(item: QueueItem, filter: string): boolean {
  if (filter === 'all') return true
  const statusKey = BLOCKED_STATUSES.has(item.status) ? 'blocked' : item.status
  if (filter === 'opt-out') return item.failureCategory === 'recipient_opted_out'
  if (filter === 'suppression') {
    return item.failureCategory === 'blacklist_pair_21610' || item.failureCategory === 'suppression_blocked'
  }
  if (filter === 'workflow') return Boolean(item.workflowId || item.automationSource)
  if (filter === 'provider receipt') {
    return Boolean(item.providerMessageId || item.textgridMessageId || item.lastEventType)
  }
  if (filter === 'retry') return item.status === 'retry'
  return statusKey === filter || item.status === filter
}

export function buildEventTimelineItems(items: QueueItem[]): QueueItem[] {
  return [...items]
    .filter((i) => i.lastEventAt || i.updatedAt)
    .sort((a, b) => new Date(eventTimestamp(b)).getTime() - new Date(eventTimestamp(a)).getTime())
}

export interface TimelineGroup {
  key: string
  label: string
  items: QueueItem[]
}

export function resolveTimelineGroupKey(item: QueueItem, groupBy: TimelineGroupBy): string {
  if (groupBy === 'campaign') return item.campaignName || 'No campaign'
  if (groupBy === 'seller') return displayName(item)
  if (groupBy === 'sender') return item.fromPhoneNumber || 'No sender'
  return item.market || 'Unknown market'
}

export function buildTimelineGroups(items: QueueItem[], groupBy: TimelineGroupBy): TimelineGroup[] {
  if (groupBy === 'time') {
    return [{ key: 'timeline', label: '', items }]
  }

  const map = new Map<string, QueueItem[]>()
  for (const item of items) {
    const key = resolveTimelineGroupKey(item, groupBy)
    const bucket = map.get(key) ?? []
    bucket.push(item)
    map.set(key, bucket)
  }

  return Array.from(map.entries())
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([key, groupItems]) => ({ key, label: key, items: groupItems }))
}

export interface EventTimelineSummary {
  total: number
  lastHour: number
  last15m: number
  delivered: number
  sent: number
  failed: number
  blocked: number
  workflow: number
  receipts: number
  latestAt: string | null
  peakHourLabel: string | null
  peakHourCount: number
}

export interface HourlyVelocityBucket {
  key: string
  label: string
  count: number
  tone: 'idle' | 'low' | 'mid' | 'high' | 'peak'
}

export function summarizeEventTimeline(items: QueueItem[]): EventTimelineSummary {
  const now = Date.now()
  const oneHourAgo = now - 3600000
  const fifteenMinAgo = now - 900000

  let lastHour = 0
  let last15m = 0
  let delivered = 0
  let sent = 0
  let failed = 0
  let blocked = 0
  let workflow = 0
  let receipts = 0
  let latestAt: string | null = null

  for (const item of items) {
    const ts = eventTimestamp(item)
    const ms = new Date(ts).getTime()
    if (!latestAt || ts > latestAt) latestAt = ts
    if (ms > oneHourAgo) lastHour++
    if (ms > fifteenMinAgo) last15m++
    if (isDelivered(item.status)) delivered++
    if (item.status === 'sent' || isDelivered(item.status)) sent++
    if (isFailed(item.status)) failed++
    if (BLOCKED_STATUSES.has(item.status)) blocked++
    if (item.workflowId || item.automationSource) workflow++
    if (item.providerMessageId || item.textgridMessageId || item.lastEventType) receipts++
  }

  const buckets = buildHourlyVelocity(items, 12)
  const peak = buckets.reduce((best, b) => (b.count > best.count ? b : best), buckets[0] ?? { count: 0, label: null as string | null })

  return {
    total: items.length,
    lastHour,
    last15m,
    delivered,
    sent,
    failed,
    blocked,
    workflow,
    receipts,
    latestAt,
    peakHourLabel: peak?.label ?? null,
    peakHourCount: peak?.count ?? 0,
  }
}

export function buildHourlyVelocity(items: QueueItem[], buckets = 12): HourlyVelocityBucket[] {
  const now = new Date()
  const result: HourlyVelocityBucket[] = []
  const counts: number[] = Array(buckets).fill(0)

  for (const item of items) {
    const ms = new Date(eventTimestamp(item)).getTime()
    const hoursAgo = Math.floor((now.getTime() - ms) / 3600000)
    if (hoursAgo >= 0 && hoursAgo < buckets) {
      counts[buckets - 1 - hoursAgo]++
    }
  }

  const max = Math.max(...counts, 1)
  for (let i = 0; i < buckets; i++) {
    const hourOffset = buckets - 1 - i
    const d = new Date(now.getTime() - hourOffset * 3600000)
    const label = d.toLocaleTimeString(undefined, { hour: 'numeric' })
    const count = counts[i]
    const ratio = count / max
    const tone: HourlyVelocityBucket['tone'] =
      count === 0 ? 'idle'
        : ratio > 0.85 ? 'peak'
          : ratio > 0.55 ? 'high'
            : ratio > 0.25 ? 'mid'
              : 'low'
    result.push({
      key: `h-${i}`,
      label,
      count,
      tone,
    })
  }
  return result
}

export function isLiveEvent(iso: string, windowMs = 300000): boolean {
  return Date.now() - new Date(iso).getTime() <= windowMs
}

export function formatHourSeparator(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + ' · '
    + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function shouldShowTimeSeparator(
  current: string,
  previous: string | null,
  groupBy: TimelineGroupBy,
): boolean {
  if (groupBy !== 'time' || !previous) return false
  const cur = new Date(current)
  const prev = new Date(previous)
  return cur.toDateString() !== prev.toDateString()
    || Math.abs(cur.getTime() - prev.getTime()) > 3600000
}