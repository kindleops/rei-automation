import { FAILURE_LABEL } from '../../domain/queue/classifyFailure'
import type { QueueItem } from '../../domain/queue/queue.types'
import { BLOCKED_STATUSES, isFailed, isManualMessage, isDelivered, pct } from './queue-ui-helpers'

export const FAILURE_CAUSE_LABEL: Record<string, string> = {
  ...FAILURE_LABEL,
  paused_name_missing: 'Paused — Name Missing',
  blocked_by_guard: 'Blocked By Queue Guard',
}

export const FAILURE_META: Record<string, {
  category: string
  retryable: boolean
  suppression: boolean
  action: string
  severity: 'critical' | 'high' | 'medium' | 'low'
}> = {
  textgrid_content_filter: { category: 'Carrier', retryable: false, suppression: false, action: 'Revise template wording — carrier content filter rejected it.', severity: 'high' },
  blacklist_pair_21610: { category: 'Compliance', retryable: false, suppression: true, action: 'Suppress the sender↔recipient pair. Never retry (21610).', severity: 'critical' },
  recipient_opted_out: { category: 'Compliance', retryable: false, suppression: true, action: 'Honor opt-out — suppress recipient permanently.', severity: 'critical' },
  invalid_number: { category: 'Carrier', retryable: false, suppression: true, action: 'Mark number invalid and suppress; re-skiptrace owner.', severity: 'high' },
  suppression_blocked: { category: 'Compliance', retryable: false, suppression: true, action: 'Already suppressed — no send. Review suppression list.', severity: 'high' },
  no_valid_sender: { category: 'Routing', retryable: true, suppression: false, action: 'Add/inspect a TextGrid sender for this market, then retry routing.', severity: 'medium' },
  missing_template: { category: 'Template', retryable: true, suppression: false, action: 'Attach a template for this stage, then re-queue.', severity: 'medium' },
  blank_message_body: { category: 'Payload', retryable: true, suppression: false, action: 'Rehydrate message body / merge fields, then retry.', severity: 'medium' },
  message_event_missing: { category: 'Webhook', retryable: true, suppression: false, action: 'Reconcile delivery webhook to backfill the message event.', severity: 'medium' },
  carrier_failure: { category: 'Carrier', retryable: true, suppression: false, action: 'Transient carrier error — safe to retry within caps.', severity: 'medium' },
  stale_runnable_row: { category: 'Queue', retryable: false, suppression: false, action: 'Exceeded retries / stale — cancel or manually re-queue.', severity: 'low' },
  paused_name_missing: { category: 'Payload', retryable: true, suppression: false, action: 'Resolve seller name, then reprocess paused rows.', severity: 'medium' },
  blocked_by_guard: { category: 'Guard', retryable: false, suppression: false, action: 'Review the queue-guard reason; clear guard or cancel.', severity: 'high' },
  unknown: { category: 'Unknown', retryable: true, suppression: false, action: 'Inspect raw failed_reason and classify before bulk retry.', severity: 'low' },
}

export const FAILURE_CATEGORY_TONE: Record<string, string> = {
  Carrier: 'red',
  Compliance: 'red',
  Routing: 'amber',
  Template: 'amber',
  Payload: 'amber',
  Webhook: 'amber',
  Guard: 'amber',
  Queue: 'muted',
  Unknown: 'muted',
}

export const FAILURE_SEVERITY_ACCENT: Record<string, string> = {
  critical: '#f87171',
  high: '#fb923c',
  medium: '#f59e0b',
  low: '#64748b',
}

export function deriveFailureCause(item: QueueItem): string | null {
  if (isManualMessage(item) && (item.failureCategory === 'missing_template' || item.diagnosticFlags.includes('MISSING_TEMPLATE'))) return null
  if (isDelivered(item.status) && item.failureCategory === 'missing_template') return null
  if (item.failureCategory) return item.failureCategory
  if (item.status === 'paused_name_missing') return 'paused_name_missing'
  if (BLOCKED_STATUSES.has(item.status)) return 'blocked_by_guard'
  if (isFailed(item.status)) return 'unknown'
  return null
}

export interface FailureCauseStat {
  cause: string
  label: string
  category: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  count: number
  pctOfTotal: number
  blockedCount: number
  failedCount: number
  retryable: boolean
  suppression: boolean
  action: string
  markets: string[]
  senders: string[]
  templates: string[]
  topMarket: string | null
  firstSeen: string | null
  lastSeen: string | null
}

export interface FailureTaxonomySummary {
  total: number
  causeCount: number
  retryable: number
  nonRetryable: number
  suppressionRequired: number
  compliance: number
  carrier: number
  routing: number
  template: number
  payload: number
  webhook: number
  guard: number
  queue: number
  unknown: number
  blocked: number
  failed: number
  uniqueMarkets: number
  uniqueSenders: number
  uniqueTemplates: number
}

export type FailureCategoryFilter = 'all' | 'Compliance' | 'Carrier' | 'Routing' | 'Template' | 'Payload' | 'Webhook' | 'Guard' | 'Queue' | 'Unknown'
export type FailureRetryFilter = 'all' | 'retryable' | 'non-retryable' | 'suppression'

export function buildFailureStats(items: QueueItem[]): FailureCauseStat[] {
  const map = new Map<string, {
    count: number
    blockedCount: number
    failedCount: number
    markets: Map<string, number>
    senders: Set<string>
    templates: Set<string>
    firstSeen: string | null
    lastSeen: string | null
  }>()

  for (const item of items) {
    const cause = deriveFailureCause(item)
    if (!cause) continue
    const entry = map.get(cause) ?? {
      count: 0,
      blockedCount: 0,
      failedCount: 0,
      markets: new Map<string, number>(),
      senders: new Set<string>(),
      templates: new Set<string>(),
      firstSeen: null,
      lastSeen: null,
    }
    entry.count++
    if (BLOCKED_STATUSES.has(item.status)) entry.blockedCount++
    if (isFailed(item.status)) entry.failedCount++
    if (item.market && item.market !== 'Market unknown') {
      entry.markets.set(item.market, (entry.markets.get(item.market) ?? 0) + 1)
    }
    if (item.fromPhoneNumber) entry.senders.add(item.fromPhoneNumber)
    if (item.templateName && item.templateName !== 'Template not attached') entry.templates.add(item.templateName)
    const ts = item.lastEventAt || item.updatedAt || item.createdAt
    if (ts) {
      if (!entry.firstSeen || ts < entry.firstSeen) entry.firstSeen = ts
      if (!entry.lastSeen || ts > entry.lastSeen) entry.lastSeen = ts
    }
    map.set(cause, entry)
  }

  const total = Array.from(map.values()).reduce((n, e) => n + e.count, 0)

  return Array.from(map.entries()).map(([cause, e]) => {
    const meta = FAILURE_META[cause] ?? FAILURE_META.unknown
    const markets = Array.from(e.markets.entries()).sort((a, b) => b[1] - a[1])
    return {
      cause,
      label: FAILURE_CAUSE_LABEL[cause] ?? cause.replace(/_/g, ' '),
      category: meta.category,
      severity: meta.severity,
      count: e.count,
      pctOfTotal: pct(e.count, total),
      blockedCount: e.blockedCount,
      failedCount: e.failedCount,
      retryable: meta.retryable,
      suppression: meta.suppression,
      action: meta.action,
      markets: markets.map(([m]) => m),
      senders: Array.from(e.senders),
      templates: Array.from(e.templates).sort(),
      topMarket: markets[0]?.[0] ?? null,
      firstSeen: e.firstSeen,
      lastSeen: e.lastSeen,
    }
  }).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

export function summarizeFailureTaxonomy(stats: FailureCauseStat[]): FailureTaxonomySummary {
  const total = stats.reduce((n, s) => n + s.count, 0)
  const sumCategory = (cat: string) => stats.filter((s) => s.category === cat).reduce((n, s) => n + s.count, 0)
  const marketSet = new Set<string>()
  const senderSet = new Set<string>()
  const templateSet = new Set<string>()
  for (const s of stats) {
    s.markets.forEach((m) => marketSet.add(m))
    s.senders.forEach((p) => senderSet.add(p))
    s.templates.forEach((t) => templateSet.add(t))
  }

  return {
    total,
    causeCount: stats.length,
    retryable: stats.filter((s) => s.retryable).reduce((n, s) => n + s.count, 0),
    nonRetryable: stats.filter((s) => !s.retryable).reduce((n, s) => n + s.count, 0),
    suppressionRequired: stats.filter((s) => s.suppression).reduce((n, s) => n + s.count, 0),
    compliance: sumCategory('Compliance'),
    carrier: sumCategory('Carrier'),
    routing: sumCategory('Routing'),
    template: sumCategory('Template'),
    payload: sumCategory('Payload'),
    webhook: sumCategory('Webhook'),
    guard: sumCategory('Guard'),
    queue: sumCategory('Queue'),
    unknown: sumCategory('Unknown'),
    blocked: stats.reduce((n, s) => n + s.blockedCount, 0),
    failed: stats.reduce((n, s) => n + s.failedCount, 0),
    uniqueMarkets: marketSet.size,
    uniqueSenders: senderSet.size,
    uniqueTemplates: templateSet.size,
  }
}

export function filterFailureStats(
  stats: FailureCauseStat[],
  categoryFilter: FailureCategoryFilter,
  retryFilter: FailureRetryFilter,
): FailureCauseStat[] {
  return stats.filter((s) => {
    if (categoryFilter !== 'all' && s.category !== categoryFilter) return false
    if (retryFilter === 'retryable' && !s.retryable) return false
    if (retryFilter === 'non-retryable' && s.retryable) return false
    if (retryFilter === 'suppression' && !s.suppression) return false
    return true
  })
}