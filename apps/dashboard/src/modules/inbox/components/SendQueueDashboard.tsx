import { useState, useMemo } from 'react'
import type { QueueItem, QueueModel } from '../../../lib/data/queueData'
import type { QueueCommandMode } from './QueueCommandCenter'
import type { QueueProcessorHealth } from '../../../lib/data/inboxData'
import type { ViewLayoutMode } from '../view-layout'
import '../send-queue-dashboard.css'

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

const truncate = (s: string, max: number) =>
  s.length > max ? s.slice(0, max) + '…' : s

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

interface StaticMarket { market: string; state: string; clusterKey: string; sender: string }

const STATIC_MARKETS: StaticMarket[] = [
  { market: 'Los Angeles',   state: 'CA', clusterKey: 'WEST_COAST',     sender: 'Los Angeles' },
  { market: 'Phoenix',       state: 'AZ', clusterKey: 'WEST_COAST',     sender: 'Los Angeles' },
  { market: 'Las Vegas',     state: 'NV', clusterKey: 'WEST_COAST',     sender: 'Los Angeles' },
  { market: 'Dallas',        state: 'TX', clusterKey: 'TEXAS_OK',       sender: 'Dallas' },
  { market: 'Houston',       state: 'TX', clusterKey: 'TEXAS_OK',       sender: 'Houston' },
  { market: 'Oklahoma City', state: 'OK', clusterKey: 'TEXAS_OK',       sender: 'Dallas' },
  { market: 'Atlanta',       state: 'GA', clusterKey: 'SOUTHEAST_EAST', sender: 'Atlanta' },
  { market: 'Charlotte',     state: 'NC', clusterKey: 'SOUTHEAST_EAST', sender: 'Charlotte' },
  { market: 'Jacksonville',  state: 'FL', clusterKey: 'SOUTHEAST_EAST', sender: 'Jacksonville' },
  { market: 'Miami',         state: 'FL', clusterKey: 'SOUTHEAST_EAST', sender: 'Miami' },
  { market: 'Minneapolis',   state: 'MN', clusterKey: 'MIDWEST',        sender: 'Minneapolis' },
  { market: 'Milwaukee',     state: 'WI', clusterKey: 'MIDWEST',        sender: 'Minneapolis' },
]

// ── Pipeline stages ───────────────────────────────────────────────────────────

type StageTone = 'blue' | 'cyan' | 'green' | 'amber' | 'red' | 'muted'

interface PipelineStage {
  key: string; label: string; statuses: string[]; tone: StageTone; historical?: boolean
}

const PIPELINE_STAGES: PipelineStage[] = [
  { key: 'approval',  label: 'Candidate', statuses: ['approval'],            tone: 'muted' },
  { key: 'queued',    label: 'Queued',    statuses: ['queued'],              tone: 'muted' },
  { key: 'scheduled', label: 'Scheduled', statuses: ['scheduled'],           tone: 'blue'  },
  { key: 'ready',     label: 'Ready',     statuses: ['ready'],               tone: 'cyan'  },
  { key: 'sending',   label: 'Sending',   statuses: ['sending'],             tone: 'blue'  },
  { key: 'sent',      label: 'Sent',      statuses: ['sent'],                tone: 'blue',  historical: true },
  { key: 'delivered', label: 'Delivered', statuses: ['delivered'],           tone: 'green', historical: true },
  { key: 'replied',   label: 'Replied',   statuses: ['replied_before_send'], tone: 'green', historical: true },
]

// ── Failure groups ────────────────────────────────────────────────────────────

type FailureGroupKey =
  | 'Carrier' | 'Compliance' | 'Routing' | 'Template'
  | 'Webhook' | 'Contact Window' | 'Duplicate' | 'Payload' | 'Unknown'

type FailureSeverity = 'red' | 'amber' | 'muted'

const FAILURE_META: Record<FailureGroupKey, { severity: FailureSeverity; desc: string }> = {
  Carrier:          { severity: 'red',   desc: 'TextGrid carrier rejection or delivery error.' },
  Compliance:       { severity: 'red',   desc: 'DNC conflict, opt-out, or suppression match.' },
  Routing:          { severity: 'red',   desc: 'No valid sender found for this market.' },
  Template:         { severity: 'amber', desc: 'Missing template, blank body, or variable error.' },
  Webhook:          { severity: 'amber', desc: 'TextGrid webhook error or callback failure.' },
  'Contact Window': { severity: 'amber', desc: 'Send outside allowed contact hours.' },
  Duplicate:        { severity: 'muted', desc: 'Duplicate row or active conversation conflict.' },
  Payload:          { severity: 'muted', desc: 'Sync error, missing payload field, or data issue.' },
  Unknown:          { severity: 'muted', desc: 'Uncategorized or unclassified failure.' },
}

const failureSeverity = (group: string | null): FailureSeverity =>
  FAILURE_META[group as FailureGroupKey]?.severity ?? 'muted'

// ── Launch checklist ──────────────────────────────────────────────────────────

const LAUNCH_CHECKLIST = [
  { id: 'senders', label: 'Confirm sender clusters are provisioned',        detail: 'TextGrid numbers active for each cluster sender city' },
  { id: 'routing', label: 'Verify routing coverage by state',               detail: 'All target states have a mapped sender or fallback tier' },
  { id: 'sellers', label: 'Load sellers into approved contact list',        detail: 'Contacts must pass compliance and suppression checks first' },
  { id: 'build',   label: 'Build outbound queue from Queue Command Center', detail: 'Use the dropdown → Run Safe Batch or outbound builder' },
  { id: 'mode',    label: 'Set Queue Mode to Safe or Live',                 detail: 'Safe = operator approval required; Live = automated send' },
]

// ── Rail metrics config (25% mode) ────────────────────────────────────────────

interface RailMetric { label: string; key: string; tone?: FailureSeverity | 'green' | 'cyan' | 'blue' | 'amber' }

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
}

export function SendQueueDashboard({
  queueModel,
  processorHealth,
  queueCommandMode,
  layoutMode = 'full',
  selectedQueueId = null,
  onSelectItem,
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

  // Pipeline counts — historical stages (Sent/Delivered/Replied) are time-windowed
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

  const failureTaxonomy = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of items) {
      if (item.status === 'failed' || item.status === 'retry' || item.status === 'blocked') {
        const g = item.failureGroup ?? 'Unknown'
        counts.set(g, (counts.get(g) ?? 0) + 1)
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([group, count]) => ({
        group, count,
        meta: FAILURE_META[group as FailureGroupKey] ?? { severity: 'muted' as const, desc: 'Unknown failure type.' },
      }))
  }, [items])

  const totalFailed  = failureTaxonomy.reduce((s, f) => s + f.count, 0)
  const maxFailCount = failureTaxonomy[0]?.count ?? 1

  const marketLoad = useMemo(() => {
    const map = new Map<string, { scheduled: number; ready: number; sent: number; failed: number; blocked: number; total: number }>()
    for (const item of items) {
      const m = item.market || 'Unknown'
      if (!map.has(m)) map.set(m, { scheduled: 0, ready: 0, sent: 0, failed: 0, blocked: 0, total: 0 })
      const e = map.get(m)!
      e.total++
      if (item.status === 'scheduled')                                e.scheduled++
      else if (item.status === 'ready')                               e.ready++
      else if (item.status === 'sent' || item.status === 'delivered') e.sent++
      else if (item.status === 'failed' || item.status === 'retry')   e.failed++
      else if (item.status === 'blocked' || item.status === 'held')   e.blocked++
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, isOps ? 8 : 12)
      .map(([market, c]) => ({ market, ...c }))
  }, [items, isOps])

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

  const filteredRows = useMemo((): QueueItem[] => {
    let result = items
    if (statusFilter !== 'all') {
      const stage = PIPELINE_STAGES.find(s => s.key === statusFilter)
      result = stage
        ? result.filter(i => stage.statuses.includes(i.status))
        : result.filter(i => i.status === statusFilter || (statusFilter === 'failed' && i.status === 'retry'))
    }
    if (marketFilter !== 'all') result = result.filter(i => (i.market || 'Unknown') === marketFilter)
    if (failureFilter)          result = result.filter(i => i.failureGroup === failureFilter)
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(i =>
        i.sellerName.toLowerCase().includes(q)      ||
        i.propertyAddress.toLowerCase().includes(q)  ||
        i.market.toLowerCase().includes(q)           ||
        i.templateName.toLowerCase().includes(q)     ||
        i.phone.includes(q),
      )
    }
    return result.slice(0, isStatus ? 30 : 60)
  }, [items, statusFilter, marketFilter, failureFilter, searchQuery, isStatus])

  const hasFilters  = statusFilter !== 'all' || marketFilter !== 'all' || !!failureFilter || !!searchQuery.trim()
  const clearFilters = () => { setStatusFilter('all'); setMarketFilter('all'); setFailureFilter(null); setSearchQuery('') }

  const health     = processorHealth?.status ?? 'unknown'
  const healthTone = health === 'healthy' ? 'green' : health === 'warning' ? 'amber' : health === 'critical' ? 'red' : 'muted'
  const modeTone   = queueCommandMode === 'live' ? 'green' : queueCommandMode === 'safe' ? 'blue' : 'muted'
  const modeLabel  = queueCommandMode === 'live' ? 'Live' : queueCommandMode === 'safe' ? 'Safe' : 'Off'
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
        {failureTaxonomy.length > 0 && (
          <div className="sqd-rail__blockers">
            <div className="sqd-rail__blockers-head">Top Failures</div>
            {failureTaxonomy.slice(0, 3).map(({ group, count, meta }) => (
              <div key={group} className="sqd-rail__blocker">
                <span className={`sqd-rail__blocker-dot is-${meta.severity}`} />
                <span className="sqd-rail__blocker-name">{group}</span>
                <span className={`sqd-rail__blocker-count is-${meta.severity}`}>{count}</span>
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

        {/* Empty state */}
        {isEmpty && (
          <div className="sqd-rail__empty">
            <span className="sqd-rail__empty-icon">⬡</span>
            <span className="sqd-rail__empty-label">No queue rows</span>
            <span className="sqd-rail__empty-hint">Build from Command Center</span>
          </div>
        )}

        {/* Loading */}
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
                    className={`sqd-stage sqd-stage--sm is-${stage.tone}${isActive ? ' is-active' : ''}${count === 0 ? ' is-zero' : ''}`}
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

        {/* Empty banner */}
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
        {failureTaxonomy.length > 0 && (
          <div className="sqd-section sqd-failure-strip">
            <div className="sqd-section__head">
              <span className="sqd-section-eyebrow">Failures</span>
              <span className="sqd-panel__count">{totalFailed} total</span>
              {failureFilter && (
                <button type="button" className="sqd-clear-chip" onClick={() => setFailureFilter(null)}>{failureFilter} ×</button>
              )}
            </div>
            <div className="sqd-failure-chips">
              {failureTaxonomy.map(({ group, count, meta }) => (
                <button
                  key={group}
                  type="button"
                  className={`sqd-failure-chip is-${meta.severity}${failureFilter === group ? ' is-active' : ''}`}
                  onClick={() => setFailureFilter(p => p === group ? null : group)}
                >
                  <span className={`sqd-failure-row__dot is-${meta.severity}`} />
                  <span>{group}</span>
                  <span className="sqd-failure-chip__count">{count}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Row inspector (compact columns) */}
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
                <option value="failed">Failed</option>
                <option value="blocked">Blocked</option>
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
                      <strong>{truncate(item.sellerName, 18)}</strong>
                      <small>{item.missingMessageEvent ? 'Sent queue row missing message event.' : (item.market || '—')}</small>
                    </div>
                    <span className="sqd-cell">{item.market || '—'}</span>
                    <span className="sqd-cell">
                      <span className={`sqd-status-pill sqd-status-pill--${item.status}`}>{item.status.replace(/_/g, ' ')}</span>
                    </span>
                    <span className="sqd-cell">
                      {item.failureGroup
                        ? <span className={`sqd-fail-pill is-${failureSeverity(item.failureGroup)}`}>{item.failureGroup}</span>
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

  // ── 75% — Operational Dashboard ───────────────────────────────────────────
  // ── 100% — Full Command Center ────────────────────────────────────────────
  return (
    <div className={`sqd sqd--${isOps ? 'ops' : 'full'}`}>

      {/* ── Queue Flow Pipeline ────────────────────────────────────────────── */}
      <div className="sqd-pipeline">
        <div className="sqd-pipeline__top">
          <div className="sqd-pipeline__inner">
            {PIPELINE_STAGES.map((stage, i) => {
              const count    = stageCounts[stage.key] ?? 0
              const isActive = statusFilter === stage.key
              return (
                <div key={stage.key} className="sqd-pipeline__step">
                  <button
                    type="button"
                    className={`sqd-stage is-${stage.tone}${isActive ? ' is-active' : ''}${count === 0 ? ' is-zero' : ''}`}
                    onClick={() => setStatusFilter(p => p === stage.key ? 'all' : stage.key)}
                    title={`Filter by ${stage.label}`}
                  >
                    <span className="sqd-stage__count">{count.toLocaleString()}</span>
                    <span className="sqd-stage__label">{stage.label}</span>
                    {stage.historical && <span className="sqd-stage__win" title="Time-windowed" />}
                  </button>
                  {i < PIPELINE_STAGES.length - 1 && <span className="sqd-pipeline__arrow">›</span>}
                </div>
              )
            })}
          </div>
          <div className="sqd-window-tabs">
            {(['today', '24h', '7d'] as const).map(w => (
              <button
                key={w}
                type="button"
                className={`sqd-window-tab${timeWindow === w ? ' is-active' : ''}`}
                onClick={() => setTimeWindow(w)}
              >
                {w === 'today' ? 'Today' : w === '24h' ? 'Last 24h' : 'Last 7d'}
              </button>
            ))}
          </div>
        </div>
        <div className="sqd-pipeline__footer">
          {isLoading
            ? <span className="sqd-pipeline__loading"><span className="sqd-spinner sqd-spinner--sm" />Loading queue data…</span>
            : <span>{totalItems.toLocaleString()} rows loaded</span>
          }
          {processorHealth?.checkedAt && (
            <span className="sqd-pipeline__checked">Last checked {relTime(processorHealth.checkedAt)}</span>
          )}
        </div>
      </div>

      {/* ── Empty State Banner ─────────────────────────────────────────────── */}
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

      {/* ── Health Summary Row ─────────────────────────────────────────────── */}
      <div className="sqd-health-row">
        <div className={`sqd-hcard sqd-hcard--status is-${healthTone}`}>
          <div className={`sqd-hcard__dot is-${healthTone}`} />
          <span className="sqd-hcard__label">Queue Health</span>
          <strong className="sqd-hcard__value">
            {health === 'healthy' ? 'Healthy' : health === 'warning' ? 'Warning' : health === 'critical' ? 'Critical' : 'Unknown'}
          </strong>
        </div>
        <div className={`sqd-hcard is-${modeTone}`}>
          <span className="sqd-hcard__label">System Mode</span>
          <strong className="sqd-hcard__value">{queueCommandMode === 'live' ? 'Live Autopilot' : queueCommandMode === 'safe' ? 'Safe Autopilot' : 'Off'}</strong>
        </div>
        <div className="sqd-hcard">
          <span className="sqd-hcard__label">Ready to Send</span>
          <strong className={`sqd-hcard__value${(queueModel?.readyCount ?? 0) > 0 ? ' is-cyan' : ''}`}>{queueModel?.readyCount ?? '—'}</strong>
        </div>
        <div className="sqd-hcard">
          <span className="sqd-hcard__label">Scheduled</span>
          <strong className="sqd-hcard__value is-blue">{queueModel?.scheduledCount ?? '—'}</strong>
        </div>
        <div className="sqd-hcard">
          <span className="sqd-hcard__label">Sent Today</span>
          <strong className={`sqd-hcard__value${(queueModel?.sentTodayCount ?? 0) > 0 ? ' is-green' : ''}`}>{queueModel?.sentTodayCount ?? '—'}</strong>
        </div>
        <div className="sqd-hcard">
          <span className="sqd-hcard__label">Delivered Today</span>
          <strong className={`sqd-hcard__value${(queueModel?.deliveredTodayCount ?? 0) > 0 ? ' is-green' : ''}`}>{queueModel?.deliveredTodayCount ?? '—'}</strong>
        </div>
        <div className="sqd-hcard">
          <span className="sqd-hcard__label">Failed Today</span>
          <strong className={`sqd-hcard__value${healthMetrics.failedToday > 0 ? ' is-red' : ''}`}>{healthMetrics.failedToday}</strong>
        </div>
        <div className="sqd-hcard">
          <span className="sqd-hcard__label">Routing Blocked</span>
          <strong className={`sqd-hcard__value${healthMetrics.routingBlocked > 0 ? ' is-amber' : ''}`}>{healthMetrics.routingBlocked}</strong>
        </div>
        <div className="sqd-hcard">
          <span className="sqd-hcard__label">Needs Review</span>
          <strong className={`sqd-hcard__value${healthMetrics.needsReview > 0 ? ' is-amber' : ''}`}>{healthMetrics.needsReview}</strong>
        </div>
        <div className="sqd-hcard">
          <span className="sqd-hcard__label">Webhook</span>
          <strong className={`sqd-hcard__value${healthMetrics.webhookHealthy ? ' is-green' : ' is-red'}`}>
            {healthMetrics.webhookHealthy ? 'OK' : 'Error'}
          </strong>
        </div>
      </div>

      {/* ── Diagnostic Panels ─────────────────────────────────────────────── */}
      <div className={`sqd-diag-row${isOps ? ' sqd-diag-row--two' : ''}`}>

        {/* Failure Taxonomy */}
        <div className="sqd-panel">
          <div className="sqd-panel__head">
            <span className="sqd-panel__eyebrow">Failure Taxonomy</span>
            {totalFailed > 0 && <span className="sqd-panel__count">{totalFailed} total</span>}
            {failureFilter && (
              <button type="button" className="sqd-clear-chip" onClick={() => setFailureFilter(null)}>{failureFilter} ×</button>
            )}
          </div>
          {failureTaxonomy.length === 0 ? (
            <div className="sqd-empty">
              <span className="sqd-empty__icon">✓</span>
              <span>{isEmpty ? 'No rows in queue' : 'No failures in current window'}</span>
            </div>
          ) : (
            <div className="sqd-failure-list">
              {failureTaxonomy.map(({ group, count, meta }) => (
                <button
                  key={group}
                  type="button"
                  className={`sqd-failure-row is-${meta.severity}${failureFilter === group ? ' is-active' : ''}`}
                  onClick={() => setFailureFilter(p => p === group ? null : group)}
                >
                  <div className="sqd-failure-row__left">
                    <span className={`sqd-failure-row__dot is-${meta.severity}`} />
                    <span className="sqd-failure-row__name">{group}</span>
                  </div>
                  <div className="sqd-failure-row__bar-wrap">
                    <div className={`sqd-failure-row__bar is-${meta.severity}`} style={{ width: `${Math.max(4, (count / maxFailCount) * 100)}%` }} />
                  </div>
                  <span className="sqd-failure-row__count">{count}</span>
                  <p className="sqd-failure-row__desc">{meta.desc}</p>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Routing Coverage */}
        <div className="sqd-panel">
          <div className="sqd-panel__head">
            <span className="sqd-panel__eyebrow">Routing Coverage</span>
          </div>
          <div className="sqd-rmetrics">
            <div className="sqd-rmetric">
              <span className="sqd-rmetric__label">Markets w/ Senders</span>
              <strong className="sqd-rmetric__val is-green">{routingCoverage.marketsWithSenders}</strong>
            </div>
            <div className="sqd-rmetric">
              <span className="sqd-rmetric__label">Markets Blocked</span>
              <strong className={`sqd-rmetric__val${routingCoverage.marketsBlocked > 0 ? ' is-red' : ''}`}>{routingCoverage.marketsBlocked}</strong>
            </div>
            <div className="sqd-rmetric">
              <span className="sqd-rmetric__label">Routing Blocked</span>
              <strong className={`sqd-rmetric__val${routingCoverage.routingBlockedTotal > 0 ? ' is-amber' : ''}`}>{routingCoverage.routingBlockedTotal}</strong>
            </div>
          </div>
          <div className="sqd-tier-bars">
            {[
              { label: 'Tier 1  Exact match', count: routingCoverage.tier1Count, pct: routingCoverage.tier1Pct, tone: 'green' },
              { label: 'Tier 2  Same state',  count: routingCoverage.tier2Count, pct: routingCoverage.tier2Pct, tone: 'blue'  },
              { label: 'Tier 3  Cluster',     count: routingCoverage.tier3Count, pct: routingCoverage.tier3Pct, tone: 'amber' },
              { label: 'Tier 4  Blocked',     count: routingCoverage.tier4Count, pct: routingCoverage.tier4Pct, tone: 'red'   },
            ].map(({ label, count, pct, tone }) => (
              <div key={label} className="sqd-tier-bar">
                <span className="sqd-tier-bar__label">{label}</span>
                <div className="sqd-tier-bar__track">
                  <div className={`sqd-tier-bar__fill is-${tone}`} style={{ width: `${Math.max(pct, 1)}%` }} />
                </div>
                <span className="sqd-tier-bar__n">{count}</span>
                <span className="sqd-tier-bar__pct">{pct}%</span>
              </div>
            ))}
          </div>
          {routingCoverage.sendersByMarket.length > 0 && (
            <div className="sqd-sender-table">
              {routingCoverage.sendersByMarket.map(({ market, senderCount, blocked }) => (
                <div key={market} className="sqd-sender-row">
                  <span className="sqd-sender-row__market">{market}</span>
                  <span className="sqd-sender-row__senders">{senderCount} sender{senderCount !== 1 ? 's' : ''}</span>
                  {blocked > 0 && <span className="sqd-sender-row__blocked">{blocked} blocked</span>}
                </div>
              ))}
            </div>
          )}
          {routingBlockedRows.length > 0 && (
            <div className="sqd-routing-blocked">
              <div className="sqd-routing-blocked__head">Blocked Rows</div>
              {routingBlockedRows.slice(0, 4).map(row => (
                <div key={row.id} className="sqd-routing-blocked__row">
                  <span>{truncate(row.sellerName, 18)}</span>
                  <span className="sqd-routing-blocked__market">{row.market}</span>
                  <span className="sqd-routing-blocked__reason">{truncate(row.reason, 22)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Template Coverage — full only */}
        {isFull && (
          <div className="sqd-panel">
            <div className="sqd-panel__head">
              <span className="sqd-panel__eyebrow">Template Coverage</span>
            </div>
            <div className="sqd-rmetrics">
              <div className="sqd-rmetric">
                <span className="sqd-rmetric__label">Missing Template</span>
                <strong className={`sqd-rmetric__val${templateCoverage.missingTemplate > 0 ? ' is-amber' : ''}`}>{templateCoverage.missingTemplate}</strong>
              </div>
              <div className="sqd-rmetric">
                <span className="sqd-rmetric__label">Blank Body</span>
                <strong className={`sqd-rmetric__val${templateCoverage.blankBody > 0 ? ' is-red' : ''}`}>{templateCoverage.blankBody}</strong>
              </div>
            </div>
            <div className="sqd-template-list">
              {templateCoverage.topTemplates.length === 0 ? (
                <div className="sqd-empty">
                  <span className="sqd-empty__icon">—</span>
                  <span>{isEmpty ? 'No templates in queue' : 'No template data'}</span>
                </div>
              ) : templateCoverage.topTemplates.map(({ name, count, failCount }) => {
                const maxCount = templateCoverage.topTemplates[0]?.count ?? 1
                return (
                  <div key={name} className="sqd-template-row">
                    <span className="sqd-template-row__name" title={name}>{truncate(name, 26)}</span>
                    <div className="sqd-template-row__bar-wrap">
                      <div className="sqd-template-row__bar" style={{ width: `${Math.max(4, (count / maxCount) * 100)}%` }} />
                    </div>
                    <span className="sqd-template-row__count">{count}</span>
                    {failCount > 0 && <span className="sqd-template-row__fail">{failCount} fail</span>}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── Cluster Routing (full only) ────────────────────────────────────── */}
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

      {/* ── Ops cluster summary (75% — compact version) ───────────────────── */}
      {isOps && (
        <div className="sqd-section sqd-cluster-strip">
          <div className="sqd-section__head">
            <span className="sqd-section-eyebrow">Cluster Coverage</span>
          </div>
          <div className="sqd-cluster-chips">
            {SENDER_CLUSTERS.map(cluster => {
              const s = clusterStats[cluster.key] ?? { queued: 0, sent: 0, blocked: 0, failed: 0, total: 0 }
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

      {/* ── Market Load ────────────────────────────────────────────────────── */}
      <div className="sqd-section">
        <div className="sqd-section__head">
          <span className="sqd-section-eyebrow">Market Load</span>
          {marketFilter !== 'all' && (
            <button type="button" className="sqd-clear-chip" onClick={() => setMarketFilter('all')}>{marketFilter} ×</button>
          )}
        </div>
        {marketLoad.length > 0 ? (
          <div className={`sqd-market-grid${isOps ? ' sqd-market-grid--compact' : ''}`}>
            {marketLoad.map(({ market, scheduled, ready, sent, failed, blocked, total }) => (
              <button
                key={market}
                type="button"
                className={`sqd-market-card${marketFilter === market ? ' is-active' : ''}`}
                onClick={() => setMarketFilter(p => p === market ? 'all' : market)}
              >
                <span className="sqd-market-card__name">{market}</span>
                <div className="sqd-market-card__stats">
                  {ready > 0     && <span className="is-cyan">{ready} ready</span>}
                  {scheduled > 0 && <span className="is-blue">{scheduled} sched</span>}
                  {sent > 0      && <span className="is-green">{sent} sent</span>}
                  {failed > 0    && <span className="is-red">{failed} fail</span>}
                  {blocked > 0   && <span className="is-amber">{blocked} blkd</span>}
                </div>
                <span className="sqd-market-card__total">{total}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="sqd-mct">
            <div className="sqd-mct__head">
              <span>Market</span><span>State</span><span>Sender</span><span>Cluster</span><span>Queue Eligible</span>
            </div>
            {STATIC_MARKETS.map(m => {
              const cluster = SENDER_CLUSTERS.find(c => c.key === m.clusterKey)
              return (
                <div key={`${m.market}-${m.state}`} className="sqd-mct__row">
                  <span className="sqd-mct__market">{m.market}</span>
                  <span className="sqd-mct__state">{m.state}</span>
                  <span className="sqd-mct__sender">{m.sender}</span>
                  <span className="sqd-mct__cluster">{cluster?.label ?? m.clusterKey}</span>
                  <span className="sqd-mct__eligible">✓ Ready</span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Queue Row Inspector ────────────────────────────────────────────── */}
      <div className="sqd-section sqd-inspector">
        <div className="sqd-inspector__controls">
          <span className="sqd-section-eyebrow">Queue Row Inspector</span>
          <div className="sqd-inspector__filter-row">
            <input
              type="search"
              className="sqd-search"
              placeholder="Search seller, address, market, template…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            <select className="sqd-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="all">All Statuses</option>
              {PIPELINE_STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              <option value="failed">Failed / Retry</option>
              <option value="held">Held</option>
              <option value="blocked">Blocked</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <select className="sqd-select" value={marketFilter} onChange={e => setMarketFilter(e.target.value)}>
              <option value="all">All Markets</option>
              {allMarkets.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            {hasFilters && <button type="button" className="sqd-clear-btn" onClick={clearFilters}>Clear all</button>}
          </div>
          <span className="sqd-inspector__count">
            {filteredRows.length.toLocaleString()} of {totalItems.toLocaleString()} rows
            {failureFilter && ` · ${failureFilter} failures`}
          </span>
        </div>

        {isEmpty && !hasFilters ? (
          <div className="sqd-launch-checklist">
            <div className="sqd-launch-checklist__head">Launch Checklist</div>
            {LAUNCH_CHECKLIST.map(item => (
              <div key={item.id} className="sqd-checklist-item">
                <span className="sqd-checklist-item__box" />
                <div className="sqd-checklist-item__body">
                  <span className="sqd-checklist-item__label">{item.label}</span>
                  <span className="sqd-checklist-item__detail">{item.detail}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="sqd-table">
            <div className="sqd-table__head">
              <span>Seller / Property</span>
              <span>Market</span>
              <span>Status</span>
              <span>Template</span>
              <span>From</span>
              <span>To</span>
              <span>Scheduled</span>
              <span>Failure</span>
            </div>
            <div className="sqd-table__body">
              {filteredRows.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={[
                    'sqd-table__row',
                    `sqd-table__row--${item.status}`,
                    onSelectItem ? 'is-linked' : '',
                    selectedQueueId === item.queueId ? 'is-selected' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => onSelectItem?.(item)}
                  title={onSelectItem ? 'Click to inspect queue context' : undefined}
                >
                  <div className="sqd-cell sqd-cell--seller">
                    <strong>{truncate(item.sellerName, 20)}</strong>
                    <small>{item.missingMessageEvent ? 'Sent queue row missing message event.' : truncate(item.propertyAddress, 24)}</small>
                  </div>
                  <span className="sqd-cell">{item.market || '—'}</span>
                  <span className="sqd-cell">
                    <span className={`sqd-status-pill sqd-status-pill--${item.status}`}>{item.status.replace(/_/g, ' ')}</span>
                  </span>
                  <span className="sqd-cell sqd-cell--dim">{truncate(item.templateName || '—', 22)}</span>
                  <span className="sqd-cell sqd-cell--mono">{item.textgridNumber ? `…${item.textgridNumber.slice(-4)}` : '—'}</span>
                  <span className="sqd-cell sqd-cell--mono">{item.phone ? `…${item.phone.slice(-4)}` : '—'}</span>
                  <span className="sqd-cell sqd-cell--time">{relTime(item.scheduledForLocal)}</span>
                  <span className="sqd-cell">
                    {item.failureGroup
                      ? <span className={`sqd-fail-pill is-${failureSeverity(item.failureGroup)}`}>{item.failureGroup}</span>
                      : '—'}
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

      {/* ── Command Center Note ────────────────────────────────────────────── */}
      <div className="sqd-cc-note">
        <span className="sqd-cc-note__icon">⌘</span>
        <span>Queue actions — Run Safe Batch, Retry Failed, Cancel Stale — live in the</span>
        <span className="sqd-cc-note__badge">Queue Command Center</span>
        <span>dropdown.</span>
      </div>
    </div>
  )
}
