import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { getSupabaseClient } from '../../lib/supabaseClient'
import {
  fetchQueueModel,
  approveQueueItem,
  holdQueueItem,
  rescheduleQueueItem,
  retryQueueItem,
  cancelQueueItem,
  retryRoutingForItem,
  retryAllFailed,
  runQueueOnce,
} from '../../lib/data/queueData'
import { shouldUseSupabase } from '../../lib/data/shared'
import { adaptQueueModel } from './queue.adapter'
import type { QueueModel, QueueItem, QueueFetchOptions, QueueDateBasis, ConfiguredMarket } from '../../domain/queue/queue.types'
import { STAGE_LABELS } from '../../domain/queue/queue.types'
import { FAILURE_LABEL } from '../../domain/queue/classifyFailure'
import { Icon } from '../../shared/icons'
import { resolveAssetTypeIcon } from '../../shared/asset-type-icons'
import { formatRelativeTime } from '../../shared/formatters'
import { emitNotification } from '../../shared/NotificationToast'
import { buildContextFromQueueItem, type ActiveInboxContext } from '../../modules/inbox/active-context'
import {
  findQueueItemForActiveContext,
  queueItemMatchesActiveContext,
} from '../../domain/entity-graph/universal-sync'
import { CommandIntelligenceDock } from './components/CommandIntelligenceDock'
import { FailureCommandHeader } from './components/FailureCommandHeader'
import { MarketHealthOverview } from './components/MarketHealthOverview'
import { QueueBulkActionDock } from './components/QueueBulkActionDock'
import { QueueConfirmModal } from './components/QueueConfirmModal'
import { QueueExceptionBadges } from './components/QueueExceptionBadges'
import { QueueInlineFlow } from './components/QueueInlineFlow'
import { SenderFleetOverview } from './components/SenderFleetOverview'
import { TemplateIntelligenceModule } from './components/templates/TemplateIntelligenceModule'
import './components/templates/template-intelligence.css'
import { useQueueLayout } from './hooks/useQueueLayout'
import {
  BLOCKED_STATUSES,
  buildBulkActionPreview,
  buildExceptionsCenter,
  buildSelectionPreview,
  displayName,
  isDelivered,
  isFailed,
  isSent,
  isManualMessage,
  isNonRetryableRow,
  pct,
  resolveMessageSource,
  resolveSellerIdentity,
  resolveStatusPresentation,
  resolveTemplateLabel,
  templateHealthWithSample,
  type BulkActionPreview,
  type QueueDensity,
  type QueueSection,
} from './queue-ui-helpers'
import '../../modules/inbox/queue-ops.css'

// ── Helpers ────────────────────────────────────────────────────────────────

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

const truncate = (s: string | null | undefined, max: number) =>
  !s ? '—' : s.length > max ? s.slice(0, max) + '…' : s

const relTime = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

const fmtPhone = (p: string | null | undefined) =>
  p ? `…${p.slice(-4)}` : '—'

// ── Stage + name helpers (Phase 3 / Phase 5) ────────────────────────────────

const resolveStageLabel = (item: QueueItem): string =>
  item.stageLabel ?? (item.stageCode ? STAGE_LABELS[item.stageCode] : '—')

const STAGE_TONE: Record<string, string> = {
  S1: 'blue', S2: 'cyan', S3: 'violet', S4: 'amber', S5: 'green',
  manual_reply: 'muted', auto_reply: 'teal',
}

// ── Date filter ────────────────────────────────────────────────────────────

type DatePreset = 'today' | '24h' | '7d' | '30d' | '90d' | 'all' | 'custom'

const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  today: 'Today', '24h': 'Last 24h', '7d': 'Last 7d', '30d': 'Last 30d',
  '90d': 'Last 90d', all: 'All time', custom: 'Custom',
}

const PAGE_SIZE_OPTIONS = [25, 50, 100, 250] as const

function getPresetRange(preset: Exclude<DatePreset, 'custom' | 'all'>): { from: string; to: string } {
  const now = new Date()
  const to = now.toISOString()
  if (preset === 'today') {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
    return { from, to }
  }
  const ms = preset === '24h' ? 86400000
    : preset === '7d' ? 7 * 86400000
    : preset === '90d' ? 90 * 86400000
    : 30 * 86400000
  return { from: new Date(now.getTime() - ms).toISOString(), to }
}

interface FetchContext {
  preset: DatePreset
  customFrom: string
  customTo: string
  dateBasis: QueueDateBasis
  status: StatusBucket
  page: number
  pageSize: number
}

function buildFetchOptions(ctx: FetchContext): QueueFetchOptions {
  const { preset, customFrom, customTo, dateBasis, status, page, pageSize } = ctx
  // 'all' omits the date window entirely so the full send_queue history
  // (every one of the ~12,832 rows) is reachable via pagination.
  const range = preset === 'all'
    ? { from: undefined, to: undefined }
    : preset === 'custom'
      ? {
          from: customFrom || new Date(Date.now() - 7 * 86400000).toISOString(),
          to: customTo || new Date().toISOString(),
        }
      : getPresetRange(preset)
  return {
    dateFrom: range.from,
    dateTo: range.to,
    dateBasis,
    status: status === 'all' ? undefined : status,
    page,
    pageSize,
  }
}

const DATE_BASIS_LABELS: Record<QueueDateBasis, string> = {
  created_at: 'Created',
  scheduled_for: 'Scheduled',
  updated_at: 'Updated',
}

// ── Status constants ───────────────────────────────────────────────────────

type StatusBucket = 'all' | 'scheduled' | 'queued' | 'sending' | 'failed' | 'blocked' | 'approval' | 'delivered' | 'sent'

const FAILURE_TONE: Record<string, string> = {
  Carrier: 'red', Compliance: 'red', Routing: 'amber',
  Template: 'amber', Payload: 'amber', Webhook: 'amber',
}

const HEALTH_TONE: Record<string, string> = {
  healthy: 'green', watch: 'amber', degraded: 'amber', critical: 'red',
}

function healthFromPct(failRate: number): 'healthy' | 'watch' | 'degraded' | 'critical' {
  if (failRate >= 30) return 'critical'
  if (failRate >= 15) return 'degraded'
  if (failRate >= 5) return 'watch'
  return 'healthy'
}

// ── Template stats ─────────────────────────────────────────────────────────

interface TemplateStat {
  id: string
  name: string
  usage: number
  sent: number
  delivered: number
  failed: number
  blocked: number
  optOuts: number
  violations21610: number
  deliveryPct: number
  failPct: number
  health: 'healthy' | 'watch' | 'degraded' | 'critical' | 'insufficient'
  healthLabel: string
  // Dossier detail (loaded page/range scope)
  stageLabel: string | null
  useCase: string
  language: string
  sampleBody: string
  markets: string[]
  senders: string[]
  firstSeen: string | null
  lastSeen: string | null
}

function buildTemplateStats(items: QueueItem[]): TemplateStat[] {
  const detail = new Map<string, { markets: Set<string>; senders: Set<string> }>()
  const map = new Map<string, TemplateStat>()
  for (const i of items) {
    const manual = isManualMessage(i)
    const id = manual ? 'manual-reply' : (i.templateId ?? i.selectedTemplateId ?? 'no-template')
    const name = manual ? 'Manual Reply' : (i.templateName || 'No Template')
    const s = map.get(id) ?? {
      id, name, usage: 0, sent: 0, delivered: 0, failed: 0, blocked: 0, optOuts: 0,
      violations21610: 0, deliveryPct: 0, failPct: 0, health: 'healthy', healthLabel: 'Healthy',
      stageLabel: null, useCase: '', language: '', sampleBody: '',
      markets: [], senders: [], firstSeen: null, lastSeen: null,
    }
    const d = detail.get(id) ?? { markets: new Set<string>(), senders: new Set<string>() }
    s.usage++
    if (isSent(i.status)) s.sent++
    if (isDelivered(i.status)) s.delivered++
    if (isFailed(i.status)) s.failed++
    if (BLOCKED_STATUSES.has(i.status)) s.blocked++
    if (i.failureCategory === 'recipient_opted_out' || i.failureCategory === 'blacklist_pair_21610') s.optOuts++
    if (i.failureCategory === 'blacklist_pair_21610') s.violations21610++
    if (i.market && i.market !== 'Market unknown') d.markets.add(i.market)
    if (i.fromPhoneNumber) d.senders.add(i.fromPhoneNumber)
    if (!s.stageLabel && (i.stageLabel || i.stageCode)) s.stageLabel = i.stageLabel ?? (i.stageCode ? STAGE_LABELS[i.stageCode] : null)
    if (!s.useCase && i.useCase) s.useCase = i.useCase
    if (!s.language && i.language) s.language = i.language
    if (!s.sampleBody && i.messageText?.trim()) s.sampleBody = i.messageText.trim()
    const ts = i.updatedAt || i.createdAt
    if (ts) {
      if (!s.firstSeen || ts < s.firstSeen) s.firstSeen = ts
      if (!s.lastSeen || ts > s.lastSeen) s.lastSeen = ts
    }
    map.set(id, s)
    detail.set(id, d)
  }
  return Array.from(map.values()).map(s => {
    const d = detail.get(s.id)
    s.markets = d ? Array.from(d.markets).sort() : []
    s.senders = d ? Array.from(d.senders) : []
    // sent is the dispatched superset → delivered/failed are subsets of it.
    s.deliveryPct = pct(s.delivered, s.sent)
    s.failPct = pct(s.failed, s.sent)
    const sample = templateHealthWithSample(s.sent, s.failPct)
    s.health = sample.health === 'insufficient' ? 'insufficient' : sample.health
    s.healthLabel = sample.label
    ;(s as TemplateStat & { healthReason?: string }).healthReason = sample.health === 'insufficient'
      ? `Low sample (n=${s.sent}) — health not rated elite`
      : `${sample.label} — ${s.failPct}% failure over ${s.sent} sends`
    return s
  }).sort((a, b) => b.usage - a.usage)
}

// ── Sender (TextGrid) stats ────────────────────────────────────────────────

interface SenderStat {
  phone: string
  market: string
  sent: number
  delivered: number
  failed: number
  blocked: number
  optOuts: number
  violations21610: number
  deliveryPct: number
  failPct: number
  health: 'healthy' | 'watch' | 'degraded' | 'critical' | 'blocked'
  performanceLabel: string
  operationalLabel: string
  lastUsed: string | null
  state: 'active' | 'paused' | 'degraded' | 'blocked' | 'unregistered'
}

function buildSenderStats(items: QueueItem[]): SenderStat[] {
  const map = new Map<string, SenderStat>()
  for (const i of items) {
    const phone = i.fromPhoneNumber || 'unknown'
    if (phone === 'unknown') continue
    const s = map.get(phone) ?? {
      phone, market: i.market || '—', sent: 0, delivered: 0, failed: 0, blocked: 0,
      optOuts: 0, violations21610: 0, deliveryPct: 0, failPct: 0,
      health: 'healthy' as const, performanceLabel: 'Performance: —', operationalLabel: 'Routing available',
      lastUsed: null, state: 'active' as const,
    }
    if (isSent(i.status)) s.sent++
    if (isDelivered(i.status)) s.delivered++
    if (isFailed(i.status)) s.failed++
    if (BLOCKED_STATUSES.has(i.status)) s.blocked++
    if (i.failureCategory === 'recipient_opted_out') s.optOuts++
    if (i.failureCategory === 'blacklist_pair_21610') s.violations21610++
    const ts = i.lastEventAt || i.sentAt || i.updatedAt
    if (ts && (!s.lastUsed || ts > s.lastUsed)) s.lastUsed = ts
    if (!s.market || s.market === '—') s.market = i.market || '—'
    map.set(phone, s)
  }
  return Array.from(map.values()).map(s => {
    s.deliveryPct = pct(s.delivered, s.sent)
    s.failPct = pct(s.failed, s.sent)
    const hasActive = items.some(i => i.fromPhoneNumber === s.phone && ['scheduled', 'queued', 'ready', 'sending'].includes(i.status))
    s.state = s.violations21610 > 0 ? 'blocked' : s.sent === 0 ? 'unregistered' : hasActive ? 'active' : 'paused'
    s.health = s.violations21610 > 0 ? 'blocked' : healthFromPct(s.failPct)
    s.performanceLabel = `Performance: ${s.deliveryPct}% delivered`
    s.operationalLabel = s.state === 'active' ? 'Routing available'
      : s.state === 'paused' ? 'Current routing: unavailable'
      : s.state === 'blocked' ? 'Blocked — compliance hold'
      : 'Unregistered in range'
    return s
  }).sort((a, b) => (b.sent + b.delivered) - (a.sent + a.delivered))
}

// ── Market stats ───────────────────────────────────────────────────────────

interface MarketStat {
  market: string
  total: number
  sent: number
  delivered: number
  failed: number
  blocked: number
  optOuts: number
  deliveryPct: number
  health: 'healthy' | 'watch' | 'degraded' | 'critical' | 'idle'
  performanceHealth: string
  senderReadiness: string
  suggestedAction: string
  exceptionCount: number
  configured: boolean
  senderExists: boolean
  active: boolean
}

function buildMarketStats(items: QueueItem[], directory: ConfiguredMarket[] = []): MarketStat[] {
  const map = new Map<string, MarketStat>()
  const make = (m: string): MarketStat => ({
    market: m, total: 0, sent: 0, delivered: 0, failed: 0, blocked: 0, optOuts: 0,
    deliveryPct: 0, health: 'healthy', performanceHealth: 'idle', senderReadiness: 'No registered sender',
    suggestedAction: 'Register an active sender for this market', exceptionCount: 0,
    configured: false, senderExists: false, active: false,
  })

  // Seed every configured market so zero-row markets still render.
  for (const d of directory) {
    const s = make(d.market)
    s.configured = true
    s.senderExists = d.senderCount > 0
    s.active = d.active
    map.set(d.market, s)
  }

  for (const i of items) {
    const m = i.market || 'Unknown'
    const s = map.get(m) ?? make(m)
    s.total++
    if (isSent(i.status)) s.sent++
    if (isDelivered(i.status)) s.delivered++
    if (isFailed(i.status)) s.failed++
    if (BLOCKED_STATUSES.has(i.status)) s.blocked++
    if (i.failureCategory === 'recipient_opted_out' || i.failureCategory === 'blacklist_pair_21610') s.optOuts++
    map.set(m, s)
  }
  return Array.from(map.values()).map(s => {
    s.deliveryPct = pct(s.delivered, s.sent)
    const failHealth = healthFromPct(pct(s.failed, s.sent))
    s.performanceHealth = s.total === 0 ? 'idle' : failHealth
    s.senderReadiness = !s.senderExists ? 'No registered sender' : s.active ? 'Ready' : 'Paused sender'
    s.exceptionCount = items.filter(i => i.market === s.market && (isFailed(i.status) || BLOCKED_STATUSES.has(i.status))).length
    if (!s.senderExists) {
      s.health = 'critical'
      s.suggestedAction = 'Assign and activate a TextGrid sender'
    } else if (!s.active && s.total > 0) {
      s.health = failHealth === 'healthy' ? 'watch' : failHealth
      s.suggestedAction = 'Resume sender or reroute queue rows'
    } else {
      s.health = s.total === 0 ? 'idle' : failHealth
      s.suggestedAction = s.exceptionCount > 0 ? 'Review market exceptions in Failure Taxonomy' : 'No action required'
    }
    return s
  }).sort((a, b) => b.total - a.total || a.market.localeCompare(b.market))
}

// ── KPI Card ────────────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string
  value: number | string
  tone?: string
  onClick?: () => void
  active?: boolean
  sub?: string
  loading?: boolean
}

const KpiCard = ({ label, value, tone, onClick, active, sub, loading }: KpiCardProps) => (
  <button
    type="button"
    className={cls('occ-kpi', tone && `is-${tone}`, active && 'is-active', onClick && 'is-clickable', loading && 'is-loading')}
    onClick={onClick}
    disabled={!onClick || loading}
  >
    <span className={cls('occ-kpi__value', loading && 'is-pending')}>{loading ? '—' : value}</span>
    <span className="occ-kpi__label">{label}</span>
    {sub && <span className="occ-kpi__sub">{sub}</span>}
  </button>
)

// ── Date Filter ─────────────────────────────────────────────────────────────

const DateFilter = ({
  preset,
  customFrom,
  customTo,
  onPreset,
  onCustomFrom,
  onCustomTo,
}: {
  preset: DatePreset
  customFrom: string
  customTo: string
  onPreset: (p: DatePreset) => void
  onCustomFrom: (v: string) => void
  onCustomTo: (v: string) => void
}) => {
  return (
    <div className="occ-date-filter">
      <div className="occ-date-presets">
        {(['today', '24h', '7d', '30d', '90d', 'all', 'custom'] as DatePreset[]).map(p => (
          <button
            key={p}
            type="button"
            className={cls('occ-date-btn', preset === p && 'is-active')}
            onClick={() => onPreset(p)}
          >
            {DATE_PRESET_LABELS[p]}
          </button>
        ))}
      </div>
      {preset === 'custom' && (
        <div className="occ-date-custom">
          <input
            type="datetime-local"
            className="occ-date-input"
            value={customFrom ? customFrom.slice(0, 16) : ''}
            onChange={e => onCustomFrom(e.target.value ? new Date(e.target.value).toISOString() : '')}
          />
          <span className="occ-date-sep">→</span>
          <input
            type="datetime-local"
            className="occ-date-input"
            value={customTo ? customTo.slice(0, 16) : ''}
            onChange={e => onCustomTo(e.target.value ? new Date(e.target.value).toISOString() : '')}
          />
        </div>
      )}
    </div>
  )
}

// ── Inspector Row ───────────────────────────────────────────────────────────

const InspRow = ({ label, value, tone, mono }: { label: string; value: React.ReactNode; tone?: string; mono?: boolean }) => (
  <div className="occ-insp-row">
    <span className="occ-insp-label">{label}</span>
    <span className={cls('occ-insp-value', tone && `is-${tone}`, mono && 'occ-mono')}>{value || '—'}</span>
  </div>
)

// ── Hero Inspector (row dossier) ────────────────────────────────────────────

const _HeroInspector = ({
  item,
  onAction,
}: {
  item: QueueItem | null
  onAction: (action: string, id: string) => void
}) => {
  if (!item) return null
  const identity = resolveSellerIdentity(item)
  const statusView = resolveStatusPresentation(item)
  const failLabel = item.failureCategory ? (FAILURE_LABEL[item.failureCategory] ?? item.failureCategory.replace(/_/g, ' ')) : null
  const originLabel = item.automationSource || item.rowSource?.replace(/_/g, ' ') || 'Legacy Queue Row'
  const retryBlocked = isNonRetryableRow(item)

  return (
    <aside className="occ-inspector occ-dossier">
      <div className="occ-dossier__atmo" aria-hidden="true" />
      <div className="occ-dossier__header">
        <div className="occ-dossier__identity">
          <strong className="occ-dossier__seller">{truncate(identity.primary, 30)}</strong>
          <span className={cls('occ-status-pill', `is-${statusView.tone}`)}>{statusView.primary}</span>
        </div>
        <button type="button" className="occ-inspector__close" onClick={() => onAction('deselect', item.id)}>
          <Icon name="close" size={12} />
        </button>
      </div>

      <div className="occ-inspector__body">

        {/* Identity */}
        <div className="occ-insp-section">
          <div className="occ-insp-section-title">Identity</div>
          <InspRow label="Full Name" value={identity.primary} />
          {identity.secondary && <InspRow label="Active Person" value={identity.secondary} />}
          {identity.masterOwner && <InspRow label="Master Owner" value={identity.masterOwner} />}
          <InspRow label="Phone" value={item.toPhoneNumber} mono />
          <InspRow label="Property" value={truncate(item.propertyAddress, 40)} />
          {item.propertyCity && (
            <InspRow label="City / State" value={`${item.propertyCity}${item.propertyState ? ', ' + item.propertyState : ''}`} />
          )}
          <InspRow label="Market" value={item.market} />
          {item.linkedPropertyId && <InspRow label="Property ID" value={truncate(item.linkedPropertyId, 24)} mono />}
          {item.linkedOwnerId && <InspRow label="Owner ID" value={truncate(item.linkedOwnerId, 24)} mono />}
        </div>

        {/* Origin */}
        <div className="occ-insp-section">
          <div className="occ-insp-section-title">Origin</div>
          <InspRow label="Source" value={originLabel} />
          <InspRow label="Campaign" value={item.campaignName || (item.campaignId ? truncate(item.campaignId, 24) : 'Legacy Row')} />
          {item.campaignTargetId && <InspRow label="Target ID" value={truncate(item.campaignTargetId, 24)} mono />}
          {item.workflowId && <InspRow label="Workflow" value={truncate(item.workflowId, 24)} mono />}
          {item.queueKey && <InspRow label="Queue Key" value={truncate(item.queueKey, 28)} mono />}
          <InspRow label="Created" value={formatRelativeTime(item.createdAt)} />
          <InspRow label="Stage" value={resolveStageLabel(item)} tone={item.stageCode ? STAGE_TONE[item.stageCode] : undefined} />
          <InspRow label="Touch #" value={String(item.touchNumber)} />
        </div>

        {/* Routing */}
        <div className="occ-insp-section">
          <div className="occ-insp-section-title">Routing</div>
          <InspRow label="From" value={item.fromPhoneNumber} mono />
          <InspRow label="To" value={item.toPhoneNumber} mono />
          <InspRow label="Template" value={truncate(item.templateName, 32)} />
          <InspRow label="Scheduled" value={formatRelativeTime(item.scheduledForLocal)} />
          {item.routingTier != null && <InspRow label="Tier" value={String(item.routingTier)} />}
          {item.routingRuleName && <InspRow label="Rule" value={item.routingRuleName} />}
          {item.routingReason && <InspRow label="Routing Reason" value={truncate(item.routingReason, 40)} />}
        </div>

        {/* Message */}
        {item.messageText && (
          <div className="occ-insp-section">
            <div className="occ-insp-section-title">Message</div>
            <div className="occ-insp-message">{item.messageText}</div>
          </div>
        )}

        {/* Delivery */}
        <div className="occ-insp-section">
          <div className="occ-insp-section-title">Delivery</div>
          <InspRow label="Status" value={statusView.primary} tone={statusView.tone} />
          {statusView.blocking && <InspRow label="Blocking Cause" value={statusView.blocking} tone="amber" />}
          <InspRow label="Provider Status" value={item.deliveryStatus} tone={item.deliveryStatus === 'delivered' ? 'green' : item.deliveryStatus === 'failed' ? 'red' : undefined} />
          {item.providerMessageId && <InspRow label="SID" value={truncate(item.providerMessageId, 22)} mono />}
          {item.textgridMessageId && <InspRow label="TG Message ID" value={truncate(item.textgridMessageId, 22)} mono />}
          {item.sentAt && <InspRow label="Sent At" value={relTime(item.sentAt)} />}
          {item.deliveredAt && <InspRow label="Delivered At" value={relTime(item.deliveredAt)} />}
          <InspRow label="Retries" value={`${item.retryCount} / ${item.maxRetries}`} />
          <InspRow label="Retry Eligible" value={retryBlocked ? 'No (non-retryable)' : item.retryEligible ? 'Yes' : 'No'} tone={item.retryEligible && !retryBlocked ? 'green' : undefined} />
        </div>

        {/* Failure details */}
        {(failLabel || item.pausedReason || item.blockedReason || item.guardReason) && (
          <div className="occ-insp-section occ-insp-section--failure">
            <div className="occ-insp-section-title">Failure</div>
            {failLabel && <InspRow label="Cause" value={failLabel} tone="red" />}
            {item.failedReason && (
              <details className="occ-diag-collapse">
                <summary>Raw provider diagnostic</summary>
                <code>{item.failedReason}</code>
              </details>
            )}
            {item.pausedReason && <InspRow label="Paused" value={item.pausedReason.replace(/_/g, ' ')} tone="amber" />}
            {item.blockedReason && <InspRow label="Blocked" value={item.blockedReason.replace(/_/g, ' ')} tone="amber" />}
            {item.guardReason && <InspRow label="Guard" value={item.guardReason.replace(/_/g, ' ')} tone="amber" />}
          </div>
        )}

        {/* Last event */}
        {(item.lastEventType || item.deliveryStatus !== 'pending') && (
          <div className="occ-insp-section">
            <div className="occ-insp-section-title">Last Event</div>
            {item.lastEventType && <InspRow label="Type" value={item.lastEventType} />}
            {item.lastEventAt && <InspRow label="When" value={relTime(item.lastEventAt)} />}
          </div>
        )}

        {/* Diagnostic flags */}
        {statusView.historicalWarnings.length > 0 && (
          <div className="occ-insp-section occ-insp-section--diag">
            <div className="occ-insp-section-title">Historical Warnings</div>
            <div className="occ-diag-flags">
              {statusView.historicalWarnings.map(f => (
                <span key={f} className="occ-diag-flag is-hist">{f}</span>
              ))}
            </div>
          </div>
        )}

        {item.diagnosticFlags.length > 0 && (
          <div className="occ-insp-section occ-insp-section--diag">
            <div className="occ-insp-section-title">Diagnostics</div>
            <div className="occ-diag-flags">
              {item.diagnosticFlags.map(f => (
                <span key={f} className="occ-diag-flag">{f.replace(/_/g, ' ')}</span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="occ-inspector__actions">
        {item.status === 'approval' && (
          <button className="occ-action-btn is-primary" onClick={() => onAction('approve', item.id)}>
            <Icon name="check" size={13} /> Approve
          </button>
        )}
        {(item.status === 'failed' || item.status === 'retry') && item.retryEligible && !retryBlocked && (
          <button className="occ-action-btn is-primary" onClick={() => onAction('retry', item.id)}>
            <Icon name="zap" size={13} /> Retry
          </button>
        )}
        {item.status === 'paused_invalid_queue_row' && (
          <button className="occ-action-btn is-secondary" onClick={() => onAction('retry-routing', item.id)}>
            <Icon name="refresh-cw" size={13} /> Retry Routing
          </button>
        )}
        {['scheduled', 'queued', 'ready'].includes(item.status) && (
          <>
            <button className="occ-action-btn is-secondary" onClick={() => onAction('hold', item.id)}>
              <Icon name="shield" size={13} /> Hold
            </button>
            <button className="occ-action-btn is-secondary" onClick={() => onAction('reschedule', item.id)}>
              <Icon name="clock" size={13} /> +1 Day
            </button>
          </>
        )}
        {item.linkedInboxThreadId && (
          <button className="occ-action-btn is-secondary" onClick={() => onAction('view-thread', item.id)}>
            <Icon name="message" size={13} /> Thread
          </button>
        )}
        <button className="occ-action-btn is-danger" onClick={() => onAction('cancel', item.id)}>
          <Icon name="close" size={13} /> Suppress
        </button>
      </div>
    </aside>
  )
}

// ── Intelligence Panel (no row selected) ────────────────────────────────────

const _IntelPanel = ({
  items,
  section,
  kpi,
  templateStats,
  senderStats,
  marketStats,
  failureStats,
  onRequestConfirm,
}: {
  items: QueueItem[]
  section: QueueSection
  kpi: { failed: number; blocked: number; approval: number; scheduled: number; queued: number }
  templateStats: TemplateStat[]
  senderStats: SenderStat[]
  marketStats: MarketStat[]
  failureStats: FailureCauseStat[]
  onRequestConfirm: (action: string) => void
}) => {
  const oneHourAgo = Date.now() - 3600000

  const failedLastHour = useMemo(() =>
    items.filter(i => (i.status === 'failed' || i.status === 'retry') && new Date(i.updatedAt).getTime() > oneHourAgo).length
  , [items, oneHourAgo])

  const deliveredLastHour = useMemo(() =>
    items.filter(i => i.status === 'delivered' && i.deliveredAt && new Date(i.deliveredAt).getTime() > oneHourAgo).length
  , [items, oneHourAgo])

  const optOutsLastHour = useMemo(() =>
    items.filter(i =>
      (i.failureCategory === 'recipient_opted_out' || i.failureCategory === 'blacklist_pair_21610') &&
      new Date(i.updatedAt).getTime() > oneHourAgo
    ).length
  , [items, oneHourAgo])

  const activeSenders = useMemo(() =>
    new Set(items.filter(i => ['scheduled', 'queued', 'ready', 'sending'].includes(i.status) && i.fromPhoneNumber).map(i => i.fromPhoneNumber)).size
  , [items])

  const pendingRetries = useMemo(() => items.filter(i => i.status === 'retry' && i.retryEligible).length, [items])

  const blockedContacts = useMemo(() => items.filter(i => BLOCKED_STATUSES.has(i.status)).length, [items])

  const topFailures = useMemo(() => {
    const map = new Map<string, number>()
    for (const i of items) {
      if (i.failureCategory) map.set(i.failureCategory, (map.get(i.failureCategory) ?? 0) + 1)
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5)
  }, [items])

  const degradedTemplates = templateStats.filter(t => t.health === 'degraded' || t.health === 'critical').length
  const blockedSenders = senderStats.filter(s => s.state === 'blocked' || s.health === 'critical').length
  const degradedMarkets = marketStats.filter(m => m.health === 'degraded' || m.health === 'critical').length
  const noSenderMarkets = marketStats.filter(m => !m.senderExists).length
  const retryableFailures = failureStats.filter(f => f.retryable).reduce((n, f) => n + f.count, 0)
  const complianceFailures = failureStats.filter(f => f.category === 'Compliance').reduce((n, f) => n + f.count, 0)
  const eventVelocity = items.filter(i => i.lastEventAt && Date.now() - new Date(i.lastEventAt).getTime() < 3600000).length

  const sectionTitle: Record<QueueSection, string> = {
    queue: 'Queue Operations',
    templates: 'Template Health',
    senders: 'Sender Fleet',
    market: 'Market Posture',
    failures: 'Failure Intelligence',
    events: 'Event Stream',
  }

  return (
    <aside className={cls('occ-inspector occ-intel', `is-tab-${section}`)}>
      <div className="occ-intel__head">
        <span className="occ-intel__title">QUEUE INTELLIGENCE</span>
        <span className="occ-intel__sub">{sectionTitle[section]} · select a row for dossier</span>
      </div>
      <div className="occ-inspector__body">

        {section === 'queue' && (
          <>
            <div className="occ-insp-section">
              <div className="occ-insp-section-title">Live Ops / Hour</div>
              <div className="occ-intel-grid">
                {[
                  { val: activeSenders, lbl: 'Active Senders' },
                  { val: deliveredLastHour, lbl: 'Delivered', tone: 'green' },
                  { val: failedLastHour, lbl: 'Failed', tone: failedLastHour > 0 ? 'red' : '' },
                  { val: optOutsLastHour, lbl: 'Opt-Outs', tone: optOutsLastHour > 0 ? 'red' : '' },
                  { val: pendingRetries, lbl: 'Pending Retry', tone: pendingRetries > 0 ? 'amber' : '' },
                  { val: blockedContacts, lbl: 'Blocked', tone: blockedContacts > 0 ? 'amber' : '' },
                ].map(({ val, lbl, tone }) => (
                  <div key={lbl} className={cls('occ-intel-stat', tone && `is-${tone}`)}>
                    <span className="occ-intel-stat__val">{val}</span>
                    <span className="occ-intel-stat__lbl">{lbl}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="occ-insp-section">
              <div className="occ-insp-section-title">Pending Work</div>
              <InspRow label="Scheduled" value={kpi.scheduled} />
              <InspRow label="Queued" value={kpi.queued} />
              <InspRow label="Approval" value={kpi.approval} tone={kpi.approval > 0 ? 'amber' : undefined} />
            </div>
          </>
        )}

        {section === 'templates' && (
          <div className="occ-insp-section">
            <div className="occ-insp-section-title">Template Posture</div>
            <InspRow label="Templates tracked" value={templateStats.length} />
            <InspRow label="Degraded / critical" value={degradedTemplates} tone={degradedTemplates > 0 ? 'amber' : undefined} />
            <InspRow label="Low-sample templates" value={templateStats.filter(t => t.sent < 5).length} />
          </div>
        )}

        {section === 'senders' && (
          <div className="occ-insp-section">
            <div className="occ-insp-section-title">Sender Fleet</div>
            <InspRow label="Active senders" value={senderStats.filter(s => s.state === 'active').length} />
            <InspRow label="Blocked / critical" value={blockedSenders} tone={blockedSenders > 0 ? 'red' : undefined} />
            <InspRow label="21610 violations" value={senderStats.reduce((n, s) => n + s.violations21610, 0)} tone="red" />
          </div>
        )}

        {section === 'market' && (
          <div className="occ-insp-section">
            <div className="occ-insp-section-title">Market Health</div>
            <InspRow label="Healthy markets" value={marketStats.filter(m => m.health === 'healthy').length} tone="green" />
            <InspRow label="Degraded markets" value={degradedMarkets} tone={degradedMarkets > 0 ? 'amber' : undefined} />
            <InspRow label="No registered sender" value={noSenderMarkets} tone={noSenderMarkets > 0 ? 'red' : undefined} />
          </div>
        )}

        {section === 'failures' && (
          <div className="occ-insp-section">
            <div className="occ-insp-section-title">Failure Totals</div>
            <InspRow label="Retryable" value={retryableFailures} tone="green" />
            <InspRow label="Non-retryable" value={failureStats.filter(f => !f.retryable).reduce((n, f) => n + f.count, 0)} />
            <InspRow label="Compliance failures" value={complianceFailures} tone={complianceFailures > 0 ? 'red' : undefined} />
          </div>
        )}

        {section === 'events' && (
          <div className="occ-insp-section">
            <div className="occ-insp-section-title">Event Velocity</div>
            <InspRow label="Events / hour" value={eventVelocity} />
            <InspRow label="Failed events" value={failedLastHour} tone={failedLastHour > 0 ? 'red' : undefined} />
          </div>
        )}

        <div className="occ-insp-section">
          <div className="occ-insp-section-title">Global Controls</div>
          <div className="occ-intel-actions">
            <button className="occ-action-btn is-primary" onClick={() => onRequestConfirm('retry-all-failed')}>
              <Icon name="zap" size={11} /> Retry All Failed
            </button>
            <button className="occ-action-btn is-secondary" onClick={() => onRequestConfirm('run-queue-now')}>
              <Icon name="send" size={11} /> Run Queue
            </button>
          </div>
        </div>

        {section === 'queue' && topFailures.length > 0 && (
          <div className="occ-insp-section">
            <div className="occ-insp-section-title">Top Failure Causes</div>
            {topFailures.map(([cat, count]) => (
              <div key={cat} className="occ-intel-failure-row">
                <span className="occ-intel-failure-label">{FAILURE_LABEL[cat] ?? cat.replace(/_/g, ' ')}</span>
                <span className="occ-intel-failure-count">{count}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}

// ── Templates Module ────────────────────────────────────────────────────────

const _TemplateDossier = ({ s, onClose, onViewRows }: { s: TemplateStat; onClose: () => void; onViewRows: (name: string) => void }) => (
  <aside className="occ-tpl-dossier">
    <div className="occ-tpl-dossier__head">
      <div>
        <h3 className="occ-tpl-dossier__title">{s.name}</h3>
        {s.id !== 'no-template' && <code className="occ-tpl-dossier__id">{s.id}</code>}
      </div>
      <button type="button" className="occ-icon-btn" onClick={onClose} aria-label="Close">×</button>
    </div>

    <div className="occ-tpl-dossier__meta">
      {s.stageLabel && <span className="occ-tag">{s.stageLabel}</span>}
      {s.useCase && <span className="occ-tag is-muted">{s.useCase}</span>}
      {s.language && <span className="occ-tag is-muted">{s.language.toUpperCase()}</span>}
      <span className={cls('occ-health-badge', `is-${HEALTH_TONE[s.health === 'insufficient' ? 'watch' : s.health]}`)}>{s.healthLabel}</span>
      {s.sent < 5 && <span className="occ-sample-badge">n={s.sent}</span>}
    </div>

    <div className="occ-tpl-dossier__metrics">
      {[
        { l: 'Usage', v: s.usage },
        { l: 'Sent', v: s.sent },
        { l: 'Delivered', v: s.delivered, tone: 'green' },
        { l: 'Failed', v: s.failed, tone: s.failed > 0 ? 'red' : '' },
        { l: 'Blocked', v: s.blocked, tone: s.blocked > 0 ? 'amber' : '' },
        { l: 'Opt-Outs', v: s.optOuts, tone: s.optOuts > 0 ? 'red' : '' },
        { l: '21610', v: s.violations21610, tone: s.violations21610 > 0 ? 'red' : '' },
        { l: 'Delivery %', v: `${s.deliveryPct}%`, tone: s.deliveryPct > 70 ? 'green' : 'amber' },
        { l: 'Failure %', v: `${s.failPct}%`, tone: s.failPct > 15 ? 'red' : '' },
        { l: 'Reply %', v: '—' },
      ].map(m => (
        <div key={m.l} className="occ-tpl-metric">
          <span className={cls('occ-tpl-metric__val', m.tone && `is-${m.tone}`)}>{m.v}</span>
          <span className="occ-tpl-metric__lbl">{m.l}</span>
        </div>
      ))}
    </div>

    {s.sampleBody && (
      <div className="occ-tpl-dossier__section">
        <div className="occ-tpl-dossier__section-title">Message Body</div>
        <p className="occ-tpl-dossier__body">{s.sampleBody}</p>
      </div>
    )}

    <div className="occ-tpl-dossier__section">
      <div className="occ-tpl-dossier__section-title">Related Markets ({s.markets.length})</div>
      <div className="occ-failure-card__chips">
        {s.markets.length === 0 && <span className="occ-chip is-muted">none on page</span>}
        {s.markets.slice(0, 8).map(m => <span key={m} className="occ-chip">{truncate(m, 14)}</span>)}
        {s.markets.length > 8 && <span className="occ-chip is-muted">+{s.markets.length - 8}</span>}
      </div>
    </div>

    <div className="occ-tpl-dossier__section">
      <div className="occ-tpl-dossier__section-title">Related Senders ({s.senders.length})</div>
      <div className="occ-failure-card__chips">
        {s.senders.length === 0 && <span className="occ-chip is-muted">none on page</span>}
        {s.senders.slice(0, 6).map(p => <span key={p} className="occ-chip occ-mono">…{p.slice(-4)}</span>)}
        {s.senders.length > 6 && <span className="occ-chip is-muted">+{s.senders.length - 6}</span>}
      </div>
    </div>

    <div className="occ-tpl-dossier__section occ-tpl-dossier__times">
      <span>First seen: {s.firstSeen ? relTime(s.firstSeen) : '—'}</span>
      <span>Last seen: {s.lastSeen ? relTime(s.lastSeen) : '—'}</span>
    </div>

    <button type="button" className="occ-action-btn is-primary occ-tpl-dossier__cta" onClick={() => onViewRows(s.name)}>
      View {s.usage} queue row{s.usage === 1 ? '' : 's'}
    </button>
    <p className="occ-tpl-dossier__note">Counts reflect the loaded page/range. Reply % requires the performance view.</p>
  </aside>
)

// ── Sender Numbers Module ───────────────────────────────────────────────────

const SendersModule = ({
  items,
  selectedPhone,
  onSelectPhone,
}: {
  items: QueueItem[]
  selectedPhone: string | null
  onSelectPhone: (phone: string | null) => void
}) => {
  const stats = useMemo(() => buildSenderStats(items), [items])

  const STATE_TONE: Record<string, string> = { active: 'green', paused: 'muted', degraded: 'amber', blocked: 'red' }

  return (
    <div className="occ-senders-layout">
      <SenderFleetOverview
        senders={stats.map(s => ({
          phone: s.phone, market: s.market, sent: s.sent, delivered: s.delivered, failed: s.failed,
          deliveryPct: s.deliveryPct, failPct: s.failPct, violations21610: s.violations21610,
          optOuts: s.optOuts, state: s.state, health: s.health,
          performanceLabel: s.performanceLabel, operationalLabel: s.operationalLabel,
          lastUsed: s.lastUsed ? relTime(s.lastUsed) : null,
        }))}
        selectedPhone={selectedPhone}
        onSelect={onSelectPhone}
      />
    <div className="occ-module occ-module--senders">
      <div className="occ-module-head occ-module-head--senders">
        <div className="occ-module-col occ-col-phone">Number</div>
        <div className="occ-module-col occ-col-market">Market</div>
        <div className="occ-module-col occ-col-num">Sent</div>
        <div className="occ-module-col occ-col-num">Del</div>
        <div className="occ-module-col occ-col-num">Fail</div>
        <div className="occ-module-col occ-col-num">Blk</div>
        <div className="occ-module-col occ-col-num">Opt-Outs</div>
        <div className="occ-module-col occ-col-num">21610</div>
        <div className="occ-module-col occ-col-pct">Del%</div>
        <div className="occ-module-col occ-col-badge">Health</div>
        <div className="occ-module-col occ-col-small">Last Used</div>
        <div className="occ-module-col occ-col-badge">State</div>
      </div>
      <div className="occ-module-body">
        {stats.length === 0 && (
          <div className="occ-module-empty">No sender data for this date range.</div>
        )}
        {stats.map(s => (
          <button
            key={s.phone}
            type="button"
            className={cls('occ-module-row occ-module-row--clickable', selectedPhone === s.phone && 'is-selected')}
            onClick={() => onSelectPhone(selectedPhone === s.phone ? null : s.phone)}
          >
            <div className="occ-module-col occ-col-phone occ-mono">{s.phone}</div>
            <div className="occ-module-col occ-col-market">{truncate(s.market, 12)}</div>
            <div className="occ-module-col occ-col-num">{s.sent}</div>
            <div className="occ-module-col occ-col-num is-green">{s.delivered}</div>
            <div className={cls('occ-module-col occ-col-num', s.failed > 0 && 'is-red')}>{s.failed}</div>
            <div className={cls('occ-module-col occ-col-num', s.blocked > 0 && 'is-amber')}>{s.blocked}</div>
            <div className={cls('occ-module-col occ-col-num', s.optOuts > 0 && 'is-red')}>{s.optOuts}</div>
            <div className={cls('occ-module-col occ-col-num', s.violations21610 > 0 && 'is-red occ-bold')}>{s.violations21610}</div>
            <div className={cls('occ-module-col occ-col-pct', s.deliveryPct > 70 ? 'is-green' : s.deliveryPct > 40 ? 'is-amber' : 'is-red')}>
              {s.deliveryPct}%
            </div>
            <div className="occ-module-col occ-col-badge">
              <span className={cls('occ-state-badge', `is-${STATE_TONE[s.state] ?? 'muted'}`)}>{s.state}</span>
              <small>{s.performanceLabel}</small>
            </div>
            <div className="occ-module-col occ-col-small">{relTime(s.lastUsed)}</div>
            <div className="occ-module-col occ-col-badge">
              <small className="occ-seller-meta">{s.operationalLabel}</small>
            </div>
          </button>
        ))}
      </div>
    </div>
    </div>
  )
}

// ── Market Health Module ────────────────────────────────────────────────────

const MarketModule = ({
  items,
  directory,
  onViewRows,
  selectedMarket,
  onSelectMarket,
}: {
  items: QueueItem[]
  directory: ConfiguredMarket[]
  onViewRows: (market: string) => void
  selectedMarket: string | null
  onSelectMarket: (market: string | null) => void
}) => {
  const stats = useMemo(() => buildMarketStats(items, directory), [items, directory])
  const configuredCount = stats.filter(s => s.configured).length

  return (
    <div className="occ-market-layout">
      <MarketHealthOverview markets={stats.map(s => ({
        market: s.market, total: s.total, health: s.health, deliveryPct: s.deliveryPct,
        senderExists: s.senderExists, active: s.active, failed: s.failed, optOuts: s.optOuts,
      }))} />
    <div className="occ-module occ-module--market">
      <div className="occ-module-head occ-module-head--market">
        <div className="occ-module-col occ-col-name">Market</div>
        <div className="occ-module-col occ-col-badge">Sender</div>
        <div className="occ-module-col occ-col-num">Total</div>
        <div className="occ-module-col occ-col-num">Sent</div>
        <div className="occ-module-col occ-col-num">Del</div>
        <div className="occ-module-col occ-col-num">Fail</div>
        <div className="occ-module-col occ-col-num">Blk</div>
        <div className="occ-module-col occ-col-num">Opt-Outs</div>
        <div className="occ-module-col occ-col-pct">Del%</div>
        <div className="occ-module-col occ-col-badge">Health</div>
        <div className="occ-module-col occ-col-action">Rows</div>
      </div>
      <div className="occ-module-body">
        {stats.length === 0 && (
          <div className="occ-module-empty">No configured markets found.</div>
        )}
        {stats.map(s => (
          <button
            key={s.market}
            type="button"
            className={cls('occ-module-row occ-module-row--market occ-module-row--clickable', s.total === 0 && 'is-empty', selectedMarket === s.market && 'is-selected')}
            onClick={() => onSelectMarket(selectedMarket === s.market ? null : s.market)}
          >
            <div className="occ-module-col occ-col-name occ-col-name--strong">
              <span>{truncate(s.market, 20)}</span>
              {!s.configured && <small className="occ-tag is-muted">unregistered</small>}
            </div>
            <div className="occ-module-col occ-col-badge">
              {s.senderExists
                ? <span className={cls('occ-state-badge', s.active ? 'is-green' : 'is-muted')}>{s.active ? 'active' : 'paused'}</span>
                : <span className="occ-state-badge is-red">none</span>}
            </div>
            <div className="occ-module-col occ-col-num">{s.total}</div>
            <div className="occ-module-col occ-col-num">{s.sent}</div>
            <div className="occ-module-col occ-col-num is-green">{s.delivered}</div>
            <div className={cls('occ-module-col occ-col-num', s.failed > 0 && 'is-red')}>{s.failed}</div>
            <div className={cls('occ-module-col occ-col-num', s.blocked > 0 && 'is-amber')}>{s.blocked}</div>
            <div className={cls('occ-module-col occ-col-num', s.optOuts > 0 && 'is-red')}>{s.optOuts}</div>
            <div className={cls('occ-module-col occ-col-pct', s.total === 0 ? 'is-muted' : s.deliveryPct > 70 ? 'is-green' : s.deliveryPct > 40 ? 'is-amber' : 'is-red')}>
              {s.total === 0 ? '—' : `${s.deliveryPct}%`}
            </div>
            <div className="occ-module-col occ-col-badge">
              <span className={cls('occ-health-badge', `is-${HEALTH_TONE[s.health]}`)}>{s.total === 0 ? 'idle' : s.health}</span>
            </div>
            <div className="occ-module-col occ-col-action">
              <span
                role="button"
                tabIndex={0}
                className="occ-mini-btn"
                onClick={e => { e.stopPropagation(); if (s.total > 0) onViewRows(s.market) }}
                onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); if (s.total > 0) onViewRows(s.market) } }}
              >
                View
              </span>
            </div>
          </button>
        ))}
      </div>
      <div className="occ-module-foot">
        {configuredCount} configured market{configuredCount === 1 ? '' : 's'} · counts reflect the loaded page/range
      </div>
    </div>
    </div>
  )
}

// ── Failure Taxonomy Module ─────────────────────────────────────────────────

// Extra labels for blocked/paused rows that carry no failureCategory.
const FAILURE_CAUSE_LABEL: Record<string, string> = {
  ...FAILURE_LABEL,
  paused_name_missing: 'Paused — Name Missing',
  blocked_by_guard: 'Blocked By Queue Guard',
}

// Operational metadata per cause: category, whether a retry is safe, whether
// suppression is required, and the recommended operator action.
const FAILURE_META: Record<string, { category: string; retryable: boolean; suppression: boolean; action: string }> = {
  textgrid_content_filter: { category: 'Carrier',    retryable: false, suppression: false, action: 'Revise template wording — carrier content filter rejected it.' },
  blacklist_pair_21610:    { category: 'Compliance', retryable: false, suppression: true,  action: 'Suppress the sender↔recipient pair. Never retry (21610).' },
  recipient_opted_out:     { category: 'Compliance', retryable: false, suppression: true,  action: 'Honor opt-out — suppress recipient permanently.' },
  invalid_number:          { category: 'Carrier',    retryable: false, suppression: true,  action: 'Mark number invalid and suppress; re-skiptrace owner.' },
  suppression_blocked:     { category: 'Compliance', retryable: false, suppression: true,  action: 'Already suppressed — no send. Review suppression list.' },
  no_valid_sender:         { category: 'Routing',    retryable: true,  suppression: false, action: 'Add/inspect a TextGrid sender for this market, then retry routing.' },
  missing_template:        { category: 'Template',   retryable: true,  suppression: false, action: 'Attach a template for this stage, then re-queue.' },
  blank_message_body:      { category: 'Payload',    retryable: true,  suppression: false, action: 'Rehydrate message body / merge fields, then retry.' },
  message_event_missing:   { category: 'Webhook',    retryable: true,  suppression: false, action: 'Reconcile delivery webhook to backfill the message event.' },
  carrier_failure:         { category: 'Carrier',    retryable: true,  suppression: false, action: 'Transient carrier error — safe to retry within caps.' },
  stale_runnable_row:      { category: 'Queue',      retryable: false, suppression: false, action: 'Exceeded retries / stale — cancel or manually re-queue.' },
  paused_name_missing:     { category: 'Payload',    retryable: true,  suppression: false, action: 'Resolve seller name, then reprocess paused rows.' },
  blocked_by_guard:        { category: 'Guard',      retryable: false, suppression: false, action: 'Review the queue-guard reason; clear guard or cancel.' },
  unknown:                 { category: 'Unknown',    retryable: true,  suppression: false, action: 'Inspect raw failed_reason and classify before bulk retry.' },
}

// Maps a row to its failure cause, including blocked/paused rows that have no
// classifier output.
const deriveFailureCause = (i: QueueItem): string | null => {
  if (isManualMessage(i) && (i.failureCategory === 'missing_template' || i.diagnosticFlags.includes('MISSING_TEMPLATE'))) return null
  if (isDelivered(i.status) && i.failureCategory === 'missing_template') return null
  if (i.failureCategory) return i.failureCategory
  if (i.status === 'paused_name_missing') return 'paused_name_missing'
  if (BLOCKED_STATUSES.has(i.status)) return 'blocked_by_guard'
  if (isFailed(i.status)) return 'unknown'
  return null
}

interface FailureCauseStat {
  cause: string
  label: string
  category: string
  count: number
  retryable: boolean
  suppression: boolean
  action: string
  markets: string[]
  senders: string[]
  templates: string[]
}

const FailureModule = ({
  items,
  onFilterCause,
  selectedCause,
  onSelectCause,
}: {
  items: QueueItem[]
  onFilterCause: (cause: string) => void
  selectedCause: string | null
  onSelectCause: (cause: string | null) => void
}) => {
  const stats = useMemo<FailureCauseStat[]>(() => {
    const map = new Map<string, { count: number; markets: Set<string>; senders: Set<string>; templates: Set<string> }>()
    for (const i of items) {
      const cause = deriveFailureCause(i)
      if (!cause) continue
      const entry = map.get(cause) ?? { count: 0, markets: new Set(), senders: new Set(), templates: new Set() }
      entry.count++
      if (i.market && i.market !== 'Market unknown') entry.markets.add(i.market)
      if (i.fromPhoneNumber) entry.senders.add(i.fromPhoneNumber)
      if (i.templateName && i.templateName !== 'Template not attached') entry.templates.add(i.templateName)
      map.set(cause, entry)
    }
    return Array.from(map.entries()).map(([cause, e]) => {
      const meta = FAILURE_META[cause] ?? FAILURE_META.unknown
      return {
        cause,
        label: FAILURE_CAUSE_LABEL[cause] ?? cause.replace(/_/g, ' '),
        category: meta.category,
        count: e.count,
        retryable: meta.retryable,
        suppression: meta.suppression,
        action: meta.action,
        markets: Array.from(e.markets).sort(),
        senders: Array.from(e.senders),
        templates: Array.from(e.templates).sort(),
      }
    }).sort((a, b) => b.count - a.count)
  }, [items])

  const total = stats.reduce((n, s) => n + s.count, 0)
  const retryable = stats.filter(s => s.retryable).reduce((n, s) => n + s.count, 0)
  const nonRetryable = total - retryable
  const compliance = stats.filter(s => s.category === 'Compliance').reduce((n, s) => n + s.count, 0)
  const provider = stats.filter(s => s.category === 'Carrier').reduce((n, s) => n + s.count, 0)
  const config = stats.filter(s => ['Template', 'Routing', 'Payload', 'Guard'].includes(s.category)).reduce((n, s) => n + s.count, 0)
  const webhook = stats.filter(s => s.category === 'Webhook').reduce((n, s) => n + s.count, 0)
  const unknown = stats.filter(s => s.category === 'Unknown').reduce((n, s) => n + s.count, 0)
  const selected = stats.find(s => s.cause === selectedCause) ?? null
  const previewRows = selected
    ? items.filter(i => deriveFailureCause(i) === selected.cause).slice(0, 8)
    : []

  return (
    <div className="occ-failure-command">
      <FailureCommandHeader
        total={total}
        retryable={retryable}
        nonRetryable={nonRetryable}
        compliance={compliance}
        provider={provider}
        config={config}
        webhook={webhook}
        unknown={unknown}
      />
      {stats.length === 0 && (
        <div className="occ-module-empty">No failures or blocks in the loaded page/range.</div>
      )}
      <div className="occ-failure-command__body">
      <div className="occ-failure-cards">
        {stats.map(s => {
          const tone = FAILURE_TONE[s.category] ?? 'amber'
          return (
            <button
              key={s.cause}
              type="button"
              className={cls('occ-failure-card', selectedCause === s.cause && 'is-selected', `is-glow-${tone}`)}
              onClick={() => onSelectCause(selectedCause === s.cause ? null : s.cause)}
              title="Select failure family"
            >
              <div className="occ-failure-card__head">
                <span className={cls('occ-failure-card__dot', `is-${tone}`)} />
                <span className="occ-failure-card__label">{s.label}</span>
                <span className={cls('occ-failure-card__count', `is-${tone}`)}>{s.count}</span>
              </div>
              <div className="occ-failure-card__meta">
                <span className="occ-tag">{s.category}</span>
                <span className={cls('occ-tag', s.retryable ? 'is-green' : 'is-muted')}>{s.retryable ? 'retryable' : 'non-retryable'}</span>
                {s.suppression && <span className="occ-tag is-red">suppress</span>}
              </div>
              <div className="occ-failure-card__scope">
                <span>{s.markets.length} market{s.markets.length === 1 ? '' : 's'}</span>
                <span>· {s.senders.length} sender{s.senders.length === 1 ? '' : 's'}</span>
                <span>· {s.templates.length} template{s.templates.length === 1 ? '' : 's'}</span>
              </div>
              {s.markets.length > 0 && (
                <div className="occ-failure-card__chips">
                  {s.markets.slice(0, 4).map(m => <span key={m} className="occ-chip">{truncate(m, 14)}</span>)}
                  {s.markets.length > 4 && <span className="occ-chip is-muted">+{s.markets.length - 4}</span>}
                </div>
              )}
              <div className="occ-failure-card__action">{s.action}</div>
              <span
                role="button"
                tabIndex={0}
                className="occ-failure-card__cta"
                onClick={e => { e.stopPropagation(); onFilterCause(s.cause) }}
                onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); onFilterCause(s.cause) } }}
              >
                View rows →
              </span>
            </button>
          )
        })}
      </div>
      {selected && (
        <aside className="occ-failure-dossier">
          <header className="occ-failure-dossier__head">
            <strong>{selected.label}</strong>
            <span className={cls('occ-failure-card__count', `is-${FAILURE_TONE[selected.category] ?? 'amber'}`)}>{selected.count}</span>
          </header>
          <p className="occ-failure-dossier__action">{selected.action}</p>
          <div className="occ-failure-dossier__meta">
            <span>{selected.retryable ? 'Retryable' : 'Non-retryable'}</span>
            <span>{selected.markets.length} markets</span>
            <span>{selected.senders.length} senders</span>
          </div>
          <div className="occ-failure-dossier__preview">
            <span className="occ-failure-dossier__preview-title">Affected rows (sample)</span>
            {previewRows.map(row => {
              const id = resolveSellerIdentity(row)
              const asset = resolveAssetTypeIcon(row.propertyType)
              return (
                <div key={row.id} className="occ-failure-preview-row">
                  <span className="occ-asset-icon" title={asset.label}><Icon name={asset.icon} size={9} /></span>
                  <strong>{truncate(id.primary, 20)}</strong>
                  {id.phoneEnding && <span className="occ-contact-badge">{id.phoneEnding}</span>}
                  <span>{truncate(row.propertyAddress, 18)}</span>
                  <span>{resolveTemplateLabel(row)}</span>
                </div>
              )
            })}
          </div>
          <button type="button" className="occ-action-btn is-primary" onClick={() => onFilterCause(selected.cause)}>
            Open {selected.count} rows in Queue
          </button>
        </aside>
      )}
      </div>
      {stats.length > 0 && (
        <div className="occ-module-foot">{total} failed/blocked rows in loaded page/range</div>
      )}
    </div>
  )
}

// ── Event Timeline Module ───────────────────────────────────────────────────

const EVENT_ICON: Record<string, string> = {
  sent: 'send', delivered: 'check', failed: 'alert-circle', retry: 'refresh-cw',
  scheduled: 'clock', queued: 'clock', blocked: 'shield', cancelled: 'close',
  approval: 'zap', held: 'pause', replied_before_send: 'message',
}

const TIMELINE_PAGE_SIZE = 30

const TIMELINE_FILTERS = [
  'all', 'scheduled', 'queued', 'sending', 'sent', 'delivered', 'failed', 'blocked',
  'retry', 'opt-out', 'suppression', 'approval', 'workflow', 'provider receipt',
] as const

const EventTimelineModule = ({
  items,
  onSelectItem: _onSelectItem,
  density,
  onDensityChange,
  selectedEventId,
  onSelectEvent,
}: {
  items: QueueItem[]
  onSelectItem: (id: string) => void
  density: 'comfortable' | 'compact'
  onDensityChange: (d: 'comfortable' | 'compact') => void
  selectedEventId: string | null
  onSelectEvent: (item: QueueItem | null) => void
}) => {
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [groupBy, setGroupBy] = useState<'time' | 'campaign' | 'seller' | 'sender' | 'market'>('time')
  const [page, setPage] = useState(0)

  const sorted = useMemo(() =>
    [...items]
      .filter(i => i.lastEventAt || i.updatedAt)
      .sort((a, b) => new Date(b.lastEventAt ?? b.updatedAt).getTime() - new Date(a.lastEventAt ?? a.updatedAt).getTime())
  , [items])

  const matchesTimelineFilter = (item: QueueItem, filter: string): boolean => {
    if (filter === 'all') return true
    const statusKey = BLOCKED_STATUSES.has(item.status) ? 'blocked' : item.status
    if (filter === 'opt-out') return item.failureCategory === 'recipient_opted_out'
    if (filter === 'suppression') return item.failureCategory === 'blacklist_pair_21610' || item.failureCategory === 'suppression_blocked'
    if (filter === 'workflow') return Boolean(item.workflowId || item.automationSource)
    if (filter === 'provider receipt') return Boolean(item.providerMessageId || item.textgridMessageId || item.lastEventType)
    if (filter === 'retry') return item.status === 'retry'
    return statusKey === filter || item.status === filter
  }

  const filtered = useMemo(() => sorted.filter(i => matchesTimelineFilter(i, typeFilter)), [sorted, typeFilter])

  const totalPages = Math.max(1, Math.ceil(filtered.length / TIMELINE_PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const events = filtered.slice(safePage * TIMELINE_PAGE_SIZE, safePage * TIMELINE_PAGE_SIZE + TIMELINE_PAGE_SIZE)

  const groupedEvents = useMemo(() => {
    if (groupBy === 'time') return [{ key: 'timeline', label: '', items: events }]
    const map = new Map<string, QueueItem[]>()
    for (const item of events) {
      const key = groupBy === 'campaign' ? (item.campaignName || 'No campaign')
        : groupBy === 'seller' ? displayName(item)
        : groupBy === 'sender' ? (item.fromPhoneNumber || 'No sender')
        : (item.market || 'Unknown market')
      const bucket = map.get(key) ?? []
      bucket.push(item)
      map.set(key, bucket)
    }
    return Array.from(map.entries()).map(([key, groupItems]) => ({ key, label: key, items: groupItems }))
  }, [filtered, groupBy, events])
  const start = filtered.length === 0 ? 0 : safePage * TIMELINE_PAGE_SIZE + 1
  const end = Math.min((safePage + 1) * TIMELINE_PAGE_SIZE, filtered.length)

  const hourLabel = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  }

  return (
    <div className={cls('occ-module occ-module--timeline', `is-density-${density}`)}>
      <div className="occ-timeline-controls">
        <select
          className="occ-filter-select"
          value={typeFilter}
          onChange={e => { setTypeFilter(e.target.value); setPage(0) }}
        >
          {TIMELINE_FILTERS.map(t => (
            <option key={t} value={t}>{t === 'all' ? 'All events' : t.replace(/_/g, ' ')}</option>
          ))}
        </select>
        <select className="occ-filter-select" value={groupBy} onChange={e => setGroupBy(e.target.value as typeof groupBy)}>
          <option value="time">Group: time</option>
          <option value="campaign">Group: campaign</option>
          <option value="seller">Group: seller/thread</option>
          <option value="sender">Group: sender</option>
          <option value="market">Group: market</option>
        </select>
        <div className="occ-density-select" role="group" aria-label="Timeline density">
          {(['compact', 'comfortable'] as const).map(d => (
            <button key={d} type="button" className={cls('occ-density-btn', density === d && 'is-active')} onClick={() => onDensityChange(d)}>
              {d === 'compact' ? 'Compact' : 'Comfortable'}
            </button>
          ))}
        </div>
        <span className="occ-timeline-count">{filtered.length.toLocaleString()} events</span>
      </div>
      {filtered.length === 0 && (
        <div className="occ-module-empty">No events for this date range.</div>
      )}
      <div className="occ-timeline occ-timeline--spine">
        <div className="occ-timeline__spine" aria-hidden="true" />
        {groupedEvents.map(group => (
          <div key={group.key} className="occ-timeline-group">
            {group.label && <div className="occ-timeline-group__label">{truncate(group.label, 40)}</div>}
            {group.items.map((i, idx) => {
              const statusView = resolveStatusPresentation(i)
              const identity = resolveSellerIdentity(i)
              const asset = resolveAssetTypeIcon(i.propertyType)
              const iconName = EVENT_ICON[i.status] ?? 'zap'
              const exactTime = i.lastEventAt ?? i.updatedAt
              const prev = idx > 0 ? group.items[idx - 1] : null
              const showSep = groupBy === 'time' && exactTime && prev && (
                new Date(exactTime).toDateString() !== new Date(prev.lastEventAt ?? prev.updatedAt).toDateString()
                || Math.abs(new Date(exactTime).getTime() - new Date(prev.lastEventAt ?? prev.updatedAt).getTime()) > 3600000
              )
              return (
                <div key={i.id} className="occ-timeline-entry">
                  {showSep && exactTime && <div className="occ-timeline-sep">{hourLabel(exactTime)}</div>}
                <button
                  type="button"
                  className={cls('occ-timeline-row', selectedEventId === i.id && 'is-selected')}
                  onClick={() => onSelectEvent(selectedEventId === i.id ? null : i)}
                  title={exactTime ? new Date(exactTime).toLocaleString() : undefined}
                >
                  <div className={cls('occ-timeline-icon', `is-${statusView.tone}`)}>
                    <Icon name={iconName as any} size={10} />
                  </div>
                  <div className="occ-timeline-connector" />
                  <div className="occ-timeline-content">
                    <div className="occ-timeline-main">
                      <span className="occ-asset-icon" title={asset.label}><Icon name={asset.icon} size={10} /></span>
                      <strong className="occ-timeline-seller">{truncate(identity.primary, 24)}</strong>
                      {identity.phoneEnding && <span className="occ-contact-badge">{identity.phoneEnding}</span>}
                      <span className={cls('occ-status-pill', `is-${statusView.tone}`)}>{statusView.primary}</span>
                    </div>
                    <div className="occ-timeline-meta">
                      <span>{truncate(i.propertyAddress, 18)}</span>
                      <span>· {truncate(i.market, 12)}</span>
                      {i.stageLabel && <span>· {truncate(i.stageLabel, 10)} T{i.touchNumber}</span>}
                      <span>· {truncate(resolveMessageSource(i), 14)}</span>
                      <span>· {truncate(resolveTemplateLabel(i), 14)}</span>
                      {i.fromPhoneNumber && <span>· …{i.fromPhoneNumber.slice(-4)}</span>}
                    </div>
                    <div className="occ-timeline-expl">{statusView.hasCurrentException ? statusView.blocking : i.lastEventType || 'Queue event recorded'}</div>
                  </div>
                  <span className="occ-timeline-time">{relTime(exactTime)}</span>
                </button>
                </div>
              )
            })}
          </div>
        ))}
      </div>
      {filtered.length > TIMELINE_PAGE_SIZE && (
        <div className="occ-table-footer occ-timeline-footer">
          <span className="occ-table-footer__count">
            Showing <strong>{start.toLocaleString()}–{end.toLocaleString()}</strong> of <strong>{filtered.length.toLocaleString()}</strong>
          </span>
          <div className="occ-pagination">
            <button type="button" className="occ-page-btn" disabled={safePage === 0} onClick={() => setPage(0)}>« First</button>
            <button type="button" className="occ-page-btn" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>‹ Prev</button>
            <span className="occ-page-info">Page {safePage + 1} of {totalPages}</span>
            <button type="button" className="occ-page-btn" disabled={safePage >= totalPages - 1} onClick={() => setPage(safePage + 1)}>Next ›</button>
            <button type="button" className="occ-page-btn" disabled={safePage >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>Last »</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Bottom Module Tabs ──────────────────────────────────────────────────────

const QUEUE_SECTIONS: Array<{ key: QueueSection; label: string; icon: string }> = [
  { key: 'queue', label: 'Queue Rows', icon: 'list' },
  { key: 'templates', label: 'Templates', icon: 'file-text' },
  { key: 'senders', label: 'Sender Fleet', icon: 'phone' },
  { key: 'market', label: 'Market Health', icon: 'map-pin' },
  { key: 'failures', label: 'Failure Taxonomy', icon: 'alert-circle' },
  { key: 'events', label: 'Event Timeline', icon: 'activity' },
]

// ── Queue Table Row ─────────────────────────────────────────────────────────

const QueueRow = ({
  item,
  isSelected,
  isExpanded,
  isChecked,
  density,
  onClick,
  onCheck,
  onToggleExpand,
}: {
  item: QueueItem
  isSelected: boolean
  isExpanded: boolean
  isChecked: boolean
  density: QueueDensity
  onClick: () => void
  onCheck: (id: string) => void
  onToggleExpand: (id: string) => void
}) => {
  const identity = resolveSellerIdentity(item)
  const statusView = resolveStatusPresentation(item)
  const asset = resolveAssetTypeIcon(item.propertyType)
  const failTone = item.failureGroup ? (FAILURE_TONE[item.failureGroup] ?? 'amber') : null
  const stageLabel = resolveStageLabel(item)
  const stageTone = item.stageCode ? (STAGE_TONE[item.stageCode] ?? 'muted') : 'muted'
  const cityState = [item.propertyCity, item.propertyState].filter(Boolean).join(', ')
  const workflowLane = resolveMessageSource(item)
  const hasHistorical = statusView.historicalWarnings.length > 0
  const isOverdue = item.overdue
  const contactOk = item.smsEligible !== false && item.routingAllowed !== false
  const currentFailure = statusView.hasCurrentException ? statusView.blocking : null

  return (
    <div className={cls('occ-row-wrap', isSelected && 'is-selected', isExpanded && 'is-expanded', `is-density-${density}`)}>
      <div className={cls('occ-row', `is-status-${statusView.tone}`, isSelected && 'is-selected')}>
        <label className="occ-row-check" onClick={e => e.stopPropagation()}>
          <input type="checkbox" checked={isChecked} onChange={() => onCheck(item.id)} aria-label={`Select ${identity.primary}`} />
        </label>
        <button
          type="button"
          className="occ-row-main"
          onClick={onClick}
          style={{ '--occ-row-accent': `var(--occ-${statusView.tone}, var(--occ-muted))` } as React.CSSProperties}
        >
          <div className="occ-cell occ-cell--seller" title={identity.primary}>
            <div className="occ-seller-line">
              <span className="occ-asset-icon" title={asset.label} aria-hidden="true">
                <Icon name={asset.icon} size={10} />
              </span>
              <strong>{truncate(identity.primary, 26)}</strong>
              {identity.phoneEnding && <span className="occ-contact-badge">{identity.phoneEnding}</span>}
              <span className={cls('occ-contact-indicator', contactOk ? 'is-ok' : 'is-warn')} title={contactOk ? 'SMS eligible' : 'Contact blocked'} />
            </div>
            {identity.secondary && <small className="occ-seller-sub">{truncate(identity.secondary, 24)}</small>}
            <small>{truncate(item.propertyAddress, 28)}</small>
            {cityState && <small className="occ-seller-meta">{cityState}{workflowLane ? ` · ${truncate(workflowLane, 16)}` : ''}</small>}
          </div>
          <div className="occ-cell occ-cell--stage">
            {item.stageCode
              ? <span className={cls('occ-stage-pill', `is-${stageTone}`)}>{stageLabel}</span>
              : <span className="occ-stage-pill is-muted">—</span>}
            <small>Touch {item.touchNumber} · {truncate(workflowLane, 14)}</small>
            {item.requiresApproval && <small className="occ-approval-tag">Approval</small>}
          </div>
          <div className="occ-cell occ-cell--campaign">
            <span>{truncate(item.campaignName ?? item.automationSource ?? item.useCase, 18)}</span>
            <small>{truncate(item.market, 14)}</small>
            {item.campaignTargetId && <small className="occ-seller-meta">Target linked</small>}
          </div>
          <div className="occ-cell occ-cell--template" title={resolveTemplateLabel(item)}>
            <span>{truncate(resolveTemplateLabel(item), 20)}</span>
            {item.templateId && <small className="occ-mono">{truncate(item.templateId, 16)}</small>}
            <small>{item.language?.toUpperCase()}</small>
          </div>
          <div className="occ-cell occ-cell--from">
            <span className="occ-mono">{item.fromPhoneNumber ? fmtPhone(item.fromPhoneNumber) : '—'}</span>
            <small>{truncate(item.market, 12)}</small>
          </div>
          <div className="occ-cell occ-cell--scheduled" title={item.scheduledForLocal ? new Date(item.scheduledForLocal).toLocaleString() : undefined}>
            <span className={isOverdue ? 'is-amber' : ''}>{relTime(item.scheduledForLocal)}</span>
            <small>{item.timezone?.split('/').pop()}{isOverdue ? ' · overdue' : ''}</small>
          </div>
          <div className="occ-cell occ-cell--status">
            <span className={cls('occ-status-pill', `is-${statusView.tone}`)}>{statusView.primary}</span>
            {currentFailure && <small className="occ-block-cause">{truncate(currentFailure, 22)}</small>}
            {hasHistorical && (
              <span className="occ-hist-warn" title={statusView.historicalWarnings.join(' · ')}>
                <Icon name="clock" size={10} />
              </span>
            )}
          </div>
          <div className="occ-cell occ-cell--failure">
            {currentFailure
              ? <span className={cls('occ-fail-pill', failTone && `is-${failTone}`)}>{truncate(currentFailure, 18)}</span>
              : <span className="occ-fail-pill is-muted">—</span>}
          </div>
          <div className="occ-cell occ-cell--event" title={item.lastEventAt ?? undefined}>
            {item.lastEventAt ? relTime(item.lastEventAt) : '—'}
            {item.lastEventType && <small>{truncate(item.lastEventType, 12)}</small>}
          </div>
        </button>
        <button type="button" className={cls('occ-row-expand', isExpanded && 'is-open')} onClick={() => onToggleExpand(item.id)} aria-label="Expand row">
          <Icon name="chevron-down" size={12} />
        </button>
      </div>
      {isExpanded && (
        <div className="occ-row-intel">
          {item.messageText && <div className="occ-row-intel__msg"><strong>Message</strong><p>{item.messageText}</p></div>}
          <div className="occ-row-intel__grid">
            <span>Route: {item.fromPhoneNumber || '—'} → {item.toPhoneNumber || '—'}</span>
            <span>Eligibility: {item.retryEligible && !isNonRetryableRow(item) ? 'Retry OK' : item.smsEligible === false ? 'Not SMS eligible' : '—'}</span>
            <span>Workflow: {item.automationSource || item.rowSource || '—'}</span>
            <span>Campaign: {item.campaignName || '—'}</span>
          </div>
          {statusView.blocking && <div className="occ-row-intel__block">Blocking: {statusView.blocking}</div>}
          {statusView.historicalWarnings.length > 0 && (
            <div className="occ-row-intel__hist">Historical: {statusView.historicalWarnings.join(' · ')}</div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main Page ───────────────────────────────────────────────────────────────

interface QueuePageProps {
  data?: QueueModel
  externalContext?: ActiveInboxContext
  onSelectItem?: (item: QueueItem) => void
}

const PAGE_SIZE = 25 // default; overridable via the page-size selector

export const QueuePage = ({ data: initialData, externalContext, onSelectItem }: QueuePageProps = {}) => {
  const { rootRef, layoutMode, paneWidth } = useQueueLayout()
  const [loading, setLoading] = useState(!initialData)
  const [model, setModel] = useState<QueueModel | null>(initialData ?? null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusBucket>('all')
  const [marketFilter, setMarketFilter] = useState('all')
  const [templateFilter, setTemplateFilter] = useState('all')
  const [senderFilter, setSenderFilter] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(0)
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [causeFilter, setCauseFilter] = useState<string | null>(null)
  const [datePreset, setDatePreset] = useState<DatePreset>('7d')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [dateBasis, setDateBasis] = useState<QueueDateBasis>('created_at')
  const [section, setSection] = useState<QueueSection>('queue')
  const [density, setDensity] = useState<QueueDensity>('compact')
  const [confirmPreview, setConfirmPreview] = useState<BulkActionPreview | null>(null)
  const [dossierOpen, setDossierOpen] = useState(true)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [selectedSenderPhone, setSelectedSenderPhone] = useState<string | null>(null)
  const [, setSelectedTemplateId] = useState<string | null>(null)
  const [selectedMarketName, setSelectedMarketName] = useState<string | null>(null)
  const [selectedFailureCause, setSelectedFailureCause] = useState<string | null>(null)
  const [selectedEventItem, setSelectedEventItem] = useState<QueueItem | null>(null)
  const [timelineDensity, setTimelineDensity] = useState<'comfortable' | 'compact'>('compact')
  const [exceptionsOpen, setExceptionsOpen] = useState(false)
  const [templateSearchParams, setTemplateSearchParams] = useState(
    () => new URLSearchParams(typeof window !== 'undefined' ? window.location.search : ''),
  )
  const realtimeRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dateFilterMounted = useRef(false)

  const syncTemplateSearchParams = useCallback((next: URLSearchParams) => {
    setTemplateSearchParams(next)
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href)
      for (const key of [...url.searchParams.keys()]) {
        if (key.startsWith('tpl_')) url.searchParams.delete(key)
      }
      next.forEach((value, key) => url.searchParams.set(key, value))
      window.history.replaceState({}, '', url.toString())
    }
  }, [])

  const buildOpts = useCallback(
    (page: number) => buildFetchOptions({
      preset: datePreset, customFrom, customTo, dateBasis, status: statusFilter, page, pageSize,
    }),
    [datePreset, customFrom, customTo, dateBasis, statusFilter, pageSize]
  )

  const refreshData = useCallback(async (page = currentPage) => {
    try {
      if (!shouldUseSupabase()) {
        // No Supabase credentials — use mock adapter immediately
        setModel(_ => ({ ...adaptQueueModel(), totalCount: 900, currentPage: page, pageSize: 500, totalPages: 2, hasMore: page === 0, fetchOptions: {} }))
        return
      }
      // Race Supabase against a 6s timeout — if it hangs, keep existing model and clear loading
      const timeout = new Promise<null>(res => setTimeout(() => res(null), 6000))
      const result = await Promise.race([fetchQueueModel(buildOpts(page)), timeout])
      if (result) setModel(result)
    } catch (err) {
      emitNotification({
        title: 'Queue Load Failed',
        detail: err instanceof Error ? err.message : 'Database sync error',
        severity: 'critical',
      })
    } finally {
      setLoading(false)
    }
  }, [buildOpts, currentPage])

  // Debounce realtime refreshes to avoid stampede
  const debouncedRefresh = useCallback(() => {
    if (realtimeRef.current) clearTimeout(realtimeRef.current)
    realtimeRef.current = setTimeout(() => refreshData(currentPage), 2500)
  }, [refreshData, currentPage])

  useEffect(() => {
    if (!initialData) refreshData(0)
    const supabase = getSupabaseClient()
    const ch = supabase
      .channel('occ-queue-live')
      .on('postgres_changes', { event: '*', table: 'send_queue', schema: 'public' }, debouncedRefresh)
      .subscribe()
    return () => { supabase.removeChannel(ch); if (realtimeRef.current) clearTimeout(realtimeRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-fetch when a server-backed filter changes (date range / basis / status).
  // Skip the initial mount; also skip a custom preset with no dates chosen yet.
  useEffect(() => {
    if (!dateFilterMounted.current) { dateFilterMounted.current = true; return }
    if (datePreset === 'custom' && !customFrom && !customTo) return
    setCurrentPage(0)
    setLoading(true)
    refreshData(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datePreset, customFrom, customTo, dateBasis, statusFilter, pageSize])

  const items = model?.items ?? []

  // ── Derived counts ──────────────────────────────────────────────────────
  const counts = useMemo(() => {
    const c = {
      scheduled: 0, queued: 0, sending: 0, sent: 0,
      delivered: 0, failed: 0, blocked: 0, approval: 0, optOuts: 0, total: items.length,
    }
    for (const i of items) {
      // Lifecycle buckets are mutually exclusive…
      if (i.status === 'scheduled') c.scheduled++
      else if (i.status === 'queued') c.queued++
      else if (i.status === 'sending') c.sending++
      else if (i.status === 'delivered') c.delivered++
      else if (isFailed(i.status)) c.failed++
      else if (BLOCKED_STATUSES.has(i.status)) c.blocked++
      else if (i.status === 'approval') c.approval++
      // …but Sent is the dispatched SUPERSET (delivered + failed + transient sent),
      // counted independently so sent >= delivered.
      if (isSent(i.status)) c.sent++
      if (i.failureCategory === 'recipient_opted_out' || i.failureCategory === 'blacklist_pair_21610') c.optOuts++
    }
    return c
  }, [items])

  // Range-accurate KPI counts (whole filtered date range) with a graceful
  // fall back to page-scoped counts when the server aggregation is absent.
  const kpi = model?.rangeCounts ?? counts
  const kpiIsRange = Boolean(model?.rangeCounts)

  // ── Unique filter options ────────────────────────────────────────────────
  const marketOptions = useMemo(() => {
    const s = new Set(items.map(i => i.market).filter(Boolean))
    return ['all', ...Array.from(s).sort()]
  }, [items])

  const templateOptions = useMemo(() => {
    const s = new Set(items.map(i => i.templateName).filter(n => n && n !== 'Template not attached'))
    return ['all', ...Array.from(s).sort()]
  }, [items])

  const senderOptions = useMemo(() => {
    const s = new Set(items.map(i => i.fromPhoneNumber).filter(Boolean))
    return ['all', ...Array.from(s).sort()]
  }, [items])

  // ── Filtered rows ────────────────────────────────────────────────────────
  const filteredItems = useMemo(() => {
    let result = items
    if (statusFilter !== 'all') {
      if (statusFilter === 'failed') result = result.filter(i => isFailed(i.status))
      else if (statusFilter === 'blocked') result = result.filter(i => BLOCKED_STATUSES.has(i.status))
      // 'Sent' is the dispatched superset to match the KPI/server bucket.
      else if (statusFilter === 'sent') result = result.filter(i => isSent(i.status))
      else result = result.filter(i => i.status === statusFilter)
    }
    if (marketFilter !== 'all') result = result.filter(i => i.market === marketFilter)
    if (templateFilter !== 'all') result = result.filter(i => i.templateName === templateFilter)
    if (senderFilter !== 'all') result = result.filter(i => i.fromPhoneNumber === senderFilter)
    if (causeFilter) result = result.filter(i => deriveFailureCause(i) === causeFilter)
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(i =>
        i.sellerName.toLowerCase().includes(q) ||
        (i.sellerFullName || '').toLowerCase().includes(q) ||
        i.propertyAddress.toLowerCase().includes(q) ||
        i.market.toLowerCase().includes(q) ||
        i.templateName.toLowerCase().includes(q) ||
        (i.campaignId ?? '').toLowerCase().includes(q) ||
        (i.campaignName ?? '').toLowerCase().includes(q) ||
        (i.phone ?? '').includes(q) ||
        (i.queueKey ?? '').includes(q),
      )
    }
    return result
  }, [items, statusFilter, marketFilter, templateFilter, senderFilter, searchQuery, causeFilter])

  const selectedItem = model?.items.find(i => i.id === selectedId) ?? null

  useEffect(() => {
    if (!externalContext || !items.length) return
    const matched = findQueueItemForActiveContext(items, externalContext)
    if (matched) {
      if (matched.id !== selectedId) {
        setSelectedId(matched.id)
        setDossierOpen(true)
        if (layoutMode === 'medium' || layoutMode === 'compact') setExpandedId(matched.id)
      }
      return
    }
    if (
      selectedId
      && externalContext.sourceView
      && externalContext.sourceView !== 'queue'
    ) {
      const current = items.find((item) => item.id === selectedId)
      if (current && !queueItemMatchesActiveContext(current, externalContext)) {
        setSelectedId(null)
        setExpandedId(null)
      }
    }
  }, [externalContext, items, layoutMode, selectedId])

  // ── Row click — select + dispatch global property context ────────────────
  const requestGlobalAction = useCallback((action: string) => {
    setConfirmPreview(buildBulkActionPreview(action, items, kpi.failed))
  }, [items, kpi.failed])

  const handleSelectRow = useCallback((item: QueueItem) => {
    const next = item.id === selectedId ? null : item.id
    setSelectedId(next)
    setDossierOpen(true)
    if (layoutMode === 'medium' || layoutMode === 'compact') setExpandedId(next)
    if (next) {
      // Global property selection — dispatch custom event for cross-module sync
      const ctx = buildContextFromQueueItem(item, 'queue', 'open_queue')
      window.dispatchEvent(new CustomEvent('nexus:queue-select', { detail: ctx }))
      onSelectItem?.(item)
    }
  }, [selectedId, onSelectItem, layoutMode])

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedId(prev => (prev === id ? null : id))
  }, [])

  // ── Pagination controls ──────────────────────────────────────────────────
  const handlePageChange = useCallback((page: number) => {
    setCurrentPage(page)
    setLoading(true)
    refreshData(page)
  }, [refreshData])

  // ── Row + global actions ─────────────────────────────────────────────────
  const handleAction = useCallback(async (action: string, id: string) => {
    if (action === 'deselect') { setSelectedId(null); setExpandedId(null); return }
    if (action === 'deselect-event') { setSelectedEventItem(null); return }

    if (action === 'retry-all-failed') {
      setConfirmPreview(null)
      setBusyAction('retry-all-failed')
      try {
        const res = await retryAllFailed()
        emitNotification({ title: res.ok ? 'Retry queued' : 'Retry failed', detail: res.errorMessage ?? 'Done', severity: res.ok ? 'success' : 'critical', sound: res.ok ? 'notification' : undefined })
        if (res.ok) await refreshData(currentPage)
      } catch { emitNotification({ title: 'Error', detail: 'Could not reach backend', severity: 'critical' }) }
      finally { setBusyAction(null) }
      return
    }

    if (action === 'run-queue-now') {
      setConfirmPreview(null)
      setBusyAction('run-queue-now')
      try {
        const res = await runQueueOnce()
        emitNotification({ title: res.ok ? 'Queue run triggered' : 'Run failed', detail: res.errorMessage ?? 'Processing started', severity: res.ok ? 'success' : 'critical', sound: res.ok ? 'notification' : undefined })
        if (res.ok) setTimeout(() => refreshData(currentPage), 3000)
      } catch { emitNotification({ title: 'Error', detail: 'Could not reach backend', severity: 'critical' }) }
      finally { setBusyAction(null) }
      return
    }

    if (action === 'view-thread') {
      const item = model?.items.find(i => i.id === id)
      if (item?.linkedInboxThreadId) {
        window.dispatchEvent(new CustomEvent('nexus:open-thread', { detail: { threadId: item.linkedInboxThreadId } }))
      }
      return
    }

    const item = model?.items.find(i => i.id === id)
    if (!item) return

    let resultPromise: Promise<any> | null = null
    let successMsg = ''

    switch (action) {
      case 'approve':       resultPromise = approveQueueItem(item);    successMsg = `Approved ${item.sellerName}`; break
      case 'hold':          resultPromise = holdQueueItem(item);       successMsg = `Held ${item.sellerName}`; break
      case 'cancel':        resultPromise = cancelQueueItem(item);     successMsg = `Suppressed ${item.sellerName}`; break
      case 'retry':         resultPromise = retryQueueItem(item);      successMsg = `Retrying ${item.sellerName}`; break
      case 'retry-routing': resultPromise = retryRoutingForItem(item); successMsg = `Routing retry for ${item.sellerName}`; break
      case 'reschedule': {
        const t = new Date(); t.setDate(t.getDate() + 1)
        resultPromise = rescheduleQueueItem(item, t.toISOString()); successMsg = `Rescheduled ${item.sellerName}`; break
      }
    }

    if (resultPromise) {
      try {
        const res = await resultPromise
        if (res.ok) {
          emitNotification({ title: 'Done', detail: successMsg, severity: 'success', sound: 'notification' })
          refreshData(currentPage)
        } else throw new Error(res.errorMessage ?? 'Unknown error')
      } catch (err) {
        emitNotification({ title: 'Action Failed', detail: err instanceof Error ? err.message : 'Error', severity: 'critical' })
      }
    }
  }, [model, refreshData, currentPage])

  // ── Filter tabs ──────────────────────────────────────────────────────────
  const templateStatsMemo = useMemo(() => buildTemplateStats(items), [items])
  const senderStatsMemo = useMemo(() => buildSenderStats(items), [items])
  const marketStatsMemo = useMemo(() => buildMarketStats(items, model?.marketDirectory ?? []), [items, model?.marketDirectory])
  const failureStatsMemo = useMemo<FailureCauseStat[]>(() => {
    const map = new Map<string, { count: number; markets: Set<string>; senders: Set<string>; templates: Set<string> }>()
    for (const i of items) {
      const cause = deriveFailureCause(i)
      if (!cause) continue
      const entry = map.get(cause) ?? { count: 0, markets: new Set(), senders: new Set(), templates: new Set() }
      entry.count++
      if (i.market && i.market !== 'Market unknown') entry.markets.add(i.market)
      if (i.fromPhoneNumber) entry.senders.add(i.fromPhoneNumber)
      if (i.templateName && i.templateName !== 'Template not attached') entry.templates.add(i.templateName)
      map.set(cause, entry)
    }
    return Array.from(map.entries()).map(([cause, e]) => {
      const meta = FAILURE_META[cause] ?? FAILURE_META.unknown
      return {
        cause,
        label: FAILURE_CAUSE_LABEL[cause] ?? cause.replace(/_/g, ' '),
        category: meta.category,
        count: e.count,
        retryable: meta.retryable,
        suppression: meta.suppression,
        action: meta.action,
        markets: Array.from(e.markets).sort(),
        senders: Array.from(e.senders),
        templates: Array.from(e.templates).sort(),
      }
    })
  }, [items])

  const exceptionsMemo = useMemo(() => buildExceptionsCenter(items), [items])
  const selectedRows = useMemo(() => items.filter(i => selectedIds.has(i.id)), [items, selectedIds])
  const bulkRetryEligible = useMemo(() => selectedRows.filter(i => isFailed(i.status) && i.retryEligible && !isNonRetryableRow(i)).length, [selectedRows])
  const bulkNonRetryable = useMemo(() => selectedRows.filter(i => isFailed(i.status) && isNonRetryableRow(i)).length, [selectedRows])
  const runnableCount = useMemo(() => items.filter(i => ['scheduled', 'queued', 'ready'].includes(i.status)).length, [items])

  const requestBulkAction = useCallback((action: string) => {
    if (selectedRows.length === 0) return
    setConfirmPreview(buildSelectionPreview(action, selectedRows))
  }, [selectedRows])

  const executeConfirmedAction = useCallback(async () => {
    if (!confirmPreview) return
    const action = confirmPreview.action
    if (action === 'retry-all-failed' || action === 'run-queue-now') {
      await handleAction(action, '')
      return
    }
    setConfirmPreview(null)
    setBusyAction(action)
    const eligible = action === 'bulk-retry'
      ? selectedRows.filter(i => isFailed(i.status) && i.retryEligible && !isNonRetryableRow(i))
      : action === 'bulk-suppress' || action === 'bulk-cancel'
        ? selectedRows.filter(i => !['cancelled', 'delivered'].includes(i.status))
        : selectedRows.filter(i => ['scheduled', 'queued', 'ready', 'failed', 'retry'].includes(i.status))
    try {
      for (const item of eligible) {
        if (action === 'bulk-retry') await retryQueueItem(item)
        else if (action === 'bulk-pause') await holdQueueItem(item)
        else if (action === 'bulk-cancel' || action === 'bulk-suppress') await cancelQueueItem(item)
        else if (action === 'bulk-reschedule') {
          const t = new Date(); t.setDate(t.getDate() + 1)
          await rescheduleQueueItem(item, t.toISOString())
        }
      }
      emitNotification({ title: 'Bulk action complete', detail: `${eligible.length} rows processed`, severity: 'success', sound: 'notification' })
      clearSelection()
      await refreshData(currentPage)
    } catch (err) {
      emitNotification({ title: 'Bulk action failed', detail: err instanceof Error ? err.message : 'Error', severity: 'critical' })
    } finally {
      setBusyAction(null)
    }
  }, [confirmPreview, selectedRows, handleAction, refreshData, currentPage, clearSelection])

  const selectedSenderDock = useMemo(() => {
    if (!selectedSenderPhone) return null
    const s = senderStatsMemo.find(x => x.phone === selectedSenderPhone)
    return s ? {
      phone: s.phone, market: s.market, state: s.state, operationalLabel: s.operationalLabel,
      performanceLabel: s.performanceLabel, sent: s.sent, delivered: s.delivered, failed: s.failed,
      deliveryPct: s.deliveryPct, failPct: s.failPct, violations21610: s.violations21610,
      optOuts: s.optOuts, lastUsed: s.lastUsed ? relTime(s.lastUsed) : null,
    } : null
  }, [selectedSenderPhone, senderStatsMemo])

  const selectedMarketDock = useMemo(() => {
    if (!selectedMarketName) return null
    const s = marketStatsMemo.find(x => x.market === selectedMarketName)
    return s ? {
      market: s.market, total: s.total, sent: s.sent, delivered: s.delivered, failed: s.failed,
      deliveryPct: s.deliveryPct, health: s.health, performanceHealth: s.performanceHealth,
      senderReadiness: s.senderReadiness, senderExists: s.senderExists, active: s.active,
      optOuts: s.optOuts, exceptionCount: s.exceptionCount, suggestedAction: s.suggestedAction,
    } : null
  }, [selectedMarketName, marketStatsMemo])

  const selectedFailureDock = useMemo(() => {
    if (!selectedFailureCause) return null
    const s = failureStatsMemo.find(x => x.cause === selectedFailureCause)
    return s ? {
      cause: s.cause, label: s.label, count: s.count, retryable: s.retryable, action: s.action,
      category: s.category, markets: s.markets, senders: s.senders,
    } : null
  }, [selectedFailureCause, failureStatsMemo])

  const tabOverview = useMemo(() => {
    const lowestTpl = [...templateStatsMemo].filter(t => t.sent >= 5).sort((a, b) => b.failPct - a.failPct)[0]
    const topFail = [...failureStatsMemo].sort((a, b) => b.count - a.count)[0]
    const oneHourAgo = Date.now() - 3600000
    const eventsLastHour = items.filter(i => i.lastEventAt && new Date(i.lastEventAt).getTime() > oneHourAgo).length
    const latestEvent = items.filter(i => i.lastEventAt).sort((a, b) => new Date(b.lastEventAt!).getTime() - new Date(a.lastEventAt!).getTime())[0]
    return {
      templates: {
        total: templateStatsMemo.length,
        healthy: templateStatsMemo.filter(t => t.health === 'healthy').length,
        degraded: templateStatsMemo.filter(t => t.health === 'degraded' || t.health === 'critical').length,
        lowest: lowestTpl ? `${truncate(lowestTpl.name, 18)} (${lowestTpl.failPct}% fail)` : undefined,
      },
      senders: {
        active: senderStatsMemo.filter(s => s.state === 'active').length,
        paused: senderStatsMemo.filter(s => s.state === 'paused').length,
        blocked: senderStatsMemo.filter(s => s.state === 'blocked').length,
        capacity: model?.safeCapacityRemaining,
      },
      markets: {
        ready: marketStatsMemo.filter(m => m.senderExists && m.active && m.health === 'healthy').length,
        degraded: marketStatsMemo.filter(m => m.health === 'degraded' || m.health === 'critical').length,
        noSender: marketStatsMemo.filter(m => !m.senderExists).length,
      },
      failures: {
        retryable: failureStatsMemo.filter(f => f.retryable).reduce((n, f) => n + f.count, 0),
        nonRetryable: failureStatsMemo.filter(f => !f.retryable).reduce((n, f) => n + f.count, 0),
        top: topFail ? `${topFail.label} (${topFail.count})` : undefined,
      },
      events: {
        perHour: eventsLastHour,
        delivered: items.filter(i => i.status === 'delivered').length,
        failed: items.filter(i => isFailed(i.status)).length,
        latest: latestEvent?.lastEventAt ? relTime(latestEvent.lastEventAt) : undefined,
      },
    }
  }, [templateStatsMemo, senderStatsMemo, marketStatsMemo, failureStatsMemo, items, model?.safeCapacityRemaining])

  const filterTabs: Array<{ key: StatusBucket; label: string; count: number; tone?: string }> = [
    { key: 'all', label: 'All', count: kpi.total },
    { key: 'scheduled', label: 'Scheduled', count: kpi.scheduled, tone: 'blue' },
    { key: 'queued', label: 'Queued', count: kpi.queued, tone: 'blue' },
    { key: 'sending', label: 'Sending', count: kpi.sending, tone: 'cyan' },
    { key: 'approval', label: 'Approval', count: kpi.approval, tone: 'amber' },
    { key: 'failed', label: 'Failed', count: kpi.failed, tone: 'red' },
    { key: 'blocked', label: 'Blocked', count: kpi.blocked, tone: 'amber' },
    { key: 'delivered', label: 'Delivered', count: kpi.delivered, tone: 'green' },
    { key: 'sent', label: 'Sent', count: kpi.sent, tone: 'green' },
  ]

  const isInitialLoad = loading && !model
  const kpiLoading = loading && !kpiIsRange

  const totalCount = model?.totalCount ?? items.length
  const totalPages = model?.totalPages ?? 1
  const rowStart = totalCount === 0 ? 0 : currentPage * pageSize + 1
  const rowEnd = Math.min((currentPage + 1) * pageSize, totalCount)

  if (isInitialLoad) {
    return (
      <div ref={rootRef} className="occ-root occ-loading is-layout-full">
        <span className="occ-spinner" />
        <p>Syncing outbound queue…</p>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className={cls(
        'occ-root',
        'is-recovery',
        `is-layout-${layoutMode}`,
        `is-pane-${paneWidth}`,
        `is-density-${density}`,
        dossierOpen && selectedItem && 'is-dossier-open',
      )}
    >
      <div className="occ-atmosphere" aria-hidden="true" />
      <QueueConfirmModal
        preview={confirmPreview}
        busy={busyAction !== null}
        onConfirm={() => { if (confirmPreview) void executeConfirmedAction() }}
        onCancel={() => setConfirmPreview(null)}
      />
      <QueueBulkActionDock
        selectedCount={selectedIds.size}
        retryEligible={bulkRetryEligible}
        nonRetryable={bulkNonRetryable}
        onRetry={() => requestBulkAction('bulk-retry')}
        onReschedule={() => requestBulkAction('bulk-reschedule')}
        onPause={() => requestBulkAction('bulk-pause')}
        onCancel={() => requestBulkAction('bulk-cancel')}
        onSuppress={() => requestBulkAction('bulk-suppress')}
        onOpenFailures={() => { setSection('failures'); setStatusFilter('failed') }}
        onClear={clearSelection}
      />

      <div className="occ-command-band">
      {/* ── Top bar ─────────────────────────────────────────────────── */}
      <div className="occ-topbar occ-command-header">
        <div className="occ-topbar__left">
          <div className="occ-command-identity">
            <h1 className="occ-topbar__title">Outbound Command Center</h1>
            <span className="occ-command-meta">
              {DATE_PRESET_LABELS[datePreset]} · {DATE_BASIS_LABELS[dateBasis]} basis
              {loading && <span className="occ-refresh-pill">Refreshing…</span>}
            </span>
          </div>
          {layoutMode !== 'compact' && (
            <DateFilter
            preset={datePreset}
            customFrom={customFrom}
            customTo={customTo}
            onPreset={p => setDatePreset(p)}
            onCustomFrom={setCustomFrom}
            onCustomTo={setCustomTo}
            />
          )}
        </div>
        <div className="occ-topbar__actions">
          <span className="occ-topbar__total">
            {rowStart}–{rowEnd} of {totalCount.toLocaleString()}
          </span>
          {layoutMode === 'full' && section === 'queue' && (
            <>
              <button
                type="button"
                className={cls('occ-action-btn is-primary', busyAction === 'retry-all-failed' && 'is-busy')}
                disabled={busyAction !== null}
                onClick={() => requestGlobalAction('retry-all-failed')}
              >
                <Icon name={busyAction === 'retry-all-failed' ? 'refresh-cw' : 'zap'} size={11} />
                {busyAction === 'retry-all-failed' ? ' Retrying…' : ' Retry Failed'}
              </button>
              <button
                type="button"
                className={cls('occ-action-btn is-secondary', busyAction === 'run-queue-now' && 'is-busy')}
                disabled={busyAction !== null}
                onClick={() => requestGlobalAction('run-queue-now')}
              >
                <Icon name={busyAction === 'run-queue-now' ? 'refresh-cw' : 'send'} size={11} />
                {busyAction === 'run-queue-now' ? ' Running…' : ' Run Queue'}
              </button>
            </>
          )}
          {import.meta.env.DEV && (
            <span className={cls('occ-runtime-dev', model?.engineMode === 'proxy' ? 'is-healthy' : 'is-degraded')} title="Runtime health">
              {model?.engineMode === 'proxy' ? 'runtime ok' : `runtime ${model?.engineMode ?? 'unknown'}`}
            </span>
          )}
          <button
            type="button"
            className={cls('occ-refresh-btn', loading && 'is-busy')}
            disabled={loading}
            title="Reload current filtered data and metrics"
            onClick={() => { setLoading(true); refreshData(currentPage) }}
          >
            <Icon name="refresh-cw" size={13} />
          </button>
        </div>
      </div>

      {/* ── KPI strip (range-accurate when server aggregation present) ── */}
      <div className="occ-kpi-strip occ-glass-rail">
        <KpiCard label="Scheduled" value={kpi.scheduled} loading={kpiLoading} tone={kpi.scheduled > 0 ? 'blue' : undefined} onClick={() => setStatusFilter('scheduled')} active={statusFilter === 'scheduled'} />
        <KpiCard label="Queued"    value={kpi.queued}    loading={kpiLoading} tone={kpi.queued > 0 ? 'blue' : undefined}      onClick={() => setStatusFilter('queued')}    active={statusFilter === 'queued'} />
        <KpiCard label="Sending"   value={kpi.sending}   loading={kpiLoading} tone={kpi.sending > 0 ? 'cyan' : undefined}     onClick={() => setStatusFilter('sending')}   active={statusFilter === 'sending'} />
        <KpiCard label="Delivered" value={kpi.delivered} loading={kpiLoading} tone={kpi.delivered > 0 ? 'green' : undefined}  onClick={() => setStatusFilter('delivered')} active={statusFilter === 'delivered'} />
        <KpiCard label="Sent"      value={kpi.sent}      loading={kpiLoading} tone={kpi.sent > 0 ? 'green' : undefined}       onClick={() => setStatusFilter('sent')}      active={statusFilter === 'sent'} />
        <KpiCard label="Failed"    value={kpi.failed}    loading={kpiLoading} tone={kpi.failed > 0 ? 'red' : undefined}       onClick={() => setStatusFilter('failed')}    active={statusFilter === 'failed'} />
        <KpiCard label="Blocked"   value={kpi.blocked}   loading={kpiLoading} tone={kpi.blocked > 0 ? 'amber' : undefined}    onClick={() => setStatusFilter('blocked')}   active={statusFilter === 'blocked'} />
        <KpiCard label="Opt-Outs"  value={kpi.optOuts}   loading={kpiLoading} tone={kpi.optOuts > 0 ? 'red' : undefined} />
        <KpiCard label="Approval"  value={kpi.approval}  loading={kpiLoading} tone={kpi.approval > 0 ? 'amber' : undefined}   onClick={() => setStatusFilter('approval')}  active={statusFilter === 'approval'} />
        <span className={cls('occ-kpi-scope', kpiIsRange && 'is-range')} title={kpiIsRange ? 'Counts reflect the entire selected date range' : 'Counts reflect the current page'}>
          {kpiIsRange ? `${DATE_PRESET_LABELS[datePreset]} range` : 'page scope'}
        </span>
      </div>
      {layoutMode !== 'compact' && (
        <QueueInlineFlow kpi={kpi} loading={kpiLoading} onFilter={key => setStatusFilter(key as StatusBucket)} />
      )}
      </div>

      {/* ── Section selector (Phase 4) ──────────────────────────────── */}
      <div className="occ-section-bar occ-glass-rail">
        <div className="occ-section-tabs" role="tablist" aria-label="Queue command views">
          {QUEUE_SECTIONS.map(s => {
            const badge = s.key === 'failures' ? kpi.failed
              : s.key === 'templates' ? templateStatsMemo.length
              : s.key === 'senders' ? senderStatsMemo.length
              : s.key === 'events' ? items.filter(i => i.lastEventAt).length
              : s.key === 'market' ? marketStatsMemo.length
              : 0
            return (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={section === s.key}
                className={cls('occ-section-tab', section === s.key && 'is-active')}
                onClick={() => {
                  setSection(s.key)
                  if (s.key !== 'queue') setSelectedId(null)
                  if (s.key !== 'templates') setSelectedTemplateId(null)
                  if (s.key !== 'senders') setSelectedSenderPhone(null)
                  if (s.key !== 'market') setSelectedMarketName(null)
                  if (s.key !== 'failures') setSelectedFailureCause(null)
                  if (s.key !== 'events') setSelectedEventItem(null)
                }}
              >
                <Icon name={s.icon as any} size={13} />
                <span>{s.label}</span>
                {badge > 0 && s.key !== 'queue' && (
                  <span className={cls('occ-section-tab__badge', s.key === 'failures' && 'is-red')}>{badge > 999 ? '999+' : badge}</span>
                )}
              </button>
            )
          })}
        </div>
        <label className="occ-date-basis">
          <span>Date basis</span>
          <select className="occ-filter-select" value={dateBasis} onChange={e => setDateBasis(e.target.value as QueueDateBasis)}>
            {(['created_at', 'scheduled_for', 'updated_at'] as QueueDateBasis[]).map(b => (
              <option key={b} value={b}>{DATE_BASIS_LABELS[b]}</option>
            ))}
          </select>
        </label>
      </div>

      {/* ── Main area ───────────────────────────────────────────────── */}
      <div className="occ-main">

        {section === 'queue' ? (
          <div className="occ-table-col">

            {/* Filter bar */}
            <div className="occ-filter-bar">
              <div className="occ-density-select" role="group" aria-label="Table density">
                {(['comfortable', 'compact', 'command'] as QueueDensity[]).map(d => (
                  <button
                    key={d}
                    type="button"
                    className={cls('occ-density-btn', density === d && 'is-active')}
                    onClick={() => setDensity(d)}
                  >
                    {d === 'comfortable' ? 'Comfortable' : d === 'compact' ? 'Compact' : 'Command'}
                  </button>
                ))}
              </div>
              {layoutMode !== 'compact' && (
              <div className="occ-filter-tabs">
                {filterTabs.map(t => (
                  <button
                    key={t.key}
                    type="button"
                    className={cls('occ-filter-tab', t.tone && t.count > 0 && `has-${t.tone}`, statusFilter === t.key && 'is-active')}
                    onClick={() => setStatusFilter(t.key)}
                  >
                    {t.label}
                    {t.count > 0 && <span className="occ-filter-tab__count">{t.count.toLocaleString()}</span>}
                  </button>
                ))}
              </div>
              )}
              <div className="occ-filter-selects">
                <select className="occ-filter-select" value={marketFilter} onChange={e => setMarketFilter(e.target.value)}>
                  {marketOptions.map(o => <option key={o} value={o}>{o === 'all' ? 'All Markets' : o}</option>)}
                </select>
                <select className="occ-filter-select" value={templateFilter} onChange={e => setTemplateFilter(e.target.value)}>
                  {templateOptions.map(o => <option key={o} value={o}>{o === 'all' ? 'All Templates' : truncate(o, 22)}</option>)}
                </select>
                <select className="occ-filter-select" value={senderFilter} onChange={e => setSenderFilter(e.target.value)}>
                  {senderOptions.map(o => <option key={o} value={o}>{o === 'all' ? 'All Senders' : `…${o.slice(-4)}`}</option>)}
                </select>
              </div>
              <input
                type="search"
                className="occ-search"
                placeholder="Search seller, property, campaign…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
            </div>

            {causeFilter && (
              <div className="occ-active-filter">
                <span className="occ-active-filter__label">Failure cause:</span>
                <span className="occ-active-filter__value">{FAILURE_CAUSE_LABEL[causeFilter] ?? causeFilter.replace(/_/g, ' ')}</span>
                <button type="button" className="occ-active-filter__clear" onClick={() => setCauseFilter(null)} aria-label="Clear cause filter">×</button>
              </div>
            )}

            <QueueExceptionBadges
              exceptions={exceptionsMemo}
              activeCause={causeFilter}
              open={exceptionsOpen}
              onToggle={() => setExceptionsOpen(v => !v)}
              onFilter={c => { setCauseFilter(c); setStatusFilter('failed') }}
            />

            {/* Table header */}
            <div className="occ-table-head">
              <label className="occ-row-check occ-row-check--head" title="Select all on page">
                <input
                  type="checkbox"
                  checked={filteredItems.length > 0 && filteredItems.every(i => selectedIds.has(i.id))}
                  onChange={() => {
                    const allSelected = filteredItems.every(i => selectedIds.has(i.id))
                    if (allSelected) setSelectedIds(new Set())
                    else setSelectedIds(new Set(filteredItems.map(i => i.id)))
                  }}
                  aria-label="Select all visible rows"
                />
              </label>
              <span>Seller / Property</span>
              <span>Stage / Touch</span>
              <span>Campaign / Market</span>
              <span>Template</span>
              <span>From</span>
              <span>Scheduled</span>
              <span>Status</span>
              <span>Failure Cause</span>
              <span>Last Event</span>
            </div>

            {/* Table body */}
            <div className={cls('occ-table-body', loading && 'is-refreshing')}>
              {filteredItems.map(item => (
                <QueueRow
                  key={item.id}
                  item={item}
                  isSelected={selectedId === item.id}
                  isExpanded={expandedId === item.id}
                  isChecked={selectedIds.has(item.id)}
                  density={density}
                  onClick={() => handleSelectRow(item)}
                  onCheck={toggleSelect}
                  onToggleExpand={handleToggleExpand}
                />
              ))}
              {filteredItems.length === 0 && (
                <div className="occ-table-empty">
                  {items.length === 0
                    ? 'No queue rows for this date range.'
                    : 'No rows match current filter.'}
                </div>
              )}
            </div>

            {/* Footer with First / Prev / Next / Last pagination */}
            <div className="occ-table-footer">
              <span className="occ-table-footer__count">
                {filteredItems.length !== items.length
                  ? `${filteredItems.length.toLocaleString()} on page match • `
                  : ''}
                Showing <strong>{rowStart.toLocaleString()}–{rowEnd.toLocaleString()}</strong> of <strong>{totalCount.toLocaleString()}</strong>
              </span>
              <div className="occ-pagination">
                <label className="occ-page-size">
                  Rows
                  <select
                    className="occ-filter-select occ-page-size__select"
                    value={pageSize}
                    onChange={e => { setPageSize(Number(e.target.value)); setCurrentPage(0) }}
                  >
                    {PAGE_SIZE_OPTIONS.map(size => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                  </select>
                </label>
                <button type="button" className="occ-page-btn" disabled={currentPage === 0} onClick={() => handlePageChange(0)}>« First</button>
                <button type="button" className="occ-page-btn" disabled={currentPage === 0} onClick={() => handlePageChange(currentPage - 1)}>‹ Prev</button>
                <span className="occ-page-info">Page {currentPage + 1} of {totalPages}</span>
                <button type="button" className="occ-page-btn" disabled={currentPage >= totalPages - 1} onClick={() => handlePageChange(currentPage + 1)}>Next ›</button>
                <button type="button" className="occ-page-btn" disabled={currentPage >= totalPages - 1} onClick={() => handlePageChange(totalPages - 1)}>Last »</button>
              </div>
            </div>
          </div>
        ) : (
          <div className="occ-section-view">
            <div className="occ-section-view__head">
              <h2 className="occ-section-view__title">
                {QUEUE_SECTIONS.find(s => s.key === section)?.label}
              </h2>
              {section !== 'templates' && (
                <span className="occ-section-view__meta">{DATE_PRESET_LABELS[datePreset]} · {items.length.toLocaleString()} rows on page</span>
              )}
              {section === 'templates' && (
                <span className="occ-section-view__meta">Template range independent · {DATE_PRESET_LABELS[datePreset]} queue context</span>
              )}
            </div>
            <div className="occ-section-view__body">
              {section === 'templates' && (
                <TemplateIntelligenceModule
                  searchParams={templateSearchParams}
                  setSearchParams={syncTemplateSearchParams}
                  globalRangeLabel={DATE_PRESET_LABELS[datePreset]}
                  onViewQueueRows={(templateId) => {
                    setTemplateFilter(templateId)
                    setSection('queue')
                  }}
                />
              )}
              {section === 'senders' && (
                <SendersModule items={items} selectedPhone={selectedSenderPhone} onSelectPhone={setSelectedSenderPhone} />
              )}
              {section === 'market' && (
                <MarketModule
                  items={items}
                  directory={model?.marketDirectory ?? []}
                  selectedMarket={selectedMarketName}
                  onSelectMarket={setSelectedMarketName}
                  onViewRows={m => { setMarketFilter(m); setSection('queue') }}
                />
              )}
              {section === 'failures' && (
                <FailureModule
                  items={items}
                  selectedCause={selectedFailureCause}
                  onSelectCause={setSelectedFailureCause}
                  onFilterCause={c => { setCauseFilter(c); setSection('queue') }}
                />
              )}
              {section === 'events' && (
                <EventTimelineModule
                  items={items}
                  density={timelineDensity}
                  onDensityChange={setTimelineDensity}
                  selectedEventId={selectedEventItem?.id ?? null}
                  onSelectEvent={setSelectedEventItem}
                  onSelectItem={id => { setSelectedId(p => p === id ? null : id); setSection('queue') }}
                />
              )}
            </div>
          </div>
        )}

        {section !== 'templates' && (layoutMode === 'full' || layoutMode === 'expanded' || dossierOpen) && (
          <CommandIntelligenceDock
            section={section}
            items={items}
            kpi={kpi}
            model={model}
            runnableCount={runnableCount}
            selectedItem={section === 'queue' ? selectedItem : null}
            selectedTemplate={null}
            selectedSender={section === 'senders' ? selectedSenderDock : null}
            selectedMarket={section === 'market' ? selectedMarketDock : null}
            selectedFailure={section === 'failures' ? selectedFailureDock : null}
            selectedEvent={section === 'events' ? selectedEventItem : null}
            tabOverview={tabOverview}
            onAction={handleAction}
            onViewFailureRows={c => { setCauseFilter(c); setSection('queue'); setStatusFilter('failed') }}
          />
        )}
        {selectedItem && (layoutMode === 'medium' || layoutMode === 'compact') && (
          <button type="button" className="occ-dossier-fab" onClick={() => setDossierOpen(v => !v)}>
            <Icon name="file-text" size={14} />
          </button>
        )}
      </div>
    </div>
  )
}

void _HeroInspector
void _IntelPanel
void _TemplateDossier
