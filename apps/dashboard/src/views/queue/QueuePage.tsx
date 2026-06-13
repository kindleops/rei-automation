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
import type { QueueModel, QueueItem, QueueFetchOptions } from '../../domain/queue/queue.types'
import { FAILURE_LABEL } from '../../domain/queue/classifyFailure'
import { Icon } from '../../shared/icons'
import { formatRelativeTime } from '../../shared/formatters'
import { emitNotification } from '../../shared/NotificationToast'
import { buildContextFromQueueItem } from '../../modules/inbox/active-context'
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

const pct = (num: number, den: number) =>
  den > 0 ? Math.round((num / den) * 100) : 0

// ── Date filter ────────────────────────────────────────────────────────────

type DatePreset = 'today' | '24h' | '7d' | '30d' | 'custom'

const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  today: 'Today', '24h': 'Last 24h', '7d': 'Last 7d', '30d': 'Last 30d', custom: 'Custom',
}

function getPresetRange(preset: Exclude<DatePreset, 'custom'>): { from: string; to: string } {
  const now = new Date()
  const to = now.toISOString()
  if (preset === 'today') {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
    return { from, to }
  }
  const ms = preset === '24h' ? 86400000 : preset === '7d' ? 7 * 86400000 : 30 * 86400000
  return { from: new Date(now.getTime() - ms).toISOString(), to }
}

function buildFetchOptions(
  preset: DatePreset,
  customFrom: string,
  customTo: string,
  page: number,
  pageSize: number,
): QueueFetchOptions {
  if (preset === 'custom') {
    return {
      dateFrom: customFrom || new Date(Date.now() - 7 * 86400000).toISOString(),
      dateTo: customTo || new Date().toISOString(),
      page,
      pageSize,
    }
  }
  const range = getPresetRange(preset)
  return { dateFrom: range.from, dateTo: range.to, page, pageSize }
}

// ── Status constants ───────────────────────────────────────────────────────

type StatusBucket = 'all' | 'scheduled' | 'queued' | 'sending' | 'failed' | 'blocked' | 'approval' | 'delivered' | 'sent'

const STATUS_TONE: Record<string, string> = {
  scheduled: 'blue', queued: 'blue', sending: 'cyan', sent: 'green',
  delivered: 'green', failed: 'red', retry: 'red', blocked: 'amber',
  held: 'amber', approval: 'amber', cancelled: 'muted',
  paused_name_missing: 'amber', paused_invalid_queue_row: 'amber',
  paused_max_retries: 'amber', paused_duplicate: 'amber',
  paused_global_lock: 'amber', duplicate_blocked: 'muted',
  incident_quarantine: 'red', expired: 'muted', replied_before_send: 'green',
}

const FAILURE_TONE: Record<string, string> = {
  Carrier: 'red', Compliance: 'red', Routing: 'amber',
  Template: 'amber', Payload: 'amber', Webhook: 'amber',
}

const BLOCKED_STATUSES = new Set([
  'blocked', 'paused_invalid_queue_row', 'paused_name_missing', 'paused_max_retries',
  'paused_duplicate', 'paused_global_lock', 'duplicate_blocked', 'incident_quarantine',
])

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
  deliveryPct: number
  failPct: number
  health: 'healthy' | 'watch' | 'degraded' | 'critical'
}

function buildTemplateStats(items: QueueItem[]): TemplateStat[] {
  const map = new Map<string, TemplateStat>()
  for (const i of items) {
    const id = i.templateId ?? i.selectedTemplateId ?? 'no-template'
    const name = i.templateName || 'No Template'
    const s = map.get(id) ?? { id, name, usage: 0, sent: 0, delivered: 0, failed: 0, blocked: 0, optOuts: 0, deliveryPct: 0, failPct: 0, health: 'healthy' }
    s.usage++
    if (i.status === 'sent') s.sent++
    if (i.status === 'delivered') s.delivered++
    if (i.status === 'failed' || i.status === 'retry') s.failed++
    if (BLOCKED_STATUSES.has(i.status)) s.blocked++
    if (i.failureCategory === 'recipient_opted_out' || i.failureCategory === 'blacklist_pair_21610') s.optOuts++
    map.set(id, s)
  }
  return Array.from(map.values()).map(s => {
    const denom = s.sent + s.delivered + s.failed
    s.deliveryPct = pct(s.delivered, denom)
    s.failPct = pct(s.failed, denom)
    s.health = healthFromPct(s.failPct)
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
  health: 'healthy' | 'watch' | 'degraded' | 'critical'
  lastUsed: string | null
  state: 'active' | 'paused' | 'degraded' | 'blocked'
}

function buildSenderStats(items: QueueItem[]): SenderStat[] {
  const map = new Map<string, SenderStat>()
  for (const i of items) {
    const phone = i.fromPhoneNumber || 'unknown'
    if (phone === 'unknown') continue
    const s = map.get(phone) ?? {
      phone, market: i.market || '—', sent: 0, delivered: 0, failed: 0, blocked: 0,
      optOuts: 0, violations21610: 0, deliveryPct: 0, failPct: 0,
      health: 'healthy', lastUsed: null, state: 'active',
    }
    if (i.status === 'sent') s.sent++
    if (i.status === 'delivered') s.delivered++
    if (i.status === 'failed' || i.status === 'retry') s.failed++
    if (BLOCKED_STATUSES.has(i.status)) s.blocked++
    if (i.failureCategory === 'recipient_opted_out') s.optOuts++
    if (i.failureCategory === 'blacklist_pair_21610') s.violations21610++
    const ts = i.lastEventAt || i.sentAt || i.updatedAt
    if (ts && (!s.lastUsed || ts > s.lastUsed)) s.lastUsed = ts
    if (!s.market || s.market === '—') s.market = i.market || '—'
    map.set(phone, s)
  }
  return Array.from(map.values()).map(s => {
    const denom = s.sent + s.delivered + s.failed
    s.deliveryPct = pct(s.delivered, denom)
    s.failPct = pct(s.failed, denom)
    s.health = s.violations21610 > 0 ? 'critical' : healthFromPct(s.failPct)
    const hasActive = items.some(i => i.fromPhoneNumber === s.phone && ['scheduled', 'queued', 'ready'].includes(i.status))
    s.state = s.violations21610 > 0 ? 'blocked' : s.health === 'critical' ? 'degraded' : hasActive ? 'active' : 'paused'
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
  health: 'healthy' | 'watch' | 'degraded' | 'critical'
}

function buildMarketStats(items: QueueItem[]): MarketStat[] {
  const map = new Map<string, MarketStat>()
  for (const i of items) {
    const m = i.market || 'Unknown'
    const s = map.get(m) ?? { market: m, total: 0, sent: 0, delivered: 0, failed: 0, blocked: 0, optOuts: 0, deliveryPct: 0, health: 'healthy' }
    s.total++
    if (i.status === 'sent') s.sent++
    if (i.status === 'delivered') s.delivered++
    if (i.status === 'failed' || i.status === 'retry') s.failed++
    if (BLOCKED_STATUSES.has(i.status)) s.blocked++
    if (i.failureCategory === 'recipient_opted_out' || i.failureCategory === 'blacklist_pair_21610') s.optOuts++
    map.set(m, s)
  }
  return Array.from(map.values()).map(s => {
    const denom = s.sent + s.delivered + s.failed
    s.deliveryPct = pct(s.delivered, denom)
    s.health = healthFromPct(pct(s.failed, denom))
    return s
  }).sort((a, b) => b.total - a.total)
}

// ── KPI Card ────────────────────────────────────────────────────────────────

interface KpiCardProps { label: string; value: number | string; tone?: string; onClick?: () => void; active?: boolean; sub?: string }

const KpiCard = ({ label, value, tone, onClick, active, sub }: KpiCardProps) => (
  <button
    type="button"
    className={cls('occ-kpi', tone && `is-${tone}`, active && 'is-active', onClick && 'is-clickable')}
    onClick={onClick}
    disabled={!onClick}
  >
    <span className="occ-kpi__value">{value}</span>
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
        {(['today', '24h', '7d', '30d', 'custom'] as DatePreset[]).map(p => (
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

const HeroInspector = ({
  item,
  onAction,
}: {
  item: QueueItem | null
  onAction: (action: string, id: string) => void
}) => {
  if (!item) return null
  const tone = STATUS_TONE[item.status] ?? 'muted'
  const failLabel = item.failureCategory ? (FAILURE_LABEL[item.failureCategory] ?? item.failureCategory.replace(/_/g, ' ')) : null
  const originLabel = item.automationSource || item.rowSource?.replace(/_/g, ' ') || 'Legacy Queue Row'

  return (
    <aside className="occ-inspector occ-dossier">
      <div className="occ-dossier__header">
        <div className="occ-dossier__identity">
          <strong className="occ-dossier__seller">{truncate(item.sellerName, 30)}</strong>
          <span className={cls('occ-status-pill', `is-${tone}`)}>{item.status.replace(/_/g, ' ')}</span>
        </div>
        <button type="button" className="occ-inspector__close" onClick={() => onAction('deselect', item.id)}>
          <Icon name="close" size={12} />
        </button>
      </div>

      <div className="occ-inspector__body">

        {/* Identity */}
        <div className="occ-insp-section">
          <div className="occ-insp-section-title">Identity</div>
          <InspRow label="Full Name" value={item.sellerFullName || item.sellerName} />
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
          <InspRow label="Status" value={item.status.replace(/_/g, ' ')} tone={tone} />
          <InspRow label="Provider Status" value={item.deliveryStatus} tone={item.deliveryStatus === 'delivered' ? 'green' : item.deliveryStatus === 'failed' ? 'red' : undefined} />
          {item.providerMessageId && <InspRow label="SID" value={truncate(item.providerMessageId, 22)} mono />}
          {item.textgridMessageId && <InspRow label="TG Message ID" value={truncate(item.textgridMessageId, 22)} mono />}
          {item.sentAt && <InspRow label="Sent At" value={relTime(item.sentAt)} />}
          {item.deliveredAt && <InspRow label="Delivered At" value={relTime(item.deliveredAt)} />}
          <InspRow label="Retries" value={`${item.retryCount} / ${item.maxRetries}`} />
          <InspRow label="Retry Eligible" value={item.retryEligible ? 'Yes' : 'No'} tone={item.retryEligible ? 'green' : undefined} />
        </div>

        {/* Failure details */}
        {(failLabel || item.pausedReason || item.blockedReason || item.guardReason) && (
          <div className="occ-insp-section occ-insp-section--failure">
            <div className="occ-insp-section-title">Failure Details</div>
            {failLabel && <InspRow label="Cause" value={failLabel} tone="red" />}
            {item.failedReason && <InspRow label="Raw" value={truncate(item.failedReason, 48)} tone="red" />}
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
        {(item.status === 'failed' || item.status === 'retry') && item.retryEligible && (
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

const IntelPanel = ({
  items,
  onGlobalAction,
}: {
  items: QueueItem[]
  onGlobalAction: (action: string) => void
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

  return (
    <aside className="occ-inspector occ-intel">
      <div className="occ-intel__head">
        <span className="occ-intel__title">QUEUE INTELLIGENCE</span>
        <span className="occ-intel__sub">Select a row for dossier</span>
      </div>
      <div className="occ-inspector__body">

        <div className="occ-insp-section">
          <div className="occ-insp-section-title">Live Ops / Hour</div>
          <div className="occ-intel-grid">
            {[
              { val: activeSenders, lbl: 'Active Senders', tone: activeSenders > 0 ? '' : '' },
              { val: deliveredLastHour, lbl: 'Delivered', tone: deliveredLastHour > 0 ? 'green' : '' },
              { val: failedLastHour, lbl: 'Failed', tone: failedLastHour > 0 ? 'red' : '' },
              { val: optOutsLastHour, lbl: 'Opt-Outs', tone: optOutsLastHour > 0 ? 'red' : '' },
              { val: pendingRetries, lbl: 'Pending Retry', tone: pendingRetries > 0 ? 'amber' : '' },
              { val: blockedContacts, lbl: 'Blocked', tone: blockedContacts > 10 ? 'amber' : '' },
            ].map(({ val, lbl, tone }) => (
              <div key={lbl} className={cls('occ-intel-stat', tone && `is-${tone}`)}>
                <span className="occ-intel-stat__val">{val}</span>
                <span className="occ-intel-stat__lbl">{lbl}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="occ-insp-section">
          <div className="occ-insp-section-title">Global Controls</div>
          <div className="occ-intel-actions">
            <button className="occ-action-btn is-primary" onClick={() => onGlobalAction('retry-all-failed')}>
              <Icon name="zap" size={11} /> Retry All Failed
            </button>
            <button className="occ-action-btn is-secondary" onClick={() => onGlobalAction('run-queue-now')}>
              <Icon name="send" size={11} /> Run Queue
            </button>
          </div>
        </div>

        {topFailures.length > 0 && (
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

const TemplatesModule = ({ items }: { items: QueueItem[] }) => {
  const stats = useMemo(() => buildTemplateStats(items), [items])

  return (
    <div className="occ-module">
      <div className="occ-module-head">
        <div className="occ-module-col occ-col-name">Template</div>
        <div className="occ-module-col occ-col-num">Usage</div>
        <div className="occ-module-col occ-col-num">Sent</div>
        <div className="occ-module-col occ-col-num">Del</div>
        <div className="occ-module-col occ-col-num">Fail</div>
        <div className="occ-module-col occ-col-num">Blk</div>
        <div className="occ-module-col occ-col-num">Opt-Outs</div>
        <div className="occ-module-col occ-col-pct">Del%</div>
        <div className="occ-module-col occ-col-pct">Fail%</div>
        <div className="occ-module-col occ-col-badge">Health</div>
      </div>
      <div className="occ-module-body">
        {stats.length === 0 && (
          <div className="occ-module-empty">No template data for this date range.</div>
        )}
        {stats.map(s => (
          <div key={s.id} className="occ-module-row">
            <div className="occ-module-col occ-col-name occ-col-name--strong">
              <span>{truncate(s.name, 28)}</span>
              {s.id !== 'no-template' && <small className="occ-mono">{truncate(s.id, 20)}</small>}
            </div>
            <div className="occ-module-col occ-col-num">{s.usage}</div>
            <div className="occ-module-col occ-col-num">{s.sent}</div>
            <div className="occ-module-col occ-col-num is-green">{s.delivered}</div>
            <div className={cls('occ-module-col occ-col-num', s.failed > 0 && 'is-red')}>{s.failed}</div>
            <div className={cls('occ-module-col occ-col-num', s.blocked > 0 && 'is-amber')}>{s.blocked}</div>
            <div className={cls('occ-module-col occ-col-num', s.optOuts > 0 && 'is-red')}>{s.optOuts}</div>
            <div className={cls('occ-module-col occ-col-pct', s.deliveryPct > 70 ? 'is-green' : s.deliveryPct > 40 ? 'is-amber' : 'is-red')}>
              {s.deliveryPct}%
            </div>
            <div className={cls('occ-module-col occ-col-pct', s.failPct > 15 ? 'is-red' : s.failPct > 5 ? 'is-amber' : '')}>
              {s.failPct}%
            </div>
            <div className="occ-module-col occ-col-badge">
              <span className={cls('occ-health-badge', `is-${HEALTH_TONE[s.health]}`)}>{s.health}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Sender Numbers Module ───────────────────────────────────────────────────

const SendersModule = ({ items }: { items: QueueItem[] }) => {
  const stats = useMemo(() => buildSenderStats(items), [items])

  const STATE_TONE: Record<string, string> = { active: 'green', paused: 'muted', degraded: 'amber', blocked: 'red' }

  return (
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
          <div key={s.phone} className="occ-module-row">
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
              <span className={cls('occ-health-badge', `is-${HEALTH_TONE[s.health]}`)}>{s.health}</span>
            </div>
            <div className="occ-module-col occ-col-small">{relTime(s.lastUsed)}</div>
            <div className="occ-module-col occ-col-badge">
              <span className={cls('occ-state-badge', `is-${STATE_TONE[s.state] ?? 'muted'}`)}>{s.state}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Market Health Module ────────────────────────────────────────────────────

const MarketModule = ({ items }: { items: QueueItem[] }) => {
  const stats = useMemo(() => buildMarketStats(items), [items])

  return (
    <div className="occ-module">
      <div className="occ-module-head">
        <div className="occ-module-col occ-col-name">Market</div>
        <div className="occ-module-col occ-col-num">Total</div>
        <div className="occ-module-col occ-col-num">Sent</div>
        <div className="occ-module-col occ-col-num">Del</div>
        <div className="occ-module-col occ-col-num">Fail</div>
        <div className="occ-module-col occ-col-num">Blk</div>
        <div className="occ-module-col occ-col-num">Opt-Outs</div>
        <div className="occ-module-col occ-col-pct">Del%</div>
        <div className="occ-module-col occ-col-badge">Health</div>
      </div>
      <div className="occ-module-body">
        {stats.length === 0 && (
          <div className="occ-module-empty">No market data for this date range.</div>
        )}
        {stats.map(s => (
          <div key={s.market} className="occ-module-row">
            <div className="occ-module-col occ-col-name occ-col-name--strong">{truncate(s.market, 20)}</div>
            <div className="occ-module-col occ-col-num">{s.total}</div>
            <div className="occ-module-col occ-col-num">{s.sent}</div>
            <div className="occ-module-col occ-col-num is-green">{s.delivered}</div>
            <div className={cls('occ-module-col occ-col-num', s.failed > 0 && 'is-red')}>{s.failed}</div>
            <div className={cls('occ-module-col occ-col-num', s.blocked > 0 && 'is-amber')}>{s.blocked}</div>
            <div className={cls('occ-module-col occ-col-num', s.optOuts > 0 && 'is-red')}>{s.optOuts}</div>
            <div className={cls('occ-module-col occ-col-pct', s.deliveryPct > 70 ? 'is-green' : s.deliveryPct > 40 ? 'is-amber' : 'is-red')}>
              {s.deliveryPct}%
            </div>
            <div className="occ-module-col occ-col-badge">
              <span className={cls('occ-health-badge', `is-${HEALTH_TONE[s.health]}`)}>{s.health}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Failure Taxonomy Module ─────────────────────────────────────────────────

const FailureModule = ({ items, onFilterStatus }: { items: QueueItem[]; onFilterStatus: (s: StatusBucket) => void }) => {
  const groups = useMemo(() => {
    const map = new Map<string, { label: string; group: string; count: number }>()
    for (const i of items) {
      if (i.status === 'failed' || i.status === 'retry' || BLOCKED_STATUSES.has(i.status)) {
        const cat = i.failureCategory ?? 'unknown'
        const label = FAILURE_LABEL[cat] ?? cat.replace(/_/g, ' ')
        const existing = map.get(cat)
        map.set(cat, { label, group: i.failureGroup ?? 'Unknown', count: (existing?.count ?? 0) + 1 })
      }
    }
    return Array.from(map.entries()).sort((a, b) => b[1].count - a[1].count)
  }, [items])

  return (
    <div className="occ-module occ-module--failure">
      {groups.length === 0 && (
        <div className="occ-module-empty">No failure data for this date range.</div>
      )}
      <div className="occ-failure-grid">
        {groups.map(([cat, { label, group, count }]) => {
          const tone = FAILURE_TONE[group] ?? 'amber'
          return (
            <button
              key={cat}
              type="button"
              className="occ-failure-chip"
              onClick={() => onFilterStatus('failed')}
            >
              <span className={cls('occ-failure-chip__dot', `is-${tone}`)} />
              <span className="occ-failure-chip__label">{label}</span>
              <span className="occ-failure-chip__group">{group}</span>
              <span className={cls('occ-failure-chip__count', `is-${tone}`)}>{count}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Event Timeline Module ───────────────────────────────────────────────────

const EVENT_ICON: Record<string, string> = {
  sent: 'send', delivered: 'check', failed: 'alert-circle', retry: 'refresh-cw',
  scheduled: 'clock', queued: 'clock', blocked: 'shield', cancelled: 'close',
  approval: 'zap', held: 'pause', replied_before_send: 'message',
}

const EventTimelineModule = ({
  items,
  onSelectItem,
}: {
  items: QueueItem[]
  onSelectItem: (id: string) => void
}) => {
  const events = useMemo(() =>
    [...items]
      .filter(i => i.lastEventAt || i.updatedAt)
      .sort((a, b) => new Date(b.lastEventAt ?? b.updatedAt).getTime() - new Date(a.lastEventAt ?? a.updatedAt).getTime())
      .slice(0, 25)
  , [items])

  return (
    <div className="occ-module occ-module--timeline">
      {events.length === 0 && (
        <div className="occ-module-empty">No events for this date range.</div>
      )}
      <div className="occ-timeline">
        {events.map(i => {
          const tone = STATUS_TONE[i.status] ?? 'muted'
          const iconName = EVENT_ICON[i.status] ?? 'zap'
          return (
            <button
              key={i.id}
              type="button"
              className="occ-timeline-row"
              onClick={() => onSelectItem(i.id)}
            >
              <div className={cls('occ-timeline-icon', `is-${tone}`)}>
                <Icon name={iconName as any} size={10} />
              </div>
              <div className="occ-timeline-connector" />
              <div className="occ-timeline-content">
                <div className="occ-timeline-main">
                  <strong className="occ-timeline-seller">{truncate(i.sellerName, 24)}</strong>
                  <span className={cls('occ-status-pill', `is-${tone}`)}>{i.status.replace(/_/g, ' ')}</span>
                </div>
                <div className="occ-timeline-meta">
                  <span>{truncate(i.market, 14)}</span>
                  {i.campaignName && <span>· {truncate(i.campaignName, 18)}</span>}
                  {i.templateName && i.templateName !== 'Template not attached' && (
                    <span>· {truncate(i.templateName, 16)}</span>
                  )}
                </div>
              </div>
              <span className="occ-timeline-time">{relTime(i.lastEventAt ?? i.updatedAt)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Bottom Module Tabs ──────────────────────────────────────────────────────

type BottomTab = 'templates' | 'senders' | 'market' | 'failures' | 'events'

const BOTTOM_TABS: Array<{ key: BottomTab; label: string }> = [
  { key: 'templates', label: 'Templates' },
  { key: 'senders', label: 'TextGrid Numbers' },
  { key: 'market', label: 'Market Health' },
  { key: 'failures', label: 'Failure Taxonomy' },
  { key: 'events', label: 'Event Timeline' },
]

// ── Queue Table Row ─────────────────────────────────────────────────────────

const QueueRow = ({
  item,
  isSelected,
  onClick,
}: {
  item: QueueItem
  isSelected: boolean
  onClick: () => void
}) => {
  const tone = STATUS_TONE[item.status] ?? 'muted'
  const hasDiag = item.diagnosticFlags.length > 0
  const failLabel = item.failureCategory ? (FAILURE_LABEL[item.failureCategory] ?? item.failureCategory.replace(/_/g, ' ')) : null
  const failTone = item.failureGroup ? (FAILURE_TONE[item.failureGroup] ?? 'amber') : null

  return (
    <button
      type="button"
      className={cls('occ-row', isSelected && 'is-selected', hasDiag && 'has-diag')}
      onClick={onClick}
    >
      <div className="occ-cell occ-cell--seller">
        <strong className={hasDiag ? 'is-amber' : ''}>{truncate(item.sellerName, 24)}</strong>
        <small>{truncate(item.propertyAddress, 28)}</small>
      </div>
      <div className="occ-cell occ-cell--campaign">
        <span>{truncate(item.campaignName ?? item.automationSource ?? item.useCase, 18)}</span>
        <small>{truncate(item.market, 14)}</small>
      </div>
      <div className="occ-cell occ-cell--template">
        {truncate(item.templateName, 20)}
      </div>
      <div className="occ-cell occ-cell--from occ-mono">
        {fmtPhone(item.fromPhoneNumber)}
      </div>
      <div className="occ-cell occ-cell--scheduled">
        {relTime(item.scheduledForLocal)}
      </div>
      <div className="occ-cell occ-cell--status">
        <span className={cls('occ-status-pill', `is-${tone}`)}>
          {item.status.replace(/_/g, ' ')}
        </span>
      </div>
      <div className="occ-cell occ-cell--failure">
        {failLabel
          ? <span className={cls('occ-fail-pill', failTone && `is-${failTone}`)}>{failLabel}</span>
          : <span className="occ-fail-pill" style={{ opacity: 0.3 }}>—</span>
        }
      </div>
      <div className="occ-cell occ-cell--event">
        {item.lastEventAt ? relTime(item.lastEventAt) : '—'}
      </div>
    </button>
  )
}

// ── Main Page ───────────────────────────────────────────────────────────────

interface QueuePageProps {
  data?: QueueModel
  onSelectItem?: (item: QueueItem) => void
}

const PAGE_SIZE = 500

export const QueuePage = ({ data: initialData, onSelectItem }: QueuePageProps = {}) => {
  const [loading, setLoading] = useState(!initialData)
  const [model, setModel] = useState<QueueModel | null>(initialData ?? null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusBucket>('all')
  const [marketFilter, setMarketFilter] = useState('all')
  const [templateFilter, setTemplateFilter] = useState('all')
  const [senderFilter, setSenderFilter] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(0)
  const [datePreset, setDatePreset] = useState<DatePreset>('7d')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [activeBottomTab, setActiveBottomTab] = useState<BottomTab>('templates')
  const [bottomExpanded, setBottomExpanded] = useState(true)
  const realtimeRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dateFilterMounted = useRef(false)

  const buildOpts = useCallback(
    (page: number) => buildFetchOptions(datePreset, customFrom, customTo, page, PAGE_SIZE),
    [datePreset, customFrom, customTo]
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

  // Re-fetch when date filter changes — skip initial mount; also skip if custom preset has no dates
  useEffect(() => {
    if (!dateFilterMounted.current) { dateFilterMounted.current = true; return }
    if (datePreset === 'custom' && !customFrom && !customTo) return
    setCurrentPage(0)
    setLoading(true)
    refreshData(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datePreset, customFrom, customTo])

  const items = model?.items ?? []

  // ── Derived counts ──────────────────────────────────────────────────────
  const counts = useMemo(() => {
    const c = {
      scheduled: 0, queued: 0, sending: 0, sent: 0,
      delivered: 0, failed: 0, blocked: 0, approval: 0, optOuts: 0, total: items.length,
    }
    for (const i of items) {
      if (i.status === 'scheduled') c.scheduled++
      else if (i.status === 'queued') c.queued++
      else if (i.status === 'sending') c.sending++
      else if (i.status === 'sent') c.sent++
      else if (i.status === 'delivered') c.delivered++
      else if (i.status === 'failed' || i.status === 'retry') c.failed++
      else if (BLOCKED_STATUSES.has(i.status)) c.blocked++
      else if (i.status === 'approval') c.approval++
      if (i.failureCategory === 'recipient_opted_out' || i.failureCategory === 'blacklist_pair_21610') c.optOuts++
    }
    return c
  }, [items])

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
      if (statusFilter === 'failed') result = result.filter(i => i.status === 'failed' || i.status === 'retry')
      else if (statusFilter === 'blocked') result = result.filter(i => BLOCKED_STATUSES.has(i.status))
      else result = result.filter(i => i.status === statusFilter)
    }
    if (marketFilter !== 'all') result = result.filter(i => i.market === marketFilter)
    if (templateFilter !== 'all') result = result.filter(i => i.templateName === templateFilter)
    if (senderFilter !== 'all') result = result.filter(i => i.fromPhoneNumber === senderFilter)
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
  }, [items, statusFilter, marketFilter, templateFilter, senderFilter, searchQuery])

  const selectedItem = model?.items.find(i => i.id === selectedId) ?? null

  // ── Row click — select + dispatch global property context ────────────────
  const handleSelectRow = useCallback((item: QueueItem) => {
    const next = item.id === selectedId ? null : item.id
    setSelectedId(next)
    if (next) {
      // Global property selection — dispatch custom event for cross-module sync
      const ctx = buildContextFromQueueItem(item, 'queue', 'open_queue')
      window.dispatchEvent(new CustomEvent('nexus:queue-select', { detail: ctx }))
      onSelectItem?.(item)
    }
  }, [selectedId, onSelectItem])

  // ── Pagination controls ──────────────────────────────────────────────────
  const handlePageChange = useCallback((page: number) => {
    setCurrentPage(page)
    setLoading(true)
    refreshData(page)
  }, [refreshData])

  // ── Row + global actions ─────────────────────────────────────────────────
  const handleAction = useCallback(async (action: string, id: string) => {
    if (action === 'deselect') { setSelectedId(null); return }

    if (action === 'retry-all-failed') {
      try {
        const res = await retryAllFailed()
        emitNotification({ title: res.ok ? 'Retry queued' : 'Retry failed', detail: res.errorMessage ?? 'Done', severity: res.ok ? 'success' : 'critical', sound: res.ok ? 'notification' : undefined })
        if (res.ok) refreshData(currentPage)
      } catch { emitNotification({ title: 'Error', detail: 'Could not reach backend', severity: 'critical' }) }
      return
    }

    if (action === 'run-queue-now') {
      try {
        const res = await runQueueOnce()
        emitNotification({ title: res.ok ? 'Queue run triggered' : 'Run failed', detail: res.errorMessage ?? 'Processing started', severity: res.ok ? 'success' : 'critical', sound: res.ok ? 'notification' : undefined })
        if (res.ok) setTimeout(() => refreshData(currentPage), 3000)
      } catch { emitNotification({ title: 'Error', detail: 'Could not reach backend', severity: 'critical' }) }
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
  const filterTabs: Array<{ key: StatusBucket; label: string; count: number; tone?: string }> = [
    { key: 'all', label: 'All', count: counts.total },
    { key: 'scheduled', label: 'Scheduled', count: counts.scheduled, tone: 'blue' },
    { key: 'queued', label: 'Queued', count: counts.queued, tone: 'blue' },
    { key: 'sending', label: 'Sending', count: counts.sending, tone: 'cyan' },
    { key: 'approval', label: 'Approval', count: counts.approval, tone: 'amber' },
    { key: 'failed', label: 'Failed', count: counts.failed, tone: 'red' },
    { key: 'blocked', label: 'Blocked', count: counts.blocked, tone: 'amber' },
    { key: 'delivered', label: 'Delivered', count: counts.delivered, tone: 'green' },
    { key: 'sent', label: 'Sent', count: counts.sent, tone: 'green' },
  ]

  if (loading) {
    return (
      <div className="occ-root occ-loading">
        <span className="occ-spinner" />
        <p>Syncing outbound queue…</p>
      </div>
    )
  }

  const totalCount = model?.totalCount ?? items.length
  const totalPages = model?.totalPages ?? 1
  const rowStart = currentPage * PAGE_SIZE + 1
  const rowEnd = Math.min((currentPage + 1) * PAGE_SIZE, totalCount)

  return (
    <div className="occ-root">

      {/* ── Top bar ─────────────────────────────────────────────────── */}
      <div className="occ-topbar">
        <div className="occ-topbar__left">
          <h1 className="occ-topbar__title">OUTBOUND COMMAND CENTER</h1>
          <DateFilter
            preset={datePreset}
            customFrom={customFrom}
            customTo={customTo}
            onPreset={p => setDatePreset(p)}
            onCustomFrom={setCustomFrom}
            onCustomTo={setCustomTo}
          />
        </div>
        <div className="occ-topbar__actions">
          <span className="occ-topbar__total">
            {rowStart}–{rowEnd} of {totalCount.toLocaleString()}
          </span>
          <button type="button" className="occ-action-btn is-primary" onClick={() => handleAction('retry-all-failed', '')}>
            <Icon name="zap" size={11} /> Retry Failed
          </button>
          <button type="button" className="occ-action-btn is-secondary" onClick={() => handleAction('run-queue-now', '')}>
            <Icon name="send" size={11} /> Run Queue
          </button>
          <button type="button" className="occ-refresh-btn" onClick={() => refreshData(currentPage)}>
            <Icon name="refresh-cw" size={13} />
          </button>
        </div>
      </div>

      {/* ── KPI strip ────────────────────────────────────────────────── */}
      {/* Counts below are page-scoped (current loaded rows). Total row count is shown in the pagination bar. */}
      <div className="occ-kpi-strip">
        <KpiCard label="Scheduled" value={counts.scheduled} tone={counts.scheduled > 0 ? 'blue' : undefined} onClick={() => setStatusFilter('scheduled')} active={statusFilter === 'scheduled'} />
        <KpiCard label="Queued"    value={counts.queued}    tone={counts.queued > 0 ? 'blue' : undefined}      onClick={() => setStatusFilter('queued')}    active={statusFilter === 'queued'} />
        <KpiCard label="Sending"   value={counts.sending}   tone={counts.sending > 0 ? 'cyan' : undefined}     onClick={() => setStatusFilter('sending')}   active={statusFilter === 'sending'} />
        <KpiCard label="Delivered" value={counts.delivered} tone={counts.delivered > 0 ? 'green' : undefined}  onClick={() => setStatusFilter('delivered')} active={statusFilter === 'delivered'} />
        <KpiCard label="Sent"      value={counts.sent}      tone={counts.sent > 0 ? 'green' : undefined}       onClick={() => setStatusFilter('sent')}      active={statusFilter === 'sent'} />
        <KpiCard label="Failed"    value={counts.failed}    tone={counts.failed > 0 ? 'red' : undefined}       onClick={() => setStatusFilter('failed')}    active={statusFilter === 'failed'} />
        <KpiCard label="Blocked"   value={counts.blocked}   tone={counts.blocked > 0 ? 'amber' : undefined}    onClick={() => setStatusFilter('blocked')}   active={statusFilter === 'blocked'} />
        <KpiCard label="Opt-Outs"  value={counts.optOuts}   tone={counts.optOuts > 0 ? 'red' : undefined} />
        <KpiCard label="Approval"  value={counts.approval}  tone={counts.approval > 0 ? 'amber' : undefined}   onClick={() => setStatusFilter('approval')}  active={statusFilter === 'approval'} />
        {totalPages > 1 && (
          <span className="occ-kpi-page-scope" title={`These counts reflect the current page (${rowStart}–${rowEnd} of ${totalCount.toLocaleString()} total rows)`}>
            pg.&nbsp;{currentPage + 1}&nbsp;/&nbsp;{totalPages}
          </span>
        )}
      </div>

      {/* ── Main split: table + inspector ────────────────────────────── */}
      <div className="occ-main">

        {/* Table column */}
        <div className="occ-table-col">

          {/* Filter bar */}
          <div className="occ-filter-bar">
            <div className="occ-filter-tabs">
              {filterTabs.map(t => (
                <button
                  key={t.key}
                  type="button"
                  className={cls('occ-filter-tab', t.tone && t.count > 0 && `has-${t.tone}`, statusFilter === t.key && 'is-active')}
                  onClick={() => setStatusFilter(t.key)}
                >
                  {t.label}
                  {t.count > 0 && <span className="occ-filter-tab__count">{t.count}</span>}
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
          </div>

          {/* Table header */}
          <div className="occ-table-head">
            <span>Seller / Property</span>
            <span>Campaign / Market</span>
            <span>Template</span>
            <span>From</span>
            <span>Scheduled</span>
            <span>Status</span>
            <span>Failure Cause</span>
            <span>Last Event</span>
          </div>

          {/* Table body */}
          <div className="occ-table-body">
            {filteredItems.map(item => (
              <QueueRow
                key={item.id}
                item={item}
                isSelected={selectedId === item.id}
                onClick={() => handleSelectRow(item)}
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

          {/* Table footer with pagination */}
          <div className="occ-table-footer">
            <span className="occ-table-footer__count">
              {filteredItems.length !== items.length
                ? `Showing ${filteredItems.length.toLocaleString()} matches • `
                : ''
              }
              Displaying {rowStart}–{rowEnd} of {totalCount.toLocaleString()} total queue items
            </span>
            {totalPages > 1 && (
              <div className="occ-pagination">
                <button
                  type="button"
                  className="occ-page-btn"
                  disabled={currentPage === 0}
                  onClick={() => handlePageChange(currentPage - 1)}
                >
                  ‹ Prev
                </button>
                <span className="occ-page-info">
                  Page {currentPage + 1} of {totalPages}
                </span>
                <button
                  type="button"
                  className="occ-page-btn"
                  disabled={currentPage >= totalPages - 1}
                  onClick={() => handlePageChange(currentPage + 1)}
                >
                  Next ›
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Inspector: row detail or queue intelligence */}
        {selectedItem
          ? <HeroInspector item={selectedItem} onAction={handleAction} />
          : <IntelPanel items={items} onGlobalAction={action => handleAction(action, '')} />
        }
      </div>

      {/* ── Bottom module area ──────────────────────────────────────── */}
      <div className={cls('occ-modules-area', bottomExpanded && 'is-expanded')}>
        <div className="occ-modules-bar">
          <div className="occ-module-tabs">
            {BOTTOM_TABS.map(t => (
              <button
                key={t.key}
                type="button"
                className={cls('occ-module-tab', activeBottomTab === t.key && 'is-active')}
                onClick={() => {
                  if (activeBottomTab === t.key) {
                    setBottomExpanded(v => !v)
                  } else {
                    setActiveBottomTab(t.key)
                    setBottomExpanded(true)
                  }
                }}
              >
                {t.label}
                {t.key === 'failures' && counts.failed > 0 && (
                  <span className="occ-module-tab__badge is-red">{counts.failed}</span>
                )}
                {t.key === 'senders' && buildSenderStats(items).filter(s => s.violations21610 > 0).length > 0 && (
                  <span className="occ-module-tab__badge is-red">!</span>
                )}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="occ-module-collapse"
            onClick={() => setBottomExpanded(v => !v)}
          >
            <Icon name={bottomExpanded ? 'chevron-down' : 'chevron-up'} size={11} />
          </button>
        </div>
        {bottomExpanded && (
          <div className="occ-module-content">
            {activeBottomTab === 'templates' && <TemplatesModule items={items} />}
            {activeBottomTab === 'senders' && <SendersModule items={items} />}
            {activeBottomTab === 'market' && <MarketModule items={items} />}
            {activeBottomTab === 'failures' && (
              <FailureModule items={items} onFilterStatus={s => setStatusFilter(s)} />
            )}
            {activeBottomTab === 'events' && (
              <EventTimelineModule items={items} onSelectItem={id => setSelectedId(p => p === id ? null : id)} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
