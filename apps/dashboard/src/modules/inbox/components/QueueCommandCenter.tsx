import { useEffect, useState, useRef } from 'react'
import type { QueueProcessorHealth } from '../../../lib/data/inboxData'
import { emitNotification } from '../../../shared/NotificationToast'
import { pushRoutePath } from '../../../app/router'
import { Icon } from '../../../shared/icons'
import { resolveSendingStatus, type SendingStatus } from '../../operations/ops-status'
import { humanizeBlockerCode } from '../../operations/ops-status'
import { humanizeEntityName, humanizeQueueStatus } from '../../operations/ops-humanize'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

export type QueueCommandMode = 'paused' | 'assisted' | 'automatic'

export interface QueueCommandCaps {
  sends_per_run: number
  auto_replies_per_run: number
  followups_per_run: number
  first_touches_per_run: number
  max_per_number_per_day: number
  max_per_market_per_hour: number
}

export interface CampaignControlDiagnostics {
  queue_processor_mode?: string
  auto_reply_mode?: string
  campaign_mode?: string
  candidate_source?: string
  daily_cap?: number | string | null
  hard_cap?: number | string | null
  max_batch_size?: number | string | null
  market_cap?: number | string | null
  per_number_cap?: number | string | null
  scan_limit?: number | string | null
  stats?: {
    queue_depth?: number
    queued_today?: number
    sent_today?: number
    delivered_today?: number
    failed_today?: number
    opt_outs_today?: number
    positive_replies_today?: number
  }
  last_run?: {
    status?: string
    at?: string | null
    diagnostics?: unknown
  }
  active_campaign?: {
    id: string
    name?: string
    campaign_name?: string
    status?: string
    ready_targets?: number
    scheduled_targets?: number
    next_send_at?: string | null
    auto_queue_enabled?: boolean
    auto_send_enabled?: boolean
    auto_reply_mode?: string
    daily_cap?: number | string | null
    total_cap?: number | string | null
    batch_max?: number | string | null
    market_cap?: number | string | null
    per_sender_cap?: number | string | null
  } | null
  campaigns?: Array<{
    id: string
    name?: string
    campaign_name?: string
    status?: string
    ready_targets?: number
    scheduled_targets?: number
    next_send_at?: string | null
  }>
  campaign_queue_depth?: number | string | null
  campaign_queue_depth_detail?: {
    active_queue_rows?: number
    total_targets?: number
    ready_targets?: number
    planned_targets?: number
    queued_targets?: number
    blocked_targets?: number
    by_target_status?: Record<string, number>
  }
  next_send_window?: {
    id?: string
    market?: string | null
    state?: string | null
    timezone?: string | null
    window_start_utc?: string | null
    window_end_utc?: string | null
    status?: string
  } | null
  blocked_reason_counts?: Record<string, number>
  exact_blockers?: string[]
  [key: string]: unknown
}

interface QueueCommandCenterProps {
  health: QueueProcessorHealth | null
  control?: CampaignControlDiagnostics | null
  loading: boolean
  mode: QueueCommandMode
  caps: QueueCommandCaps
  actionLoading: string | null
  onModeChange: (mode: QueueCommandMode) => void
  onCapsChange: (patch: Partial<QueueCommandCaps>) => void
  onRefresh: () => void
  onRunSafeBatch: () => void
  onQueueMore: () => void
  onRunQueueNow: () => void
  onEmergencyPause: () => void
  onReprocessPaused: (ids?: string[]) => void
  onRetryFailed: () => void
  onReconcileDelivery: () => void
  onCancelStaleFollowUps: () => void
  onClose?: () => void
  onBackfillMessageEvents?: () => void
  onWriteSuppressionFromFailures?: () => void
}

/**
 * Panel tone is derived from the shared resolver, not from `health.status`.
 * `health.status` has no concept of execution mode and defaults to 'healthy'
 * when absent, which is what let the top bar show a green dot over a paused
 * queue.
 */
const toneFor = (status: SendingStatus): 'good' | 'warning' | 'critical' | 'neutral' => {
  switch (status.tone) {
    case 'positive': return 'good'
    case 'caution': return 'warning'
    case 'critical': return 'critical'
    default: return 'neutral'
  }
}

const displayValue = (value: unknown, fallback = '—') => {
  const text = String(value ?? '').trim()
  return text.length > 0 ? text : fallback
}

const displayNumber = (value: unknown, fallback = '0') => {
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString() : fallback
}

/**
 * Last-run diagnostics used to render `JSON.stringify(value).slice(0, 96)`
 * straight into the panel — a truncated object literal in the operator UI.
 * Now we surface only the fields that mean something, and say so plainly
 * when there is nothing to report.
 */
const compactDiagnostics = (value: unknown): string => {
  if (!value) return 'No diagnostics reported'
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return 'No diagnostics reported'
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return compactDiagnostics(JSON.parse(trimmed))
      } catch {
        return 'Diagnostics could not be read'
      }
    }
    return trimmed.slice(0, 140)
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const action = record.action ? humanizeBlockerCode(String(record.action)).label : null
    const reason = record.reason ? String(record.reason) : null
    const at = record.stopped_at ?? record.at
    const parts = [action, reason, at ? `at ${new Date(String(at)).toLocaleString()}` : null]
      .filter(Boolean)
    return parts.length ? parts.join(' · ').slice(0, 200) : 'No diagnostics reported'
  }
  return String(value).slice(0, 140)
}

const cleanCampaignName = (name: unknown): string => {
  const str = String(name ?? '').trim()
  if (!str) return 'None'
  // Remove ISO timestamps (e.g. 2026-06-02T05:04:44.896Z, 2026-06-02 05:04:44, etc.)
  const cleaned = str.replace(/\b\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/gi, '').trim()
  // Clean up trailing and leading punctuation (e.g. trailing dashes, commas, spaces)
  return cleaned.replace(/\s+/g, ' ').replace(/\s*[-\s,]+$/, '').replace(/^[-\s,]+/, '').trim() || str
}

// ── Why is it in this state? ──────────────────────────────────────────────
/**
 * Reasons come from the shared resolver, which deduplicates them by key.
 *
 * The previous panel listed `health.failedTodayCount` twice — once as "Unknown
 * failures" and again as "Failed today" — so a single failure inflated the
 * reason count to two, and three of the seven rows were hardcoded to 0 and
 * could never fire.
 */
function StatusReasonPanel({ status }: { status: SendingStatus }) {
  const active = status.reasons.filter((reason) => reason.severity !== 'watch')
  if (!active.length) return null

  return (
    <div className="qcc-why-critical-panel">
      <div className="qcc-why-critical-panel__head">
        <span className="qcc-why-critical-panel__dot" />
        Why {status.label.toLowerCase()}? — {active.length} reason{active.length !== 1 ? 's' : ''}
      </div>
      <div className="qcc-why-critical-panel__body">
        {active.map((reason) => (
          <div
            key={reason.key}
            className={cls(
              'qcc-why-critical-row',
              `is-active-${reason.tone === 'critical' ? 'red' : 'amber'}`,
            )}
          >
            <span className={cls('qcc-why-critical-row__dot', `is-${reason.tone === 'critical' ? 'red' : 'amber'}`)} />
            <span className="qcc-why-critical-row__label" title={reason.detail}>{reason.label}</span>
            <span className={cls('qcc-why-critical-row__count', `is-${reason.tone === 'critical' ? 'red' : 'amber'}`)}>
              {reason.count != null ? reason.count.toLocaleString() : '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────
export function QueueCommandCenter({
  health,
  control,
  loading,
  mode,
  caps,
  actionLoading,
  onModeChange,
  onCapsChange,
  onRefresh,
  onRunSafeBatch,
  onQueueMore,
  onRunQueueNow,
  onEmergencyPause,
  onReprocessPaused,
  onRetryFailed,
  onReconcileDelivery,
  onCancelStaleFollowUps,
  onClose,
  onBackfillMessageEvents,
  onWriteSuppressionFromFailures,
}: QueueCommandCenterProps) {
  // Default stubs for new actions when not wired by parent
  const handleBackfill = onBackfillMessageEvents ?? (() =>
    emitNotification({ title: 'Backfill Message Events', detail: 'TODO: wire to backend API /api/queue/backfill-message-events', severity: 'warning', sound: 'notification' })
  )
  const handleWriteSuppression = onWriteSuppressionFromFailures ?? (() =>
    emitNotification({ title: 'Write Suppression From Failures', detail: 'TODO: wire to backend API /api/queue/write-suppression-from-failures', severity: 'warning', sound: 'notification' })
  )
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>('')
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  // THE single status derivation. Every queue surface reads this same
  // resolver, so the top-bar badge, this popover, the mobile pip and the dock
  // badge can no longer disagree.
  const sendingStatus = resolveSendingStatus({ health, control, loading })
  const tone = toneFor(sendingStatus)
  const busy = loading || actionLoading !== null
  const stats = control?.stats ?? {}
  const campaignMode = displayValue(control?.campaign_mode, mode === 'automatic' ? 'live_limited' : mode === 'assisted' ? 'dry_run' : 'paused')
  const queueProcessorMode = displayValue(control?.queue_processor_mode, mode)
  const autoReplyMode = displayValue(control?.auto_reply_mode, 'disabled')
  const candidateSource = displayValue(control?.candidate_source, 'v_sms_ready_contacts_expanded')
  const lastRunStatus = displayValue(control?.last_run?.status, displayValue(control?.queue_last_run_status, 'idle'))
  const lastRunDiagnostics = compactDiagnostics(control?.last_run?.diagnostics ?? control?.queue_last_run_diagnostics)
  const campaigns = control?.campaigns ?? []
  const activeCampaign = control?.active_campaign ?? null
  const selectedCampaign = campaigns.find((campaign) => campaign.id === selectedCampaignId) ?? activeCampaign
  const depth = control?.campaign_queue_depth_detail ?? {}
  const nextWindow = control?.next_send_window ?? null
  const exactBlockers = control?.exact_blockers ?? []
  const blockedReasonRows = Object.entries(control?.blocked_reason_counts ?? {})
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 6)
  const campaignSelected = Boolean(selectedCampaign?.id)

  useEffect(() => {
    if (!selectedCampaignId && activeCampaign?.id) setSelectedCampaignId(activeCampaign.id)
  }, [activeCampaign?.id, selectedCampaignId])

  // Reset body scrollTop to 0 when opened
  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = 0
    }
  }, [])

  const handleWindowControl = (action: 'open' | 'close') => {
    if (!campaignSelected) {
      emitNotification({ title: 'Select a campaign first', detail: 'Send window controls are campaign-scoped.', severity: 'warning', sound: 'notification' })
      return
    }
    emitNotification({
      title: action === 'open' ? 'Open Window Disabled' : 'Close Window Disabled',
      detail: 'Phase 1 exposes planned windows only. Use Campaign View to dry-run the queue plan.',
      severity: 'warning',
      sound: 'notification',
    })
  }

  // Derive "needs attention" items from health counts
  const attentionItems = [
    (health?.routingBlockedCount ?? 0) > 0
      ? { label: 'Routing Blocked', desc: 'Paused sender resolution', count: health!.routingBlockedCount, action: 'Retry' as const, onAction: () => onReprocessPaused() }
      : null,
    (health?.blankBodyBlockedCount ?? 0) > 0
      ? { label: 'Blank Body Blocked', desc: 'Empty message template', count: health!.blankBodyBlockedCount, action: 'Review' as const, onAction: null }
      : null,
    (health?.pausedInvalidCount ?? 0) > 0
      ? { label: 'Paused Invalid', desc: 'Stale or invalid rows', count: health!.pausedInvalidCount, action: 'Reprocess' as const, onAction: () => onReprocessPaused() }
      : null,
    (health?.failedTodayCount ?? 0) > 0
      ? { label: 'Failed Today', desc: 'Delivery failures', count: health!.failedTodayCount, action: 'Retry' as const, onAction: onRetryFailed }
      : null,
  ].filter(Boolean) as Array<{
    label: string
    desc: string
    count: number
    action: string
    onAction: (() => void) | null
  }>

  const lastCheck = health?.checkedAt
    ? new Date(health.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '—'

  /*
   * REPLACED: the local `getInferredStatus()`.
   *
   * It was a seventh source of truth. It read `mode`, which InboxPage seeded
   * from `localStorage['nx.queue.mode']` on mount, so first paint reflected
   * whatever this browser last selected rather than server state. It also
   * flipped to DEGRADED whenever `failedTodayCount > 0` — one failure out of
   * thousands — and had no concept of `queue_execution_mode` at all.
   */
  const inferredStatus = sendingStatus.label.toUpperCase()

  // Format the send window text
  const getNextWindowString = () => {
    if (!nextWindow?.window_start_utc) return 'None'
    const start = new Date(nextWindow.window_start_utc)
    const now = new Date()
    const diffMs = start.getTime() - now.getTime()
    if (diffMs > 0 && diffMs < 60 * 60 * 1000) {
      return `${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (in ${Math.round(diffMs / 60000)}m)`
    }
    return start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  const nextWindowStr = getNextWindowString()

  const hasWarnings = attentionItems.length > 0 || exactBlockers.length > 0 || blockedReasonRows.length > 0

  return (
    <div
      ref={rootRef}
      className={cls('qcc-root nx-queue-status', `is-${tone}`, `inferred-${inferredStatus.toLowerCase()}`)}
      role="dialog"
      aria-label="Queue & Sending Status"
    >
      {/* Sheen sheen gradient layer will be applied via CSS ::before */}
      
      {/* ── Header ────────────────────────────────────────────────── */}
      <div className="nx-queue-status__header">
        <div className="nx-queue-status__header-left">
          <p className="nx-queue-status__title">QUEUE & SENDING STATUS</p>
          {/* One operator sentence: what this is, is it good, what happens next. */}
          <p className="nx-queue-status__subtitle">{sendingStatus.headline}</p>
        </div>
        <div className="nx-queue-status__header-right">
          <span className={cls('nx-queue-status__state', `state-${inferredStatus.toLowerCase()}`)}>
            {inferredStatus}
          </span>
          <button
            type="button"
            className="qcc-refresh-btn"
            onClick={onRefresh}
            disabled={busy}
            title="Refresh status"
          >
            <Icon name="refresh-cw" size={14} />
          </button>
          {onClose && (
            <button
              type="button"
              className="qcc-refresh-btn"
              onClick={onClose}
              title="Close panel"
            >
              <Icon name="close" size={14} />
            </button>
          )}
        </div>
      </div>

      {/* ── Scrollable Body Wrapper ───────────────────────────────── */}
      <div className="nx-queue-status__body" ref={bodyRef}>
        
        {/* ── Summary Grid ────────────────────────────────────────── */}
        <div className="nx-queue-status__summary-grid">
          <div className="nx-queue-status__summary-card">
            <div className="nx-queue-status__card-title">SYSTEM STATUS</div>
            <div className="nx-queue-status__card-value">{inferredStatus}</div>
            <div className="nx-queue-status__card-meta">Last check: {lastCheck}</div>
          </div>

          <div className="nx-queue-status__summary-card">
            <div className="nx-queue-status__card-title">QUEUE STATUS</div>
            <div className="nx-queue-status__card-value">{displayNumber(health?.queuedCount)} <small>queued</small></div>
            <div className="nx-queue-status__card-meta">
              {displayNumber(depth.ready_targets ?? selectedCampaign?.ready_targets)} ready · {displayNumber(depth.active_queue_rows ?? control?.campaign_queue_depth)} active rows
            </div>
          </div>

          <div className="nx-queue-status__summary-card">
            <div className="nx-queue-status__card-title">SENDING TODAY</div>
            <div className="nx-queue-status__card-value">{displayNumber(stats.sent_today ?? health?.sentTodayCount)} <small>sent</small></div>
            <div className="nx-queue-status__card-meta">
              {displayNumber(stats.delivered_today ?? health?.deliveredTodayCount)} del · {displayNumber(stats.failed_today ?? health?.failedTodayCount)} fail
            </div>
          </div>

          <div className="nx-queue-status__summary-card">
            <div className="nx-queue-status__card-title">SYSTEM HEALTH</div>
            <div className="nx-queue-status__card-value">
              {/* "Unknown" is a real answer. Reporting an unreadable queue as
                  "Degraded" (or worse, "Healthy") is what this rebuild fixes. */}
              {!health ? 'Unknown'
                : health.processorHealthy && health.webhookHealthy ? 'Healthy'
                  : 'Degraded'}
            </div>
            <div className="nx-queue-status__health">
              <span className={cls('nx-queue-status__health-indicator', health?.processorHealthy ? 'is-good' : 'is-warning')}>Feeder</span>
              <span className="nx-queue-status__health-sep">·</span>
              <span className={cls('nx-queue-status__health-indicator', health?.processorHealthy ? 'is-good' : 'is-warning')}>Runner</span>
              <span className="nx-queue-status__health-sep">·</span>
              <span className={cls('nx-queue-status__health-indicator', health?.webhookHealthy ? 'is-good' : 'is-warning')}>TextGrid</span>
              <span className="nx-queue-status__health-sep">·</span>
              <span className="nx-queue-status__health-indicator is-good">DB</span>
            </div>
          </div>
        </div>

        {/* ── Active Campaign card ────────────────────────────────── */}
        <div className="nx-queue-status__campaign">
          <div className="nx-queue-status__campaign-header">
            <span className="nx-queue-status__campaign-title">ACTIVE CAMPAIGN</span>
            {campaigns.length > 0 && (
              <select
                value={selectedCampaignId}
                onChange={(e) => setSelectedCampaignId(e.target.value)}
                disabled={busy}
                className="nx-queue-status__campaign-select"
              >
                <option value="">Select campaign</option>
                {campaigns.map((camp) => (
                  <option key={camp.id} value={camp.id}>
                    {camp.name || camp.id} ({camp.status || 'draft'})
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="nx-queue-status__campaign-body">
            <div className="nx-queue-status__campaign-title-container">
              <strong className="nx-queue-status__campaign-name">
                {cleanCampaignName(selectedCampaign?.name || selectedCampaign?.campaign_name)}
              </strong>
            </div>
            <div className="nx-queue-status__campaign-row">
              Targets: <strong>{displayNumber(depth.total_targets)}</strong> total · <strong>{displayNumber(depth.ready_targets ?? selectedCampaign?.ready_targets)}</strong> ready · <strong>{displayNumber(depth.planned_targets ?? selectedCampaign?.scheduled_targets)}</strong> planned
            </div>
            <div className="nx-queue-status__campaign-row">
              Cap: <strong>{displayNumber(control?.daily_cap ?? control?.queue_daily_send_cap)}/day</strong> · batch <strong>{displayNumber(control?.max_batch_size ?? control?.queue_max_batch_size)}</strong>
            </div>
            <div className="nx-queue-status__campaign-row">
              Status: <span className={cls('nx-queue-status__campaign-badge', `status-${selectedCampaign?.status || 'draft'}`)}>{displayValue(selectedCampaign?.status, 'Draft')}</span>
            </div>
          </div>
        </div>

        {/* ── Send Window / Queue Mini-card ───────────────────────── */}
        <div className="nx-queue-status__summary-card next-window-card">
          <div className="nx-queue-status__card-title">NEXT SEND WINDOW</div>
          <div className="nx-queue-status__card-body" style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div>Next: <strong>{nextWindowStr}</strong></div>
            <div>Market: <strong>{displayValue(nextWindow?.market, 'None')}</strong></div>
            <div>Timezone: <strong>{displayValue(nextWindow?.timezone, 'None')}</strong></div>
            <div>Window status: <strong>{displayValue(nextWindow?.status, 'None')}</strong></div>
            
            {campaignSelected && (
              <div className="nx-queue-status__window-actions" style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <button
                  type="button"
                  className="qcc-btn is-secondary is-xs"
                  onClick={() => handleWindowControl('open')}
                  disabled={busy}
                >
                  Open Window
                </button>
                <button
                  type="button"
                  className="qcc-btn is-secondary is-xs"
                  onClick={() => handleWindowControl('close')}
                  disabled={busy}
                >
                  Close Window
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ── Needs Attention ─────────────────────────────────────── */}
        {hasWarnings && (
          <div className="nx-queue-status__attention">
            <p className="qcc-section-label">NEEDS ATTENTION</p>
            <div className="qcc-attention-list" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {/* 1. Exact blockers — humanised, never raw snake_case (§0.2). */}
              {exactBlockers.map((blocker) => {
                const { label, detail: explanation } = humanizeBlockerCode(blocker)
                const severity: 'critical' | 'warning' =
                  blocker.includes('emergency') || blocker.includes('stop') ? 'critical' : 'warning'
                return (
                  <div key={blocker} className={cls('nx-queue-status__attention-row', `is-${severity}`)}>
                    <div className="nx-queue-status__attention-icon">
                      <Icon name={severity === 'critical' ? 'alert-circle' : 'alert'} />
                    </div>
                    <div className="nx-queue-status__attention-info">
                      <strong>{label}</strong>
                      <span>{explanation}</span>
                    </div>
                    <span className="nx-queue-status__attention-tag">Blocked</span>
                  </div>
                )
              })}

              {/* 2. Blocked reason rows — humanised. */}
              {blockedReasonRows.map(([reason, count]) => (
                <div key={reason} className="nx-queue-status__attention-row is-warning">
                  <div className="nx-queue-status__attention-icon">
                    <Icon name="alert" />
                  </div>
                  <div className="nx-queue-status__attention-info">
                    <strong>{humanizeBlockerCode(reason).label}</strong>
                    <span>{humanizeBlockerCode(reason).detail}</span>
                  </div>
                  <div className="nx-queue-status__attention-right">
                    <b>{count}</b>
                    <span className="nx-queue-status__attention-tag">Review</span>
                  </div>
                </div>
              ))}

              {/* 3. Attention items from health */}
              {attentionItems.map((item) => (
                item.onAction ? (
                  <button
                    key={item.label}
                    type="button"
                    className="nx-queue-status__attention-row is-warning is-actionable"
                    onClick={item.onAction}
                    disabled={busy}
                  >
                    <div className="nx-queue-status__attention-icon">
                      <Icon name="alert" />
                    </div>
                    <div className="nx-queue-status__attention-info">
                      <strong>{item.label}</strong>
                      <span>{item.desc}</span>
                    </div>
                    <div className="nx-queue-status__attention-right">
                      <b>{item.count}</b>
                      <span className="nx-queue-status__attention-action-hint">{item.action} →</span>
                    </div>
                  </button>
                ) : (
                  <div key={item.label} className="nx-queue-status__attention-row is-warning">
                    <div className="nx-queue-status__attention-icon">
                      <Icon name="alert" />
                    </div>
                    <div className="nx-queue-status__attention-info">
                      <strong>{item.label}</strong>
                      <span>{item.desc}</span>
                    </div>
                    <div className="nx-queue-status__attention-right">
                      <b>{item.count}</b>
                      <span className="nx-queue-status__attention-tag">Review</span>
                    </div>
                  </div>
                )
              ))}
            </div>

            {/* Individual routing blocked detail rows */}
            {(health?.routingBlockedRows?.length ?? 0) > 0 && (
              <div className="qcc-routing-rows">
                {health!.routingBlockedRows.map((row) => (
                  <div key={row.id} className="qcc-routing-detail">
                    <div className="qcc-routing-detail__info">
                      {/*
                        `inboxData.ts:806` sets sellerName from `master_owner_id`
                        — a UUID where a name belongs. Rendering it verbatim put
                        a UUID in the operator's face; the address is the useful
                        identifier here. Reported to Lane C, who owns inboxData.
                      */}
                      <strong>{humanizeEntityName(row.sellerName, row.propertyAddress || 'Unidentified seller')}</strong>
                      <span>{row.market} · {humanizeQueueStatus(row.queueStatus)}</span>
                    </div>
                    <button
                      type="button"
                      className="qcc-btn is-ghost is-xs"
                      onClick={() => onReprocessPaused([row.id])}
                      disabled={busy}
                    >
                      {actionLoading === `retry_routing:${row.id}` ? '...' : 'Retry'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Actions ─────────────────────────────────────────────── */}
        <div className="nx-queue-status__actions" style={{ marginBottom: 12 }}>
          <button
            type="button"
            className="qcc-btn is-primary"
            onClick={() => {
              pushRoutePath('/queue')
              if (onClose) onClose()
            }}
          >
            Open Queue
          </button>
          <button
            type="button"
            className="qcc-btn is-primary"
            onClick={() => {
              pushRoutePath('/campaign-command')
              if (onClose) onClose()
            }}
          >
            Open Campaign
          </button>
          
          {/* Contextual button */}
          {mode === 'paused' ? (
            <button
              type="button"
              className="qcc-btn is-primary resume-btn"
              onClick={() => onModeChange('automatic')}
              disabled={busy}
            >
              Resume Sending
            </button>
          ) : (
            <button
              type="button"
              className="qcc-btn is-secondary pause-btn"
              onClick={onEmergencyPause}
              disabled={busy}
            >
              {actionLoading === 'emergency_pause' ? 'Pausing...' : 'Pause Sending'}
            </button>
          )}
        </div>

        {/* ── Advanced Diagnostics ────────────────────────────────── */}
        <div className="nx-queue-status__advanced">
          <button
            type="button"
            className={cls('qcc-btn is-ghost nx-queue-status__advanced-toggle', showAdvanced && 'is-active')}
            onClick={() => setShowAdvanced((v) => !v)}
            style={{ width: '100%', justifyContent: 'space-between', display: 'flex', alignItems: 'center' }}
          >
            <span>ADVANCED DIAGNOSTICS</span>
            <span style={{ fontSize: 11 }}>{showAdvanced ? '▲' : '▼'}</span>
          </button>

          {showAdvanced && (
            <div className="nx-queue-status__advanced-content" style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <StatusReasonPanel status={sendingStatus} />

              {/* Advanced Actions */}
              <div className="qcc-advanced__actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                <button type="button" className="qcc-btn is-secondary" onClick={onQueueMore} disabled={busy}>
                  {actionLoading === 'queue_more' ? 'Previewing...' : 'Dry-Run Preview'}
                </button>
                <button type="button" className="qcc-btn is-secondary" onClick={onRunSafeBatch} disabled={busy}>
                  {actionLoading === 'safe_batch' ? 'Queueing...' : 'Queue Limited'}
                </button>
                {mode !== 'automatic' && (
                  <button type="button" className="qcc-btn is-secondary" onClick={() => onModeChange('automatic')} disabled={busy}>
                    Set Limited
                  </button>
                )}
                <button type="button" className="qcc-btn is-secondary" onClick={onRunQueueNow} disabled={busy}>
                  {actionLoading === 'run_now' ? 'Running...' : 'Run Limited Batch'}
                </button>
                <button type="button" className="qcc-btn is-secondary" onClick={() => onReprocessPaused()} disabled={busy}>
                  {actionLoading === 'reprocess_paused' ? 'Reprocessing...' : 'Reprocess Paused'}
                </button>
                <button type="button" className="qcc-btn is-secondary" onClick={onRetryFailed} disabled={busy}>
                  {actionLoading === 'retry_failed' ? 'Retrying...' : 'Retry Failed Safe'}
                </button>
                <button type="button" className="qcc-btn is-secondary" onClick={onReconcileDelivery} disabled={busy}>
                  {actionLoading === 'reconcile_delivery' ? 'Reconciling...' : 'Reconcile Delivery'}
                </button>
                {onBackfillMessageEvents && (
                  <button type="button" className="qcc-btn is-secondary" onClick={handleBackfill} disabled={busy}>
                    Backfill Message Events
                  </button>
                )}
                {onWriteSuppressionFromFailures && (
                  <button type="button" className="qcc-btn is-secondary" onClick={handleWriteSuppression} disabled={busy}>
                    Write Suppression From Failures
                  </button>
                )}
                <button type="button" className="qcc-btn is-secondary" onClick={onCancelStaleFollowUps} disabled={busy}>
                  {actionLoading === 'cancel_stale_followups' ? 'Clearing...' : 'Clear Stale Scheduled'}
                </button>
              </div>

              {/* Caps input grid */}
              <div className="qcc-section-label" style={{ marginTop: 4 }}>Caps Configuration</div>
              <div className="qcc-caps-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                {([
                  ['sends_per_run', 'Sends / Run'],
                  ['auto_replies_per_run', 'Auto Replies'],
                  ['followups_per_run', 'Follow-Ups'],
                  ['first_touches_per_run', 'First Touches'],
                  ['max_per_number_per_day', 'Per Number / Day'],
                  ['max_per_market_per_hour', 'Per Market / Hr'],
                ] as Array<[keyof QueueCommandCaps, string]>).map(([key, label]) => (
                  <label key={key} className="qcc-cap" style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', opacity: 0.5 }}>{label}</span>
                    <input
                      type="number"
                      min={0}
                      value={caps[key]}
                      onChange={(e) => onCapsChange({ [key]: Math.max(0, Number(e.target.value) || 0) })}
                      style={{ padding: '4px 8px', fontSize: 12, borderRadius: 6, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.2)', color: '#fff' }}
                    />
                  </label>
                ))}
              </div>

              {/* Raw metrics and fields */}
              <div className="qcc-section-label" style={{ marginTop: 4 }}>Telemetry & Telephony</div>
              <div className="qcc-status-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, padding: 0, border: 'none' }}>
                <div className="qcc-status-col">
                  <div className="qcc-status-item"><span>Processor</span><strong>{queueProcessorMode}</strong></div>
                  <div className="qcc-status-item"><span>Auto Reply</span><strong>{autoReplyMode}</strong></div>
                  <div className="qcc-status-item"><span>Candidate Source</span><strong title={candidateSource}>{candidateSource}</strong></div>
                  <div className="qcc-status-item"><span>Campaign Mode</span><strong>{campaignMode}</strong></div>
                </div>
                <div className="qcc-status-col">
                  <div className="qcc-status-item"><span>Daily Cap</span><strong>{displayNumber(control?.daily_cap ?? control?.queue_daily_send_cap)}</strong></div>
                  <div className="qcc-status-item"><span>Hard Cap</span><strong>{displayNumber(control?.hard_cap ?? control?.queue_hard_cap)}</strong></div>
                  <div className="qcc-status-item"><span>Batch Max</span><strong>{displayNumber(control?.max_batch_size ?? control?.queue_max_batch_size)}</strong></div>
                  <div className="qcc-status-item"><span>Market Cap</span><strong>{displayNumber(control?.market_cap ?? control?.queue_market_cap ?? control?.queue_market_throttle)}</strong></div>
                  <div className="qcc-status-item"><span>Per Number</span><strong>{displayNumber(control?.per_number_cap ?? control?.queue_per_number_cap ?? control?.queue_sender_throttle)}</strong></div>
                  <div className="qcc-status-item"><span>Scan Limit</span><strong>{displayNumber(control?.scan_limit ?? control?.queue_scan_limit)}</strong></div>
                </div>
              </div>

              <div className="qcc-section-label" style={{ marginTop: 4 }}>Last Run Info</div>
              <div className="qcc-status-grid" style={{ gridTemplateColumns: '1fr', gap: 6, padding: 0, border: 'none' }}>
                <div className="qcc-status-item"><span>Status</span><strong>{lastRunStatus}</strong></div>
                <div className="qcc-status-item"><span>Diagnostics</span><strong title={lastRunDiagnostics}>{lastRunDiagnostics}</strong></div>
              </div>

              {/*
                The raw `JSON.stringify(control, null, 2)` dump was a developer
                artifact in the operator interface (§0.2). It is now behind an
                explicit disclosure and gated to dev builds only (R10.7).
              */}
              {control && import.meta.env.DEV && (
                <details className="qcc-diagnostics-disclosure">
                  <summary style={{ fontSize: 11, cursor: 'pointer', opacity: 0.6 }}>
                    Raw control payload (dev only)
                  </summary>
                  <pre className="qcc-diagnostics-json" style={{
                    fontSize: 11,
                    fontFamily: 'IBM Plex Mono, ui-monospace, monospace',
                    padding: 8,
                    borderRadius: 6,
                    maxHeight: 140,
                    overflow: 'auto',
                    marginTop: 6,
                  }}>
                    {JSON.stringify(control, null, 2)}
                  </pre>
                </details>
              )}

              <p className="qcc-cmd-hint" style={{ textAlign: 'center', marginTop: 4 }}>Press <kbd>⌘K</kbd> for queue commands</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
