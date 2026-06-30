import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { getSupabaseClient } from '../../lib/supabaseClient'
import {
  fetchQueueModel,
  fetchAllQueueItems,
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
import type { QueueModel, QueueItem, QueueFetchOptions, QueueDateBasis } from '../../domain/queue/queue.types'
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
import { FailureIntelligenceModule } from './components/failures/FailureIntelligenceModule'
import { EventIntelligenceModule } from './components/events/EventIntelligenceModule'
import { buildEventTimelineItems } from './event-timeline-stats'
import {
  buildFailureStats,
  deriveFailureCause,
  FAILURE_CAUSE_LABEL,
  type FailureCauseStat,
} from './failure-taxonomy-stats'
import { MarketIntelligenceModule } from './components/markets/MarketIntelligenceModule'
import { buildMarketStats, type MarketStat } from './market-fleet-stats'
import { QueueBulkActionDock } from './components/QueueBulkActionDock'
import { QueueConfirmModal } from './components/QueueConfirmModal'
import { QueueExceptionBadges } from './components/QueueExceptionBadges'
import { QueueInlineFlow } from './components/QueueInlineFlow'
import { SenderIntelligenceModule } from './components/senders/SenderIntelligenceModule'
import { buildSenderStats, type SenderStat } from './sender-fleet-stats'
import { OccQueueFilterMenu } from './components/OccQueueFilterMenu'
import { OccMobileDossierSheet } from './components/OccMobileDossierSheet'
import { OccMobileQueueCard } from './components/OccMobileQueueCard'
import { TemplateIntelligenceModule } from './components/templates/TemplateIntelligenceModule'
import './components/templates/template-intelligence.css'
import { useBreakpoint } from '../../modules/mobile/useBreakpoint'
import { useQueueLayout } from './hooks/useQueueLayout'
import type { ViewLayoutMode, ViewWidthPercent } from '../../domain/inbox/view-layout'
import {
  BLOCKED_STATUSES,
  buildBulkActionPreview,
  buildExceptionsCenter,
  buildSelectionPreview,
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
  QUEUE_DENSITY_LABEL,
  QUEUE_DENSITY_ORDER,
  queueShowsMessagePreview,
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

type DatePreset = 'today' | '24h' | '7d' | '14d' | '30d' | '60d' | '90d' | 'all' | 'custom'

const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  today: 'Today', '24h': 'Last 24h', '7d': 'Last 7d', '14d': 'Last 14d', '30d': 'Last 30d',
  '60d': 'Last 60d', '90d': 'Last 90d', all: 'All time', custom: 'Custom',
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
    : preset === '14d' ? 14 * 86400000
    : preset === '60d' ? 60 * 86400000
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
        {(['today', '24h', '7d', '14d', '30d', '60d', '90d', 'all', 'custom'] as DatePreset[]).map(p => (
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

const CmdSep = () => <span className="occ-cmd-sep" aria-hidden="true" />

const QueueCommandRow = ({
  item,
  isSelected,
  isExpanded,
  isChecked,
  onClick,
  onCheck,
  onToggleExpand,
}: {
  item: QueueItem
  isSelected: boolean
  isExpanded: boolean
  isChecked: boolean
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
  const campaignLabel = item.campaignName ?? item.automationSource ?? item.useCase ?? '—'
  const templateLabel = resolveTemplateLabel(item)
  const currentFailure = statusView.hasCurrentException ? statusView.blocking : null
  const contactOk = item.smsEligible !== false && item.routingAllowed !== false
  const propertyLine = [item.propertyAddress, cityState].filter(Boolean).join(' · ') || 'No address'
  const messageSnippet = item.messageText?.replace(/\s+/g, ' ').trim()

  return (
    <div className={cls('occ-row-wrap', 'is-density-command', isSelected && 'is-selected', isExpanded && 'is-expanded')}>
      <div className={cls('occ-row', 'occ-row--command', `is-status-${statusView.tone}`, isSelected && 'is-selected')}>
        <label className="occ-row-check occ-row-check--cmd" onClick={e => e.stopPropagation()}>
          <input type="checkbox" checked={isChecked} onChange={() => onCheck(item.id)} aria-label={`Select ${identity.primary}`} />
        </label>
        <button
          type="button"
          className="occ-cmd-strip"
          onClick={onClick}
          title={[
            identity.primary,
            propertyLine,
            `${stageLabel} · T${item.touchNumber}`,
            campaignLabel,
            templateLabel,
            messageSnippet,
          ].filter(Boolean).join(' — ')}
        >
          <span className="occ-cmd-block occ-cmd-block--identity">
            <span className="occ-asset-icon" title={asset.label} aria-hidden="true">
              <Icon name={asset.icon} size={9} />
            </span>
            <strong className="occ-cmd-val occ-cmd-val--name">{identity.primary}</strong>
            {identity.phoneEnding && <span className="occ-cmd-chip occ-cmd-chip--mono">{identity.phoneEnding}</span>}
            <span className={cls('occ-contact-indicator', contactOk ? 'is-ok' : 'is-warn')} title={contactOk ? 'SMS eligible' : 'Contact blocked'} />
          </span>
          <CmdSep />
          <span className="occ-cmd-block">
            <span className="occ-cmd-val" title={propertyLine}>{propertyLine}</span>
          </span>
          <CmdSep />
          <span className="occ-cmd-block">
            {item.stageCode
              ? <span className={cls('occ-cmd-chip', `is-${stageTone}`)} title={stageLabel}>{item.stageCode}</span>
              : <span className="occ-cmd-chip is-muted">—</span>}
            <span className="occ-cmd-chip">T{item.touchNumber}</span>
            {item.requiresApproval && <span className="occ-cmd-chip is-amber">APR</span>}
          </span>
          <CmdSep />
          <span className="occ-cmd-block">
            <span className="occ-cmd-val" title={campaignLabel}>{campaignLabel}</span>
            <span className="occ-cmd-val occ-cmd-val--dim" title={workflowLane}>{workflowLane}</span>
          </span>
          <CmdSep />
          <span className="occ-cmd-block">
            <span className="occ-cmd-val" title={templateLabel}>{templateLabel}</span>
            {messageSnippet && <span className="occ-cmd-val occ-cmd-val--msg" title={messageSnippet}>{messageSnippet}</span>}
          </span>
          <CmdSep />
          <span className="occ-cmd-block">
            <span className="occ-cmd-chip occ-cmd-chip--mono">{item.fromPhoneNumber ? fmtPhone(item.fromPhoneNumber) : '—'}</span>
            <span className="occ-cmd-val occ-cmd-val--dim" title={item.market ?? undefined}>{item.market || '—'}</span>
          </span>
          <CmdSep />
          <span className="occ-cmd-block occ-cmd-block--timing">
            <span className={cls('occ-cmd-val', item.overdue && 'is-amber')} title={item.scheduledForLocal ? new Date(item.scheduledForLocal).toLocaleString() : undefined}>
              {relTime(item.scheduledForLocal)}
            </span>
            <span className="occ-cmd-val occ-cmd-val--dim" title={item.lastEventAt ? new Date(item.lastEventAt).toLocaleString() : undefined}>
              {item.lastEventAt ? relTime(item.lastEventAt) : '—'}
            </span>
          </span>
          <CmdSep />
          <span className="occ-cmd-block occ-cmd-block--status">
            <span className={cls('occ-status-pill occ-status-pill--cmd', `is-${statusView.tone}`)}>{statusView.primary}</span>
            {currentFailure
              ? <span className={cls('occ-cmd-chip', 'is-fail', failTone && `is-${failTone}`)} title={currentFailure}>{currentFailure}</span>
              : null}
          </span>
        </button>
        <button type="button" className={cls('occ-row-expand', 'occ-row-expand--cmd', isExpanded && 'is-open')} onClick={() => onToggleExpand(item.id)} aria-label="Expand row">
          <Icon name="chevron-down" size={10} />
        </button>
      </div>
      {isExpanded && (
        <div className="occ-row-intel occ-row-intel--cmd">
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
  if (density === 'command') {
    return (
      <QueueCommandRow
        item={item}
        isSelected={isSelected}
        isExpanded={isExpanded}
        isChecked={isChecked}
        onClick={onClick}
        onCheck={onCheck}
        onToggleExpand={onToggleExpand}
      />
    )
  }

  const identity = resolveSellerIdentity(item)
  const statusView = resolveStatusPresentation(item)
  const asset = resolveAssetTypeIcon(item.propertyType)
  const failTone = item.failureGroup ? (FAILURE_TONE[item.failureGroup] ?? 'amber') : null
  const stageLabel = resolveStageLabel(item)
  const stageTone = item.stageCode ? (STAGE_TONE[item.stageCode] ?? 'muted') : 'muted'
  const cityState = [item.propertyCity, item.propertyState].filter(Boolean).join(', ')
  const workflowLane = resolveMessageSource(item)
  const campaignLabel = item.campaignName ?? item.automationSource ?? item.useCase ?? '—'
  const templateLabel = resolveTemplateLabel(item)
  const hasHistorical = statusView.historicalWarnings.length > 0
  const isOverdue = item.overdue
  const contactOk = item.smsEligible !== false && item.routingAllowed !== false
  const currentFailure = statusView.hasCurrentException ? statusView.blocking : null
  const scheduledTitle = item.scheduledForLocal ? new Date(item.scheduledForLocal).toLocaleString() : undefined
  const lastEventTitle = item.lastEventAt ? new Date(item.lastEventAt).toLocaleString() : undefined
  const showMessagePreview = queueShowsMessagePreview(density) && Boolean(item.messageText?.trim())

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
          <div className="occ-cell occ-cell--seller">
            <div className="occ-seller-line">
              <span className="occ-asset-icon" title={asset.label} aria-hidden="true">
                <Icon name={asset.icon} size={11} />
              </span>
              <strong className="occ-row-title" title={identity.primary}>{identity.primary}</strong>
              {identity.phoneEnding && <span className="occ-contact-badge">{identity.phoneEnding}</span>}
              <span className={cls('occ-contact-indicator', contactOk ? 'is-ok' : 'is-warn')} title={contactOk ? 'SMS eligible' : 'Contact blocked'} />
            </div>
            <p className="occ-row-address" title={item.propertyAddress ?? undefined}>
              {item.propertyAddress || 'No address on file'}
            </p>
            {(identity.secondary || cityState) && (
              <p className="occ-row-meta">
                {identity.secondary && <span title={identity.secondary}>{identity.secondary}</span>}
                {identity.secondary && cityState && <span className="occ-row-meta__sep">·</span>}
                {cityState && <span>{cityState}</span>}
              </p>
            )}
          </div>
          <div className="occ-cell occ-cell--workflow">
            <div className="occ-row-pill-row">
              {item.stageCode
                ? <span className={cls('occ-stage-pill', `is-${stageTone}`)}>{stageLabel}</span>
                : <span className="occ-stage-pill is-muted">No stage</span>}
              <span className="occ-touch-badge">T{item.touchNumber}</span>
              {item.requiresApproval && <span className="occ-approval-tag">Approval</span>}
            </div>
            <span className="occ-row-secondary" title={campaignLabel}>{campaignLabel}</span>
            <span className="occ-row-tertiary" title={workflowLane}>{workflowLane}</span>
          </div>
          <div className="occ-cell occ-cell--message">
            <span className="occ-row-secondary" title={templateLabel}>{templateLabel}</span>
            {showMessagePreview && (
              <p className="occ-row-preview" title={item.messageText ?? undefined}>{item.messageText}</p>
            )}
            {!showMessagePreview && item.language && (
              <span className="occ-row-tertiary">{item.language.toUpperCase()}</span>
            )}
          </div>
          <div className="occ-cell occ-cell--routing">
            <span className="occ-mono occ-row-secondary">{item.fromPhoneNumber ? fmtPhone(item.fromPhoneNumber) : '—'}</span>
            <span className="occ-row-tertiary" title={item.market ?? undefined}>{item.market || '—'}</span>
            {item.campaignTargetId && <span className="occ-row-tertiary is-linked">Target linked</span>}
          </div>
          <div className="occ-cell occ-cell--timing">
            <span className={cls('occ-row-secondary', isOverdue && 'is-amber')} title={scheduledTitle}>
              {relTime(item.scheduledForLocal)}
            </span>
            <span className="occ-row-tertiary">
              {item.timezone?.split('/').pop() ?? 'Local'}
              {isOverdue ? ' · overdue' : ''}
            </span>
            <span className="occ-row-tertiary" title={lastEventTitle}>
              Last {item.lastEventAt ? relTime(item.lastEventAt) : '—'}
              {item.lastEventType ? ` · ${item.lastEventType.replace(/_/g, ' ')}` : ''}
            </span>
          </div>
          <div className="occ-cell occ-cell--status">
            <div className="occ-row-pill-row">
              <span className={cls('occ-status-pill', `is-${statusView.tone}`)}>{statusView.primary}</span>
              {hasHistorical && (
                <span className="occ-hist-warn" title={statusView.historicalWarnings.join(' · ')}>
                  <Icon name="clock" size={10} />
                </span>
              )}
            </div>
            {currentFailure
              ? <span className={cls('occ-fail-pill', failTone && `is-${failTone}`)} title={currentFailure}>{currentFailure}</span>
              : density === 'comfortable' ? <span className="occ-row-tertiary">No active failure</span> : null}
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
  layoutMode?: ViewLayoutMode
  paneWidth?: ViewWidthPercent
}

const PAGE_SIZE = 25 // default; overridable via the page-size selector

export const QueuePage = ({
  data: initialData,
  externalContext,
  onSelectItem,
  layoutMode: layoutModeProp,
  paneWidth: paneWidthProp,
}: QueuePageProps = {}) => {
  const { rootRef, layoutMode: observedLayoutMode, paneWidth: observedPaneWidth } = useQueueLayout()
  const { isPhone } = useBreakpoint()
  const layoutMode = layoutModeProp ?? observedLayoutMode
  const paneWidth = paneWidthProp ?? observedPaneWidth
  const isMobileLayout = isPhone || layoutMode === 'compact'
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
  const [eventItems, setEventItems] = useState<QueueItem[]>([])
  const [eventItemsLoading, setEventItemsLoading] = useState(false)
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

  const eventFetchOpts = useMemo((): Omit<QueueFetchOptions, 'page'> => {
    const range = datePreset === 'all'
      ? { from: undefined, to: undefined }
      : datePreset === 'custom'
        ? {
            from: customFrom || new Date(Date.now() - 7 * 86400000).toISOString(),
            to: customTo || new Date().toISOString(),
          }
        : getPresetRange(datePreset)
    return {
      dateFrom: range.from,
      dateTo: range.to,
      dateBasis,
      status: undefined,
    }
  }, [datePreset, customFrom, customTo, dateBasis])

  useEffect(() => {
    if (section !== 'events') return
    let cancelled = false
    setEventItemsLoading(true)
    void (async () => {
      try {
        if (!shouldUseSupabase()) {
          if (!cancelled) setEventItems(adaptQueueModel().items)
          return
        }
        const all = await fetchAllQueueItems(eventFetchOpts)
        if (!cancelled) setEventItems(all)
      } catch {
        if (!cancelled) setEventItems(model?.items ?? [])
      } finally {
        if (!cancelled) setEventItemsLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [section, eventFetchOpts, model?.items])

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

  const selectedItem = model?.items.find(i => i.id === selectedId)
    ?? items.find(i => i.id === selectedId)
    ?? null

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
    const next = isMobileLayout ? item.id : (item.id === selectedId ? null : item.id)
    setSelectedId(next)
    setDossierOpen(Boolean(next))
    if (!isMobileLayout && layoutMode === 'medium') setExpandedId(next)
    if (next) {
      const ctx = buildContextFromQueueItem(item, 'queue', 'open_queue')
      window.dispatchEvent(new CustomEvent('nexus:queue-select', { detail: ctx }))
      if (!isMobileLayout) onSelectItem?.(item)
    }
  }, [selectedId, onSelectItem, layoutMode, isMobileLayout])

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

  const navigateMobileDossier = useCallback((direction: 'prev' | 'next', list: QueueItem[], currentId: string | null, select: (item: QueueItem) => void) => {
    if (!currentId) return
    const idx = list.findIndex(i => i.id === currentId)
    if (idx < 0) return
    const nextIdx = direction === 'next' ? idx + 1 : idx - 1
    if (nextIdx >= 0 && nextIdx < list.length) select(list[nextIdx])
  }, [])

  const eventTimelineItems = useMemo(
    () => buildEventTimelineItems(section === 'events' && eventItems.length > 0 ? eventItems : items),
    [section, eventItems, items],
  )

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
    if (action === 'open-queue-row') {
      setSection('queue')
      setSelectedId(id)
      setDossierOpen(true)
      setSelectedEventItem(null)
      return
    }

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
  const senderStatsMemo = useMemo(
    () => buildSenderStats(items, model?.textgridFleet ?? []),
    [items, model?.textgridFleet],
  )
  const senderFleetCount = model?.textgridFleet?.length ?? senderStatsMemo.filter((s) => s.registered).length
  const marketStatsMemo = useMemo(
    () => buildMarketStats(items, model?.marketDirectory ?? [], model?.textgridFleet ?? []),
    [items, model?.marketDirectory, model?.textgridFleet],
  )
  const marketConfiguredCount = model?.marketDirectory?.length ?? marketStatsMemo.filter((m) => m.configured).length
  const failureStatsMemo = useMemo(() => buildFailureStats(items), [items])

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
      failPct: s.failPct, deliveryPct: s.deliveryPct, health: s.health, performanceHealth: s.performanceHealth,
      senderReadiness: s.senderReadiness, senderExists: s.senderExists, active: s.active,
      senderCount: s.senderCount, messagesSentToday: s.messagesSentToday,
      optOuts: s.optOuts, violations21610: s.violations21610,
      exceptionCount: s.exceptionCount, suggestedAction: s.suggestedAction,
    } : null
  }, [selectedMarketName, marketStatsMemo])

  const selectedFailureDock = useMemo(() => {
    if (!selectedFailureCause) return null
    const s = failureStatsMemo.find(x => x.cause === selectedFailureCause)
    return s ? {
      cause: s.cause, label: s.label, count: s.count, retryable: s.retryable, action: s.action,
      category: s.category, markets: s.markets, senders: s.senders, templates: s.templates,
      pctOfTotal: s.pctOfTotal, blockedCount: s.blockedCount, failedCount: s.failedCount,
      suppression: s.suppression, severity: s.severity,
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
        isMobileLayout && 'is-mobile-layout',
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
            <h1 className="occ-topbar__title">{isMobileLayout ? 'Command Center' : 'Outbound Command Center'}</h1>
            <span className="occ-command-meta">
              {isMobileLayout
                ? `${rowStart}–${rowEnd} of ${totalCount.toLocaleString()}`
                : `${DATE_PRESET_LABELS[datePreset]} · ${DATE_BASIS_LABELS[dateBasis]} basis`}
              {loading && <span className="occ-refresh-pill">Refreshing…</span>}
            </span>
          </div>
          {!isMobileLayout && (
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
          {!isMobileLayout && (
          <span className="occ-topbar__total">
            {rowStart}–{rowEnd} of {totalCount.toLocaleString()}
          </span>
          )}
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
        {!isMobileLayout && (
          <span className={cls('occ-kpi-scope', kpiIsRange && 'is-range')} title={kpiIsRange ? 'Counts reflect the entire selected date range' : 'Counts reflect the current page'}>
            {kpiIsRange ? `${DATE_PRESET_LABELS[datePreset]} range` : 'page scope'}
          </span>
        )}
      </div>

      {isMobileLayout && (
        <div className="occ-kpi-command-footer">
          <span className={cls('occ-kpi-scope', kpiIsRange && 'is-range')} title={kpiIsRange ? 'Counts reflect the entire selected date range' : 'Counts reflect the current page'}>
            {kpiIsRange ? `${DATE_PRESET_LABELS[datePreset]} range` : 'Page scope'}
          </span>
          <div className="occ-section-tabs occ-section-tabs--dock" role="tablist" aria-label="Queue command views">
            {QUEUE_SECTIONS.map(s => {
              const badge = s.key === 'failures' ? kpi.failed
                : s.key === 'templates' ? templateStatsMemo.length
                : s.key === 'senders' ? senderFleetCount
                : s.key === 'events' ? items.filter(i => i.lastEventAt).length
                : s.key === 'market' ? marketConfiguredCount
                : 0
              return (
                <button
                  key={s.key}
                  type="button"
                  role="tab"
                  aria-selected={section === s.key}
                  className={cls('occ-section-tab', 'occ-section-tab--dock', section === s.key && 'is-active')}
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
                  <Icon name={s.icon as any} size={12} />
                  <span>{
                    s.key === 'queue' ? 'Queue'
                      : s.key === 'templates' ? 'Tpl'
                      : s.key === 'senders' ? 'Send'
                      : s.key === 'market' ? 'Mkt'
                      : s.key === 'failures' ? 'Fail'
                      : 'Evts'
                  }</span>
                  {badge > 0 && s.key !== 'queue' && (
                    <span className={cls('occ-section-tab__badge', s.key === 'failures' && 'is-red')}>{badge > 999 ? '999+' : badge}</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {!isMobileLayout && (
        <QueueInlineFlow kpi={kpi} loading={kpiLoading} onFilter={key => setStatusFilter(key as StatusBucket)} />
      )}
      </div>

      {isMobileLayout && section === 'queue' && (
        <OccQueueFilterMenu
          datePreset={datePreset}
          dateBasis={dateBasis}
          customFrom={customFrom}
          customTo={customTo}
          statusFilter={statusFilter}
          marketFilter={marketFilter}
          templateFilter={templateFilter}
          senderFilter={senderFilter}
          searchQuery={searchQuery}
          density={density}
          section={section}
          filterTabs={filterTabs}
          marketOptions={marketOptions}
          templateOptions={templateOptions}
          senderOptions={senderOptions}
          causeFilter={causeFilter}
          causeLabel={causeFilter ? (FAILURE_CAUSE_LABEL[causeFilter] ?? causeFilter.replace(/_/g, ' ')) : undefined}
          onDatePreset={setDatePreset}
          onDateBasis={setDateBasis}
          onCustomFrom={setCustomFrom}
          onCustomTo={setCustomTo}
          onStatusFilter={key => setStatusFilter(key)}
          onMarketFilter={setMarketFilter}
          onTemplateFilter={setTemplateFilter}
          onSenderFilter={setSenderFilter}
          onSearchQuery={setSearchQuery}
          onDensity={setDensity}
          onClearCause={() => setCauseFilter(null)}
        />
      )}

      {/* ── Section selector (desktop) ──────────────────────────────── */}
      {!isMobileLayout && <div className="occ-section-bar occ-glass-rail">
        <div className="occ-section-tabs" role="tablist" aria-label="Queue command views">
          {QUEUE_SECTIONS.map(s => {
            const badge = s.key === 'failures' ? kpi.failed
              : s.key === 'templates' ? templateStatsMemo.length
              : s.key === 'senders' ? senderFleetCount
              : s.key === 'events' ? items.filter(i => i.lastEventAt).length
              : s.key === 'market' ? marketConfiguredCount
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
                <span>{
                  isMobileLayout
                    ? (s.key === 'queue' ? 'Queue'
                      : s.key === 'templates' ? 'Templates'
                      : s.key === 'senders' ? 'Senders'
                      : s.key === 'market' ? 'Market'
                      : s.key === 'failures' ? 'Failures'
                      : 'Events')
                    : s.label
                }</span>
                {badge > 0 && s.key !== 'queue' && (
                  <span className={cls('occ-section-tab__badge', s.key === 'failures' && 'is-red')}>{badge > 999 ? '999+' : badge}</span>
                )}
              </button>
            )
          })}
        </div>
        <label className={cls('occ-date-basis', isMobileLayout && 'occ-date-basis--mobile')}>
          <span>{isMobileLayout ? 'Basis' : 'Date basis'}</span>
          <select className="occ-filter-select" value={dateBasis} onChange={e => setDateBasis(e.target.value as QueueDateBasis)}>
            {(['created_at', 'scheduled_for', 'updated_at'] as QueueDateBasis[]).map(b => (
              <option key={b} value={b}>{DATE_BASIS_LABELS[b]}</option>
            ))}
          </select>
        </label>
      </div>}

      {/* ── Main area ───────────────────────────────────────────────── */}
      <div className="occ-main">

        {section === 'queue' ? (
          <div className="occ-table-col">

            {/* Filter bar — desktop only; mobile uses liquid filter menu */}
            {!isMobileLayout && <div className="occ-filter-bar">
              <div className="occ-density-select" role="group" aria-label="Table density">
                  {QUEUE_DENSITY_ORDER.map(d => (
                    <button
                      key={d}
                      type="button"
                      className={cls('occ-density-btn', density === d && 'is-active')}
                      onClick={() => setDensity(d)}
                    >
                      {QUEUE_DENSITY_LABEL[d]}
                    </button>
                  ))}
                </div>
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
            </div>}

            {causeFilter && !isMobileLayout && (
              <div className="occ-active-filter">
                <span className="occ-active-filter__label">Failure cause:</span>
                <span className="occ-active-filter__value">{FAILURE_CAUSE_LABEL[causeFilter] ?? causeFilter.replace(/_/g, ' ')}</span>
                <button type="button" className="occ-active-filter__clear" onClick={() => setCauseFilter(null)} aria-label="Clear cause filter">×</button>
              </div>
            )}

            {!isMobileLayout && (
              <QueueExceptionBadges
                exceptions={exceptionsMemo}
                activeCause={causeFilter}
                open={exceptionsOpen}
                onToggle={() => setExceptionsOpen(v => !v)}
                onFilter={c => { setCauseFilter(c); setStatusFilter('failed') }}
              />
            )}

            <div className={cls('occ-table-scroll', isMobileLayout && 'is-mobile-cards')}>
            {/* Table header */}
            {!isMobileLayout && density === 'command' && (
              <div className="occ-table-head occ-table-head--cmd">
                <label className="occ-row-check occ-row-check--head occ-row-check--cmd" title="Select all on page">
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
                <span className="occ-table-head--cmd__title">Command telemetry</span>
                <span className="occ-table-head--cmd__hint">seller · property · workflow · message · routing · timing · status</span>
              </div>
            )}
            {!isMobileLayout && density !== 'command' && (
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
                <span>Workflow</span>
                <span>Message</span>
                <span>Routing</span>
                <span>Timing</span>
                <span>Status</span>
              </div>
            )}

            {/* Table body */}
            <div className={cls('occ-table-body', isMobileLayout && 'is-mobile-cards', loading && 'is-refreshing')}>
              {filteredItems.map(item => (
                isMobileLayout ? (
                  <OccMobileQueueCard
                    key={item.id}
                    item={item}
                    isSelected={selectedId === item.id}
                    isChecked={selectedIds.has(item.id)}
                    density={density}
                    onClick={() => handleSelectRow(item)}
                    onCheck={toggleSelect}
                  />
                ) : (
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
                )
              ))}
              {filteredItems.length === 0 && (
                <div className="occ-table-empty">
                  {items.length === 0
                    ? 'No queue rows for this date range.'
                    : 'No rows match current filter.'}
                </div>
              )}
            </div>
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
          <div className={cls(
            'occ-section-view',
            isMobileLayout && section === 'templates' && 'occ-section-view--tpl-mobile',
            isMobileLayout && section === 'senders' && 'occ-section-view--sender-mobile',
            isMobileLayout && section === 'market' && 'occ-section-view--market-mobile',
            isMobileLayout && section === 'failures' && 'occ-section-view--fail-mobile',
            isMobileLayout && section === 'events' && 'occ-section-view--evt-mobile',
          )}>
            {!(isMobileLayout && (section === 'templates' || section === 'senders' || section === 'market' || section === 'failures' || section === 'events')) && (
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
            )}
            <div className="occ-section-view__body">
              {section === 'templates' && (
                <TemplateIntelligenceModule
                  searchParams={templateSearchParams}
                  setSearchParams={syncTemplateSearchParams}
                  globalRangeLabel={DATE_PRESET_LABELS[datePreset]}
                  isMobileLayout={isMobileLayout}
                  onViewQueueRows={(templateId) => {
                    setTemplateFilter(templateId)
                    setSection('queue')
                  }}
                />
              )}
              {section === 'senders' && (
                <SenderIntelligenceModule
                  items={items}
                  fleet={model?.textgridFleet ?? []}
                  selectedPhone={selectedSenderPhone}
                  onSelectPhone={setSelectedSenderPhone}
                  isMobileLayout={isMobileLayout}
                  globalRangeLabel={DATE_PRESET_LABELS[datePreset]}
                />
              )}
              {section === 'market' && (
                <MarketIntelligenceModule
                  items={items}
                  directory={model?.marketDirectory ?? []}
                  fleet={model?.textgridFleet ?? []}
                  selectedMarket={selectedMarketName}
                  onSelectMarket={setSelectedMarketName}
                  onViewRows={m => { setMarketFilter(m); setSection('queue') }}
                  isMobileLayout={isMobileLayout}
                  globalRangeLabel={DATE_PRESET_LABELS[datePreset]}
                />
              )}
              {section === 'failures' && (
                <FailureIntelligenceModule
                  items={items}
                  selectedCause={selectedFailureCause}
                  onSelectCause={setSelectedFailureCause}
                  onFilterCause={c => { setCauseFilter(c); setSection('queue') }}
                  isMobileLayout={isMobileLayout}
                  globalRangeLabel={DATE_PRESET_LABELS[datePreset]}
                />
              )}
              {section === 'events' && (
                <EventIntelligenceModule
                  items={eventItems.length > 0 ? eventItems : items}
                  loading={eventItemsLoading}
                  density={timelineDensity}
                  onDensityChange={setTimelineDensity}
                  selectedEventId={selectedEventItem?.id ?? null}
                  onSelectEvent={setSelectedEventItem}
                  isMobileLayout={isMobileLayout}
                  globalRangeLabel={DATE_PRESET_LABELS[datePreset]}
                />
              )}
            </div>
          </div>
        )}

        {section !== 'templates' && !isMobileLayout && (layoutMode === 'full' || layoutMode === 'expanded' || dossierOpen) && (
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
        {isMobileLayout && section === 'queue' && selectedItem && dossierOpen && (
          <OccMobileDossierSheet
            open
            item={selectedItem}
            mode="queue"
            index={Math.max(0, filteredItems.findIndex(i => i.id === selectedItem.id))}
            total={filteredItems.length}
            onClose={() => { setSelectedId(null); setDossierOpen(false) }}
            onPrev={() => navigateMobileDossier('prev', filteredItems, selectedItem.id, handleSelectRow)}
            onNext={() => navigateMobileDossier('next', filteredItems, selectedItem.id, handleSelectRow)}
            onAction={handleAction}
          />
        )}
        {isMobileLayout && section === 'events' && selectedEventItem && (
          <OccMobileDossierSheet
            open
            item={selectedEventItem}
            mode="event"
            index={Math.max(0, eventTimelineItems.findIndex(i => i.id === selectedEventItem.id))}
            total={eventTimelineItems.length}
            onClose={() => setSelectedEventItem(null)}
            onPrev={() => navigateMobileDossier('prev', eventTimelineItems, selectedEventItem.id, setSelectedEventItem)}
            onNext={() => navigateMobileDossier('next', eventTimelineItems, selectedEventItem.id, setSelectedEventItem)}
            onAction={handleAction}
          />
        )}
      </div>
    </div>
  )
}

void _HeroInspector
void _IntelPanel
void _TemplateDossier
