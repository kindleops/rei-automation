import { useState, useMemo } from 'react'
import type { QueueItem, QueueModel } from '../../queue/queue.types'
import type { QueueCommandMode } from './QueueCommandCenter'
import type { QueueProcessorHealth } from '../../../lib/data/inboxData'
import type { ViewLayoutMode } from '../view-layout'
import { QueuePipelineBar, PIPELINE_STAGES } from './queue/QueuePipelineBar'
import { QueueHealthPanel } from './queue/QueueHealthPanel'
import { QueueActionsBar } from './queue/QueueActionsBar'
import { QueueFailureTaxonomy } from './queue/QueueFailureTaxonomy'
import { QueueRowInspector } from './queue/QueueRowInspector'
import { SenderNumberHealthPanel } from './queue/SenderNumberHealthPanel'
import { MarketLoadPanel } from './queue/MarketLoadPanel'
import { RoutingCoveragePanel } from './queue/RoutingCoveragePanel'
import { TemplateCoveragePanel } from './queue/TemplateCoveragePanel'
import { RecentQueueEvents } from './queue/RecentQueueEvents'
import '../send-queue-dashboard.css'
import '../queue-ops.css'

// ── Helpers ──────────────────────────────────────────────────────────────────

const relTime = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const windowCutoff = (w: '24h' | 'today' | '7d'): number => {
  if (w === '24h') return Date.now() - 86_400_000
  if (w === '7d')  return Date.now() - 7 * 86_400_000
  const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime()
}

// ── Cluster config ────────────────────────────────────────────────────────────

interface ClusterConfig { key: string; label: string; states: string[]; senderCity: string }

const SENDER_CLUSTERS: ClusterConfig[] = [
  { key: 'WEST_COAST',     label: 'West Coast',      states: ['CA', 'AZ', 'NV'],              senderCity: 'Los Angeles' },
  { key: 'TEXAS_OK',       label: 'Texas / Oklahoma', states: ['TX', 'OK'],                    senderCity: 'Dallas · Houston' },
  { key: 'SOUTHEAST_EAST', label: 'Southeast',        states: ['GA', 'NC', 'SC', 'FL'],        senderCity: 'Atlanta · Charlotte · Miami' },
  { key: 'MIDWEST',        label: 'Midwest',          states: ['MN', 'WI', 'IA', 'ND', 'SD'], senderCity: 'Minneapolis' },
]

const MARKET_TO_CLUSTER: Record<string, string> = {
  'Los Angeles': 'WEST_COAST', 'San Diego': 'WEST_COAST', 'Sacramento': 'WEST_COAST',
  'Phoenix': 'WEST_COAST', 'Tucson': 'WEST_COAST', 'Mesa': 'WEST_COAST',
  'Las Vegas': 'WEST_COAST', 'Reno': 'WEST_COAST', 'Henderson': 'WEST_COAST',
  'Dallas': 'TEXAS_OK', 'Houston': 'TEXAS_OK', 'San Antonio': 'TEXAS_OK',
  'Austin': 'TEXAS_OK', 'Fort Worth': 'TEXAS_OK', 'Arlington': 'TEXAS_OK',
  'Oklahoma City': 'TEXAS_OK', 'Tulsa': 'TEXAS_OK',
  'Atlanta': 'SOUTHEAST_EAST', 'Savannah': 'SOUTHEAST_EAST', 'Augusta': 'SOUTHEAST_EAST',
  'Charlotte': 'SOUTHEAST_EAST', 'Raleigh': 'SOUTHEAST_EAST', 'Greensboro': 'SOUTHEAST_EAST',
  'Columbia': 'SOUTHEAST_EAST', 'Charleston': 'SOUTHEAST_EAST', 'Greenville': 'SOUTHEAST_EAST',
  'Jacksonville': 'SOUTHEAST_EAST', 'Miami': 'SOUTHEAST_EAST', 'Orlando': 'SOUTHEAST_EAST',
  'Tampa': 'SOUTHEAST_EAST', 'Fort Lauderdale': 'SOUTHEAST_EAST',
  'Minneapolis': 'MIDWEST', 'Saint Paul': 'MIDWEST',
  'Milwaukee': 'MIDWEST', 'Madison': 'MIDWEST', 'Green Bay': 'MIDWEST',
  'Des Moines': 'MIDWEST', 'Cedar Rapids': 'MIDWEST',
  'Fargo': 'MIDWEST', 'Bismarck': 'MIDWEST',
  'Sioux Falls': 'MIDWEST', 'Rapid City': 'MIDWEST',
}

// ── Launch checklist ──────────────────────────────────────────────────────────

const LAUNCH_CHECKLIST = [
  { id: 'senders', label: 'Confirm sender clusters are provisioned',        detail: 'TextGrid numbers active for each cluster sender city' },
  { id: 'routing', label: 'Verify routing coverage by state',               detail: 'All target states have a mapped sender or fallback tier' },
  { id: 'sellers', label: 'Load sellers into approved contact list',        detail: 'Contacts must pass compliance and suppression checks first' },
  { id: 'build',   label: 'Build outbound queue from Queue Command Center', detail: 'Use the dropdown → Run Queue Once or Find Sellers' },
  { id: 'mode',    label: 'Set Queue Mode to Safe or Live',                 detail: 'Safe = operator approval required; Live = automated send' },
]

// ── Rail metrics config (25% mode) ────────────────────────────────────────────

interface RailMetric { label: string; key: string; tone?: string }

const RAIL_METRICS: RailMetric[] = [
  { label: 'Ready',           key: 'ready',          tone: 'cyan'  },
  { label: 'Scheduled',       key: 'scheduled',      tone: 'blue'  },
  { label: 'Sent Today',      key: 'sentToday',      tone: 'green' },
  { label: 'Failed',          key: 'failed',         tone: 'red'   },
  { label: 'Routing Blocked', key: 'routingBlocked', tone: 'amber' },
  { label: 'Needs Review',    key: 'needsReview',    tone: 'amber' },
]

// ── Component ─────────────────────────────────────────────────────────────────

interface SendQueueDashboardProps {
  queueModel: QueueModel | null
  processorHealth: QueueProcessorHealth | null
  queueCommandMode: QueueCommandMode
  layoutMode?: ViewLayoutMode
  selectedQueueId?: string | null
  onSelectItem?: (item: QueueItem) => void
  // Queue action callbacks (passed from parent QueueCommandCenter)
  onModeChange?: (mode: QueueCommandMode) => void
  onRunQueueNow?: () => void
  onRetryFailed?: () => void
  onReconcileDelivery?: () => void
  onCancelStaleFollowUps?: () => void
  onReprocessPaused?: () => void
  actionLoading?: string | null
}

export function SendQueueDashboard({
  queueModel,
  processorHealth,
  queueCommandMode,
  layoutMode = 'full',
  selectedQueueId = null,
  onSelectItem,
  onModeChange,
  onRunQueueNow,
  onRetryFailed,
  onReconcileDelivery,
  onCancelStaleFollowUps,
  onReprocessPaused,
  actionLoading = null,
}: SendQueueDashboardProps) {
  const [searchQuery, setSearchQuery]     = useState('')
  const [statusFilter, setStatusFilter]   = useState<string>('all')
  const [marketFilter, setMarketFilter]   = useState<string>('all')
  const [failureFilter, setFailureFilter] = useState<string | null>(null)
  const [timeWindow, setTimeWindow]       = useState<'24h' | 'today' | '7d'>('today')

  const isRail     = layoutMode === 'compact'   // 25%
  const isStatus   = layoutMode === 'medium'    // 50%
  const isOps      = layoutMode === 'expanded'  // 75%
  const isFull     = layoutMode === 'full'      // 100%

  const items = useMemo(() => queueModel?.items ?? [], [queueModel])

  // Pipeline counts — historical stages (Sent/Delivered/Replied/Failed) are time-windowed
  const stageCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const s of PIPELINE_STAGES) counts[s.key] = 0
    const cutoff = windowCutoff(timeWindow)
    for (const item of items) {
      for (const s of PIPELINE_STAGES) {
        if (!s.statuses.includes(item.status)) continue
        if (s.historical) {
          const ts = item.sentAt ?? item.scheduledForLocal
          if (!ts || new Date(ts).getTime() < cutoff) break
        }
        counts[s.key]++
        break
      }
    }
    return counts
  }, [items, timeWindow])

  const healthMetrics = useMemo(() => ({
    failedToday:        processorHealth?.failedTodayCount       ?? queueModel?.failedCount ?? 0,
    routingBlocked:     processorHealth?.routingBlockedCount     ?? 0,
    suppressionBlocked: processorHealth?.suppressionBlockedCount ?? 0,
    blankBody:          processorHealth?.blankBodyBlockedCount   ?? 0,
    needsReview:        queueModel?.approvalCount ?? 0,
    webhookHealthy:     processorHealth?.webhookHealthy ?? true,
  }), [processorHealth, queueModel])

  // Failure taxonomy — group counts from items
  const failureGroupCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const item of items) {
      if (item.status === 'failed' || item.status === 'retry' || item.status === 'blocked') {
        const g = item.failureGroup ?? 'Unknown'
        counts[g] = (counts[g] ?? 0) + 1
      }
    }
    return counts
  }, [items])

  const totalFailed = Object.values(failureGroupCounts).reduce((a, b) => a + b, 0)

  const marketLoad = useMemo(() => {
    const map = new Map<string, { scheduled: number; ready: number; sent: number; delivered: number; failed: number; blocked: number; total: number; replied: number; optOuts: number; activeSender: string }>()
    for (const item of items) {
      const m = item.market || 'Unknown'
      if (!map.has(m)) map.set(m, { scheduled: 0, ready: 0, sent: 0, delivered: 0, failed: 0, blocked: 0, total: 0, replied: 0, optOuts: 0, activeSender: '' })
      const e = map.get(m)!
      e.total++
      if (item.status === 'scheduled')                                  e.scheduled++
      else if (item.status === 'ready')                                  e.ready++
      else if (item.status === 'sent')                                   e.sent++
      else if (item.status === 'delivered')                              e.delivered++
      else if (item.status === 'replied_before_send')                    e.replied++
      else if (item.status === 'failed' || item.status === 'retry') {
        e.failed++
        if (item.failureCategory === 'recipient_opted_out') e.optOuts++
      }
      else if (item.status === 'blocked' || item.status === 'held')     e.blocked++
      
      if (!e.activeSender && item.textgridNumber) e.activeSender = `…${item.textgridNumber.slice(-4)}`
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 12)
      .map(([market, c]) => {
        const deliveryRate = c.sent > 0 ? c.delivered / c.sent : 0
        const failureRate = c.sent > 0 ? c.failed / c.sent : 0
        let health: 'green' | 'amber' | 'red' | 'muted' = 'green'
        if (c.sent === 0) health = 'muted'
        else if (failureRate > 0.1) health = 'red'
        else if (failureRate > 0.05) health = 'amber'
        return { market, ...c, deliveryRate, failureRate, health }
      })
  }, [items])

  const routingCoverage = useMemo(() => {
    const marketSenders = new Map<string, Set<string>>()
    const marketBlocked = new Map<string, number>()
    const tier = { t1: 0, t2: 0, t3: 0, t4: 0 }
    for (const item of items) {
      const m = item.market || 'Unknown'
      if (!marketSenders.has(m)) marketSenders.set(m, new Set())
      if (item.textgridNumber) marketSenders.get(m)!.add(item.textgridNumber)
      if (item.failureGroup === 'Routing') { marketBlocked.set(m, (marketBlocked.get(m) ?? 0) + 1); tier.t4++ }
      const rr = (item.routingReason ?? '').toLowerCase()
      if      (rr.includes('tier 1') || rr.includes('exact'))    tier.t1++
      else if (rr.includes('tier 2') || rr.includes('state'))    tier.t2++
      else if (rr.includes('tier 3') || rr.includes('cluster'))  tier.t3++
    }
    const total = tier.t1 + tier.t2 + tier.t3 + tier.t4
    const pct   = (n: number) => total ? Math.round((n / total) * 100) : 0
    return {
      marketsWithSenders:  Array.from(marketSenders.values()).filter(s => s.size > 0).length,
      marketsBlocked:      marketBlocked.size,
      routingBlockedTotal: Array.from(marketBlocked.values()).reduce((a, b) => a + b, 0),
      tier1Count: tier.t1, tier1Pct: pct(tier.t1),
      tier2Count: tier.t2, tier2Pct: pct(tier.t2),
      tier3Count: tier.t3, tier3Pct: pct(tier.t3),
      tier4Count: tier.t4, tier4Pct: pct(tier.t4),
      sendersByMarket: Array.from(marketSenders.entries())
        .map(([market, senders]) => ({ market, senderCount: senders.size, blocked: marketBlocked.get(market) ?? 0 }))
        .sort((a, b) => b.senderCount - a.senderCount).slice(0, 8),
    }
  }, [items])

  const routingBlockedRows = processorHealth?.routingBlockedRows ?? []

  const clusterStats = useMemo(() => {
    const stats: Record<string, { queued: number; sent: number; blocked: number; failed: number; total: number }> = {}
    for (const c of SENDER_CLUSTERS) stats[c.key] = { queued: 0, sent: 0, blocked: 0, failed: 0, total: 0 }
    for (const item of items) {
      const ck = MARKET_TO_CLUSTER[item.market]
      if (!ck || !stats[ck]) continue
      const s = stats[ck]
      s.total++
      if (['queued', 'scheduled', 'ready', 'approval'].includes(item.status)) s.queued++
      else if (item.status === 'sent' || item.status === 'delivered')          s.sent++
      else if (item.failureGroup === 'Routing')                                s.blocked++
      else if (item.status === 'failed' || item.status === 'retry')            s.failed++
    }
    return stats
  }, [items])

  const templateCoverage = useMemo(() => {
    const counts = new Map<string, number>()
    const failedByTpl = new Map<string, number>()
    let missingTemplate = 0, blankBody = 0
    for (const item of items) {
      const name = item.templateName || 'No Template'
      counts.set(name, (counts.get(name) ?? 0) + 1)
      if (!item.templateName || item.templateName === 'Template not attached') missingTemplate++
      if (!item.messageText) blankBody++
      if (item.failureGroup === 'Template') failedByTpl.set(name, (failedByTpl.get(name) ?? 0) + 1)
    }
    const topTemplates = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1]).slice(0, 7)
      .map(([name, count]) => ({ name, count, failCount: failedByTpl.get(name) ?? 0 }))
    return { topTemplates, missingTemplate, blankBody }
  }, [items])

  const allMarkets = useMemo(() => Array.from(new Set(items.map(i => i.market || 'Unknown'))).sort(), [items])

  // Failure taxonomy filter maps to PIPELINE_STAGES for statusFilter, or failureGroup for failureFilter
  const filteredRows = useMemo((): QueueItem[] => {
    let result = items
    if (statusFilter !== 'all') {
      const stage = PIPELINE_STAGES.find(s => s.key === statusFilter)
      result = stage
        ? result.filter(i => stage.statuses.includes(i.status))
        : result.filter(i => i.status === statusFilter || (statusFilter === 'failed' && i.status === 'retry'))
    }
    if (marketFilter !== 'all') result = result.filter(i => (i.market || 'Unknown') === marketFilter)
    if (failureFilter)          result = result.filter(i => {
      // Match by failure category key
      if (failureFilter === 'textgrid_content_filter') return i.failureGroup === 'Carrier' && i.failureReason === 'textgrid_error'
      if (failureFilter === 'blacklist_pair_21610')    return i.failureGroup === 'Compliance'
      if (failureFilter === 'recipient_opted_out')     return i.failureGroup === 'Compliance'
      if (failureFilter === 'invalid_number')          return i.failureReason === 'invalid_phone'
      if (failureFilter === 'suppression_blocked')     return i.failureGroup === 'Compliance'
      if (failureFilter === 'no_valid_sender')         return i.failureGroup === 'Routing'
      if (failureFilter === 'missing_template')        return i.failureGroup === 'Template'
      if (failureFilter === 'blank_message_body')      return i.failureGroup === 'Payload' || !i.messageText
      if (failureFilter === 'webhook_missing')         return i.failureGroup === 'Webhook'
      if (failureFilter === 'message_event_missing')   return i.missingMessageEvent
      if (failureFilter === 'carrier_failure')         return i.failureGroup === 'Carrier'
      if (failureFilter === 'unknown')                 return i.failureGroup === 'Unknown' || !i.failureGroup
      return i.failureGroup === failureFilter
    })
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(i =>
        i.sellerName.toLowerCase().includes(q)      ||
        i.propertyAddress.toLowerCase().includes(q)  ||
        i.market.toLowerCase().includes(q)           ||
        i.templateName.toLowerCase().includes(q)     ||
        (i.campaignId ?? '').toLowerCase().includes(q) ||
        (i.campaignTargetId ?? '').toLowerCase().includes(q) ||
        i.phone.includes(q),
      )
    }
    return result.slice(0, isStatus ? 30 : 100)
  }, [items, statusFilter, marketFilter, failureFilter, searchQuery, isStatus])

  const hasFilters  = statusFilter !== 'all' || marketFilter !== 'all' || !!failureFilter || !!searchQuery.trim()
  const clearFilters = () => { setStatusFilter('all'); setMarketFilter('all'); setFailureFilter(null); setSearchQuery('') }

  const health     = processorHealth?.status ?? 'unknown'
  const healthTone = health === 'healthy' ? 'green' : health === 'warning' ? 'amber' : health === 'critical' ? 'red' : 'muted'
  const modeTone   = queueCommandMode === 'automatic' ? 'green' : queueCommandMode === 'assisted' ? 'blue' : 'muted'
  const modeLabel  = queueCommandMode === 'automatic' ? 'Automatic' : queueCommandMode === 'assisted' ? 'Assisted' : 'Paused'
  const totalItems = items.length
  const isLoading  = !queueModel
  const isEmpty    = !isLoading && totalItems === 0

  // Rail metric values
  const railValues: Record<string, number | string> = {
    ready:          queueModel?.readyCount      ?? '—',
    scheduled:      queueModel?.scheduledCount  ?? '—',
    sentToday:      queueModel?.sentTodayCount  ?? '—',
    failed:         healthMetrics.failedToday,
    routingBlocked: healthMetrics.routingBlocked,
    needsReview:    healthMetrics.needsReview,
  }

  // ── 25% — Queue Rail ──────────────────────────────────────────────────────
  if (isRail) {
    return (
      <div className="sqd sqd--rail">

        {/* Health header */}
        <div className="sqd-rail__header">
          <div className="sqd-rail__health-row">
            <span className={`sqd-rail__dot is-${healthTone}`} />
            <span className="sqd-rail__health-label">
              {health === 'healthy' ? 'Healthy' : health === 'warning' ? 'Warning' : health === 'critical' ? 'Critical' : 'Unknown'}
            </span>
          </div>
          <div className={`sqd-rail__mode is-${modeTone}`}>{modeLabel}</div>
        </div>

        {/* Metrics stack */}
        <div className="sqd-rail__metrics">
          {RAIL_METRICS.map(({ label, key, tone }) => {
            const val = railValues[key]
            const nonzero = typeof val === 'number' && val > 0
            return (
              <div key={key} className="sqd-rail__metric">
                <span className="sqd-rail__metric-label">{label}</span>
                <span className={`sqd-rail__metric-val${nonzero && tone ? ` is-${tone}` : ''}`}>{val}</span>
              </div>
            )
          })}
          <div className="sqd-rail__metric">
            <span className="sqd-rail__metric-label">Webhook</span>
            <span className={`sqd-rail__metric-val${healthMetrics.webhookHealthy ? ' is-green' : ' is-red'}`}>
              {healthMetrics.webhookHealthy ? 'OK' : 'Error'}
            </span>
          </div>
        </div>

        {/* Top 3 blockers */}
        {Object.keys(failureGroupCounts).length > 0 && (
          <div className="sqd-rail__blockers">
            <div className="sqd-rail__blockers-head">Top Failures</div>
            {Object.entries(failureGroupCounts).sort((a,b) => b[1]-a[1]).slice(0, 3).map(([group, count]) => (
              <div key={group} className="sqd-rail__blocker">
                <span className="sqd-rail__blocker-dot is-red" />
                <span className="sqd-rail__blocker-name">{group}</span>
                <span className="sqd-rail__blocker-count is-red">{count}</span>
              </div>
            ))}
          </div>
        )}

        {/* Cluster summary */}
        <div className="sqd-rail__clusters">
          <div className="sqd-rail__clusters-head">Cluster Coverage</div>
          {SENDER_CLUSTERS.map(c => {
            const s = clusterStats[c.key]
            return (
              <div key={c.key} className="sqd-rail__cluster">
                <span className="sqd-rail__cluster-states">{c.states.join('·')}</span>
                <span className={`sqd-rail__cluster-count${(s?.total ?? 0) > 0 ? ' is-cyan' : ''}`}>
                  {s?.total ?? 0}
                </span>
              </div>
            )
          })}
        </div>

        {isEmpty && (
          <div className="sqd-rail__empty">
            <span className="sqd-rail__empty-icon">⬡</span>
            <span className="sqd-rail__empty-label">No queue rows</span>
            <span className="sqd-rail__empty-hint">Build from Command Center</span>
          </div>
        )}

        {isLoading && (
          <div className="sqd-rail__loading">
            <span className="sqd-spinner sqd-spinner--sm" />
            <span>Loading…</span>
          </div>
        )}

        <div className="sqd-rail__footer">
          {totalItems > 0 && <span>{totalItems} rows</span>}
          {processorHealth?.checkedAt && <span>{relTime(processorHealth.checkedAt)}</span>}
        </div>
      </div>
    )
  }

  // ── 50% — Status + Inspector ──────────────────────────────────────────────
  if (isStatus) {
    return (
      <div className="sqd sqd--status">

        {/* Compact pipeline */}
        <div className="sqd-pipeline sqd-pipeline--compact">
          <div className="sqd-pipeline__inner">
            {PIPELINE_STAGES.map((stage, i) => {
              const count    = stageCounts[stage.key] ?? 0
              const isActive = statusFilter === stage.key
              return (
                <div key={stage.key} className="sqd-pipeline__step">
                  <button
                    type="button"
                    className={`sqd-stage sqd-stage--sm is-${stage.tone}${isActive ? ' is-active' : ''}${count === 0 ? ' is-zero' : ''}${stage.isPreQueue ? ' is-prequeue' : ''}`}
                    onClick={() => setStatusFilter(p => p === stage.key ? 'all' : stage.key)}
                    title={stage.label}
                  >
                    <span className="sqd-stage__count">{count}</span>
                    <span className="sqd-stage__label">{stage.label}</span>
                  </button>
                  {i < PIPELINE_STAGES.length - 1 && <span className="sqd-pipeline__arrow">›</span>}
                </div>
              )
            })}
          </div>
          <div className="sqd-pipeline__footer">
            {isLoading
              ? <span className="sqd-pipeline__loading"><span className="sqd-spinner sqd-spinner--sm" />Loading…</span>
              : <span>{totalItems} rows</span>
            }
            {processorHealth?.checkedAt && <span className="sqd-pipeline__checked">{relTime(processorHealth.checkedAt)}</span>}
          </div>
        </div>

        {/* Compact health strip */}
        <div className="sqd-health-row sqd-health-row--compact">
          {[
            { label: 'Health',    val: health === 'healthy' ? 'OK' : health, tone: healthTone },
            { label: 'Mode',      val: modeLabel,                             tone: modeTone  },
            { label: 'Ready',     val: queueModel?.readyCount  ?? '—',       tone: (queueModel?.readyCount ?? 0) > 0 ? 'cyan' : undefined },
            { label: 'Scheduled', val: queueModel?.scheduledCount ?? '—',    tone: 'blue'   },
            { label: 'Sent',      val: queueModel?.sentTodayCount ?? '—',    tone: (queueModel?.sentTodayCount ?? 0) > 0 ? 'green' : undefined },
            { label: 'Failed',    val: healthMetrics.failedToday,             tone: healthMetrics.failedToday > 0 ? 'red' : undefined },
            { label: 'Blocked',   val: healthMetrics.routingBlocked,          tone: healthMetrics.routingBlocked > 0 ? 'amber' : undefined },
            { label: 'Webhook',   val: healthMetrics.webhookHealthy ? 'OK' : 'Error', tone: healthMetrics.webhookHealthy ? 'green' : 'red' },
          ].map(({ label, val, tone }) => (
            <div key={label} className="sqd-hcard sqd-hcard--sm">
              <span className="sqd-hcard__label">{label}</span>
              <strong className={`sqd-hcard__value${tone ? ` is-${tone}` : ''}`}>{val}</strong>
            </div>
          ))}
        </div>

        {isEmpty && (
          <div className="sqd-empty-banner sqd-empty-banner--compact">
            <span className="sqd-empty-banner__icon">⬡</span>
            <div>
              <strong className="sqd-empty-banner__title">No active queue rows.</strong>
              <span className="sqd-empty-banner__hint">Build from Queue Command Center.</span>
            </div>
          </div>
        )}

        {/* Compact failure taxonomy */}
        {totalFailed > 0 && (
          <div className="sqd-section sqd-failure-strip">
            <div className="sqd-section__head">
              <span className="sqd-section-eyebrow">Failures</span>
              <span className="sqd-panel__count">{totalFailed} total</span>
              {failureFilter && (
                <button type="button" className="sqd-clear-chip" onClick={() => setFailureFilter(null)}>{failureFilter} ×</button>
              )}
            </div>
            <div className="sqd-failure-chips">
              {Object.entries(failureGroupCounts).sort((a,b)=>b[1]-a[1]).map(([group, count]) => (
                <button
                  key={group}
                  type="button"
                  className={`sqd-failure-chip is-red${failureFilter === group ? ' is-active' : ''}`}
                  onClick={() => setFailureFilter(p => p === group ? null : group)}
                >
                  <span className="sqd-failure-row__dot is-red" />
                  <span>{group}</span>
                  <span className="sqd-failure-chip__count">{count}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Compact Row Inspector */}
        <div className="sqd-section sqd-inspector sqd-inspector--compact">
          <div className="sqd-inspector__controls">
            <span className="sqd-section-eyebrow">Queue Rows</span>
            <div className="sqd-inspector__filter-row">
              <input
                type="search"
                className="sqd-search"
                placeholder="Search seller, market, template…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
              <select className="sqd-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                <option value="all">All</option>
                {PIPELINE_STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
              {hasFilters && <button type="button" className="sqd-clear-btn" onClick={clearFilters}>✕</button>}
            </div>
            <span className="sqd-inspector__count">{filteredRows.length} / {totalItems}</span>
          </div>

          {isEmpty && !hasFilters ? (
            <div className="sqd-launch-checklist">
              <div className="sqd-launch-checklist__head">Launch Checklist</div>
              {LAUNCH_CHECKLIST.map(item => (
                <div key={item.id} className="sqd-checklist-item">
                  <span className="sqd-checklist-item__box" />
                  <div className="sqd-checklist-item__body">
                    <span className="sqd-checklist-item__label">{item.label}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="sqd-table sqd-table--compact">
              <div className="sqd-table__head sqd-table__head--compact">
                <span>Seller</span><span>Market</span><span>Status</span><span>Failure</span>
              </div>
              <div className="sqd-table__body">
                {filteredRows.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    className={[
                      'sqd-table__row sqd-table__row--compact',
                      `sqd-table__row--${item.status}`,
                      onSelectItem ? 'is-linked' : '',
                      selectedQueueId === item.queueId ? 'is-selected' : '',
                    ].filter(Boolean).join(' ')}
                    onClick={() => onSelectItem?.(item)}
                  >
                    <div className="sqd-cell sqd-cell--seller">
                      <strong>{item.sellerName || '—'}</strong>
                      <small>{item.missingMessageEvent ? 'Missing message event' : (item.market || '—')}</small>
                    </div>
                    <span className="sqd-cell">{item.market || '—'}</span>
                    <span className="sqd-cell">
                      <span className={`sqd-status-pill sqd-status-pill--${item.status}`}>{item.status.replace(/_/g, ' ')}</span>
                    </span>
                    <span className="sqd-cell">
                      {item.failureGroup
                        ? <span className="sqd-fail-pill is-red">{item.failureGroup}</span>
                        : <span className="sqd-cell--dim">—</span>}
                    </span>
                  </button>
                ))}
                {filteredRows.length === 0 && (
                  <div className="sqd-table__empty">No rows match current filters.</div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="sqd-cc-note">
          <span className="sqd-cc-note__icon">⌘</span>
          <span>Queue actions live in the</span>
          <span className="sqd-cc-note__badge">Queue Command Center</span>
          <span>dropdown.</span>
        </div>
      </div>
    )
  }

  // ── 75% — Operational Dashboard ─────────────────────────────────────────
  // ── 100% — Full Command Center ───────────────────────────────────────────
  return (
    <div className={`sqd sqd--${isOps ? 'ops' : 'full'}`}>

      {/* ── 1. Pipeline Bar ─────────────────────────────────────────────── */}
      <QueuePipelineBar
        stageCounts={stageCounts}
        statusFilter={statusFilter}
        timeWindow={timeWindow}
        totalItems={totalItems}
        isLoading={isLoading}
        lastCheckedAt={processorHealth?.checkedAt}
        onStageClick={key => setStatusFilter(p => p === key ? 'all' : key)}
        onTimeWindowChange={setTimeWindow}
      />

      {/* ── Empty State Banner ─────────────────────────────────────────── */}
      {isEmpty && (
        <div className="sqd-empty-banner">
          <div className="sqd-empty-banner__lead">
            <span className="sqd-empty-banner__icon">⬡</span>
            <div>
              <strong className="sqd-empty-banner__title">No active queue rows found.</strong>
              <span className="sqd-empty-banner__hint">Build outbound queue from approved sender clusters to populate this view.</span>
            </div>
          </div>
          <div className="sqd-empty-banner__clusters">
            {SENDER_CLUSTERS.map(c => (
              <div key={c.key} className="sqd-empty-cluster">
                <span className="sqd-empty-cluster__key">{c.label}</span>
                <span className="sqd-empty-cluster__states">{c.states.join(' · ')}</span>
                <span className="sqd-empty-cluster__arrow">→</span>
                <span className="sqd-empty-cluster__sender">{c.senderCity}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── 2. Health Panel (health cards + Why Critical) ──────────────── */}
      <QueueHealthPanel
        processorHealth={processorHealth}
        queueCommandMode={queueCommandMode}
        items={items}
        readyCount={queueModel?.readyCount ?? 0}
        scheduledCount={queueModel?.scheduledCount ?? 0}
        sentTodayCount={queueModel?.sentTodayCount ?? 0}
        deliveredTodayCount={queueModel?.deliveredTodayCount ?? 0}
      />

      {/* ── 3. Safe Queue Actions Bar ──────────────────────────────────── */}
      {(onModeChange || onRunQueueNow) && (
        <QueueActionsBar
          mode={queueCommandMode}
          health={health}
          actionLoading={actionLoading}
          onModeChange={onModeChange ?? (() => {})}
          onRunQueueNow={onRunQueueNow ?? (() => {})}
          onRetryFailed={onRetryFailed ?? (() => {})}
          onReconcileDelivery={onReconcileDelivery ?? (() => {})}
          onCancelStaleFollowUps={onCancelStaleFollowUps ?? (() => {})}
          onReprocessPaused={onReprocessPaused ?? (() => {})}
        />
      )}

      {/* ── 4. Diagnostic Panels ────────────────────────────────────────── */}
      <div className={`sqd-diag-row${isOps ? ' sqd-diag-row--two' : ' sqd-diag-row--three'}`}>

        {/* Failure Taxonomy — 12 categories */}
        <QueueFailureTaxonomy
          groupCounts={failureGroupCounts}
          activeFilter={failureFilter}
          onFilterChange={setFailureFilter}
        />

        {/* Routing Coverage */}
        <RoutingCoveragePanel
          coverage={routingCoverage}
          blockedRows={routingBlockedRows}
        />

        {/* Template Coverage — full only */}
        {isFull && (
          <TemplateCoveragePanel coverage={templateCoverage} />
        )}
      </div>

      {/* ── 5. Cluster Routing (full only) ──────────────────────────────── */}
      {isFull && (
        <div className="sqd-section sqd-cluster-section">
          <div className="sqd-section__head">
            <span className="sqd-section-eyebrow">Approved Cluster Routing</span>
            <span className="sqd-section-sub">Sender clusters eligible for outbound queue build</span>
          </div>
          <div className="sqd-cluster-grid">
            {SENDER_CLUSTERS.map(cluster => {
              const s = clusterStats[cluster.key] ?? { queued: 0, sent: 0, blocked: 0, failed: 0, total: 0 }
              return (
                <div key={cluster.key} className={`sqd-cluster-card${s.total > 0 ? ' is-live' : ''}`}>
                  <div className="sqd-cluster-card__head">
                    <span className="sqd-cluster-card__label">{cluster.label}</span>
                    <span className="sqd-cluster-card__key">{cluster.key.replace(/_/g, ' ')}</span>
                  </div>
                  <div className="sqd-cluster-card__states">
                    {cluster.states.map(st => <span key={st} className="sqd-state-pill">{st}</span>)}
                  </div>
                  <div className="sqd-cluster-card__sender">
                    <span className="sqd-cluster-card__sender-lbl">Sender</span>
                    <span className="sqd-cluster-card__sender-val">{cluster.senderCity}</span>
                  </div>
                  <div className="sqd-cluster-card__stats">
                    {s.total > 0 ? (
                      <>
                        {s.queued  > 0 && <span className="is-cyan">{s.queued} queued</span>}
                        {s.sent    > 0 && <span className="is-green">{s.sent} sent</span>}
                        {s.blocked > 0 && <span className="is-red">{s.blocked} blocked</span>}
                        {s.failed  > 0 && <span className="is-amber">{s.failed} failed</span>}
                      </>
                    ) : (
                      <span className="sqd-cluster-card__idle">Eligible · No rows loaded</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Cluster strip (75% compact) ────────────────────────────────── */}
      {isOps && (
        <div className="sqd-section sqd-cluster-strip">
          <div className="sqd-section__head">
            <span className="sqd-section-eyebrow">Cluster Coverage</span>
          </div>
          <div className="sqd-cluster-chips">
            {SENDER_CLUSTERS.map(cluster => {
              const s = clusterStats[cluster.key] ?? { total: 0 }
              return (
                <div key={cluster.key} className={`sqd-cluster-chip${s.total > 0 ? ' is-live' : ''}`}>
                  <span className="sqd-cluster-chip__label">{cluster.label}</span>
                  <span className="sqd-cluster-chip__states">{cluster.states.join('·')}</span>
                  {s.total > 0
                    ? <span className="sqd-cluster-chip__count is-cyan">{s.total}</span>
                    : <span className="sqd-cluster-chip__count">0</span>}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── 6. Market Load ──────────────────────────────────────────────── */}
      <MarketLoadPanel
        marketLoad={marketLoad}
        activeFilter={marketFilter}
        onFilterChange={setMarketFilter}
        isOps={isOps}
      />

      {/* ── 7. Sender Number Health (full only) ─────────────────────────── */}
      {isFull && <SenderNumberHealthPanel items={items} />}

      {/* ── 8. Queue Row Inspector ──────────────────────────────────────── */}
      <QueueRowInspector
        items={filteredRows}
        totalItems={totalItems}
        searchQuery={searchQuery}
        statusFilter={statusFilter}
        marketFilter={marketFilter}
        allMarkets={allMarkets}
        failureFilter={failureFilter}
        hasFilters={hasFilters}
        selectedQueueId={selectedQueueId}
        onSelectItem={onSelectItem}
        onSearchChange={setSearchQuery}
        onStatusChange={setStatusFilter}
        onMarketChange={setMarketFilter}
        onClearFilters={clearFilters}
      />

      {/* ── 9. Recent Queue Events (full only) ──────────────────────────── */}
      {isFull && <RecentQueueEvents />}

      {/* ── Command Center Note ────────────────────────────────────────── */}
      <div className="sqd-cc-note">
        <span className="sqd-cc-note__icon">⌘</span>
        <span>Queue actions — Run Queue Once, Retry Failed Safe, Clear Stale Scheduled — live in the</span>
        <span className="sqd-cc-note__badge">Queue Command Center</span>
        <span>dropdown.</span>
      </div>
    </div>
  )
}
