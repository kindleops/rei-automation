import { useEffect, useState } from 'react'
import type { QueueProcessorHealth } from '../../../lib/data/inboxData'
import { emitNotification } from '../../../shared/NotificationToast'

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
  // TODO: wire to backend API endpoint /api/queue/backfill-message-events
  onBackfillMessageEvents?: () => void
  // TODO: wire to backend API endpoint /api/queue/write-suppression-from-failures
  onWriteSuppressionFromFailures?: () => void
}

const toneFor = (health: QueueProcessorHealth | null): 'good' | 'warning' | 'critical' | 'neutral' => {
  if (!health) return 'neutral'
  if (health.status === 'healthy') return 'good'
  if (health.status === 'warning') return 'warning'
  if (health.status === 'critical') return 'critical'
  return 'neutral'
}

const healthLabel = (status: string) => {
  if (status === 'healthy') return 'Healthy'
  if (status === 'warning') return 'Warning'
  if (status === 'critical') return 'Critical'
  return 'Unknown'
}

const modeLabel = (mode: QueueCommandMode) => {
  if (mode === 'assisted') return 'Dry Run'
  if (mode === 'automatic') return 'Live Limited'
  return 'Paused'
}

const displayValue = (value: unknown, fallback = '—') => {
  const text = String(value ?? '').trim()
  return text.length > 0 ? text : fallback
}

const displayNumber = (value: unknown, fallback = '—') => {
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString() : fallback
}

const compactDiagnostics = (value: unknown) => {
  if (!value) return '—'
  if (typeof value === 'string') return value.slice(0, 96)
  try {
    return JSON.stringify(value).slice(0, 96)
  } catch {
    return 'available'
  }
}

const heroSentence = (
  health: QueueProcessorHealth | null,
  attentionCount: number,
): string => {
  if (!health) return 'Connecting to queue processor...'
  if (String(health.summary || '').toLowerCase().includes('off')) {
    const q = health.queuedCount
    return q > 0 ? `Processor off — ${q} row${q !== 1 ? 's' : ''} waiting` : 'Processor off — queue clear'
  }
  if (health.status === 'critical') return `Critical — ${attentionCount} item${attentionCount !== 1 ? 's' : ''} need immediate attention`
  if (health.status === 'warning') return `Warning — ${attentionCount} item${attentionCount !== 1 ? 's' : ''} need review`
  if (attentionCount > 0) return `Healthy — ${attentionCount} item${attentionCount !== 1 ? 's' : ''} need review`
  return health.summary || 'All systems clear'
}

// ── Why Critical Panel ────────────────────────────────────────────────────
interface WhyCriticalPanelProps {
  health: QueueProcessorHealth
}

function WhyCriticalPanel({ health }: WhyCriticalPanelProps) {
  const reasons = [
    { label: 'Unknown failures',          count: health.failedTodayCount,         tone: 'red'   as const },
    { label: 'Failed today',              count: health.failedTodayCount,         tone: 'red'   as const },
    { label: 'Missing message events',    count: health.activeBlankRowCount ?? 0, tone: 'amber' as const },
    { label: 'Missing property hydration',count: 0,                               tone: 'amber' as const }, // TODO: wire real count
    { label: 'Missing seller hydration',  count: 0,                               tone: 'amber' as const }, // TODO: wire real count
    { label: 'Webhook issues',            count: health.webhookHealthy ? 0 : 1,  tone: 'red'   as const },
    { label: 'Routing / template gaps',   count: health.routingBlockedCount,      tone: 'amber' as const },
  ]
  const active = reasons.filter(r => r.count > 0)
  return (
    <div className="qcc-why-critical-panel">
      <div className="qcc-why-critical-panel__head">
        <span className="qcc-why-critical-panel__dot" />
        Why Critical? — {active.length} reason{active.length !== 1 ? 's' : ''}
      </div>
      <div className="qcc-why-critical-panel__body">
        {reasons.map(r => (
          <div
            key={r.label}
            className={cls(
              'qcc-why-critical-row',
              r.count > 0 ? `is-active-${r.tone}` : '',
            )}
          >
            <span className={cls('qcc-why-critical-row__dot', `is-${r.count > 0 ? r.tone : 'muted'}`)} />
            <span className="qcc-why-critical-row__label">{r.label}</span>
            <span className={cls('qcc-why-critical-row__count', r.count > 0 ? `is-${r.tone}` : 'is-muted')}>
              {r.count > 0 ? r.count : '—'}
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

  const tone = toneFor(health)
  const status = health?.status ?? 'unknown'
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

  return (
    <div className={cls('qcc-root', `is-${tone}`)} role="dialog" aria-label="Queue Command Center">

      {/* ── SECTION 1: Status Hero ──────────────────────────────────── */}
      <div className="qcc-hero">
        <div className="qcc-hero__top">
          <p className="qcc-hero__eyebrow">Queue Command Center</p>
          <button
            type="button"
            className="qcc-refresh-btn"
            onClick={onRefresh}
            disabled={busy}
            title="Refresh queue health"
          >
            {loading ? '⟳' : '↻'}
          </button>
          {onClose && (
            <button
              type="button"
              className="qcc-refresh-btn"
              onClick={onClose}
              title="Close panel"
            >
              ✕
            </button>
          )}
        </div>

        <div className={cls('qcc-health-badge', `is-${tone}`)}>
          <span className="qcc-health-badge__label">{healthLabel(status)}</span>
          <p className="qcc-health-badge__sentence">{heroSentence(health, attentionItems.length)}</p>
        </div>

        <div className="qcc-hero__meta">
          <span>Mode</span>
          <strong>{modeLabel(mode)}</strong>
          <span className="qcc-hero__meta-dot" />
          <span>Last check</span>
          <strong>{lastCheck}</strong>
          <span className="qcc-hero__meta-dot" />
          <span>{health?.queuedCount ?? 0} queued</span>
        </div>
      </div>

      {/* ── SECTION 2: Mode + Primary Actions ──────────────────────── */}
      <div className="qcc-mode-band">
        <div className="qcc-segment">
          <button type="button" className={cls('qcc-chip', mode === 'paused' && 'is-active')} onClick={() => onModeChange('paused')} disabled={busy}>Paused</button>
          <button type="button" className={cls('qcc-chip', mode === 'assisted' && 'is-active')} onClick={() => onModeChange('assisted')} disabled={busy}>Dry Run</button>
          <button
            type="button"
            className={cls('qcc-chip', mode === 'automatic' && 'is-active')}
            onClick={() => onModeChange('automatic')}
            disabled={busy}
          >
            Limited
          </button>
        </div>

        <div className="qcc-primary-actions">
          <button type="button" className="qcc-btn is-primary" onClick={onQueueMore} disabled={busy}>
            {actionLoading === 'queue_more' ? 'Previewing...' : 'Dry-Run Preview'}
          </button>
          <button type="button" className="qcc-btn is-primary" onClick={onRunSafeBatch} disabled={busy}>
            {actionLoading === 'safe_batch' ? 'Queueing...' : 'Queue Limited'}
          </button>
          {mode !== 'automatic' && (
            <button type="button" className="qcc-btn is-primary" onClick={() => onModeChange('automatic')} disabled={busy}>
              Set Limited
            </button>
          )}
          {mode !== 'paused' && (
            <button type="button" className="qcc-btn is-secondary" onClick={onEmergencyPause} disabled={busy}>
              {actionLoading === 'emergency_pause' ? 'Pausing...' : 'Pause Outbound'}
            </button>
          )}
          <button type="button" className={cls('qcc-btn is-ghost', showAdvanced && 'is-active')} onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? 'Hide Options' : 'Review Queue'}
          </button>
        </div>
        <p className="qcc-cmd-hint">Press <kbd>⌘K</kbd> for queue commands</p>

        {showAdvanced && (
          <div className="qcc-advanced">
            {/* Why Critical? — shows when health is critical */}
            {health?.status === 'critical' && <WhyCriticalPanel health={health} />}

            <div className="qcc-advanced__actions">
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
              <button type="button" className="qcc-btn is-secondary" onClick={handleBackfill} disabled={busy}>
                Backfill Message Events
              </button>
              <button type="button" className="qcc-btn is-secondary" onClick={handleWriteSuppression} disabled={busy}>
                Write Suppression From Failures
              </button>
              <button type="button" className="qcc-btn is-secondary" onClick={onCancelStaleFollowUps} disabled={busy}>
                {actionLoading === 'cancel_stale_followups' ? 'Clearing...' : 'Clear Stale Scheduled'}
              </button>
            </div>
            <div className="qcc-caps-grid">
              {([
                ['sends_per_run', 'Sends / Run'],
                ['auto_replies_per_run', 'Auto Replies'],
                ['followups_per_run', 'Follow-Ups'],
                ['first_touches_per_run', 'First Touches'],
                ['max_per_number_per_day', 'Per Number / Day'],
                ['max_per_market_per_hour', 'Per Market / Hr'],
              ] as Array<[keyof QueueCommandCaps, string]>).map(([key, label]) => (
                <label key={key} className="qcc-cap">
                  <span>{label}</span>
                  <input
                    type="number"
                    min={0}
                    value={caps[key]}
                    onChange={(e) => onCapsChange({ [key]: Math.max(0, Number(e.target.value) || 0) })}
                  />
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="qcc-status-grid">
        <div className="qcc-status-col">
          <p className="qcc-section-label">Campaign</p>
          <div className="qcc-status-item"><span>Processor</span><strong>{queueProcessorMode}</strong></div>
          <div className="qcc-status-item"><span>Auto Reply</span><strong>{autoReplyMode}</strong></div>
          <div className="qcc-status-item"><span>Campaign Mode</span><strong>{campaignMode}</strong></div>
          <div className="qcc-status-item"><span>Candidate Source</span><strong title={candidateSource}>{candidateSource}</strong></div>
          <div className="qcc-status-item"><span>Active Campaign</span><strong>{displayValue(activeCampaign?.campaign_name || activeCampaign?.name, 'None')}</strong></div>
        </div>
        <div className="qcc-status-col">
          <p className="qcc-section-label">Caps</p>
          <div className="qcc-status-item"><span>Daily Cap</span><strong>{displayNumber(control?.daily_cap ?? control?.queue_daily_send_cap)}</strong></div>
          <div className="qcc-status-item"><span>Hard Cap</span><strong>{displayNumber(control?.hard_cap ?? control?.queue_hard_cap)}</strong></div>
          <div className="qcc-status-item"><span>Batch Max</span><strong>{displayNumber(control?.max_batch_size ?? control?.queue_max_batch_size)}</strong></div>
          <div className="qcc-status-item"><span>Market Cap</span><strong>{displayNumber(control?.market_cap ?? control?.queue_market_cap ?? control?.queue_market_throttle)}</strong></div>
          <div className="qcc-status-item"><span>Per Number</span><strong>{displayNumber(control?.per_number_cap ?? control?.queue_per_number_cap ?? control?.queue_sender_throttle)}</strong></div>
          <div className="qcc-status-item"><span>Scan Limit</span><strong>{displayNumber(control?.scan_limit ?? control?.queue_scan_limit)}</strong></div>
        </div>
        <div className="qcc-status-col">
          <p className="qcc-section-label">Today</p>
          <div className="qcc-status-item"><span>Queue Depth</span><strong>{displayNumber(stats.queue_depth ?? health?.queuedCount)}</strong></div>
          <div className="qcc-status-item"><span>Queued</span><strong>{displayNumber(stats.queued_today)}</strong></div>
          <div className="qcc-status-item"><span>Sent</span><strong>{displayNumber(stats.sent_today ?? health?.sentTodayCount)}</strong></div>
          <div className="qcc-status-item"><span>Delivered</span><strong>{displayNumber(stats.delivered_today ?? health?.deliveredTodayCount)}</strong></div>
          <div className="qcc-status-item"><span>Failed</span><strong>{displayNumber(stats.failed_today ?? health?.failedTodayCount)}</strong></div>
          <div className="qcc-status-item"><span>Opt-Outs</span><strong>{displayNumber(stats.opt_outs_today)}</strong></div>
          <div className="qcc-status-item"><span>Positive Replies</span><strong>{displayNumber(stats.positive_replies_today)}</strong></div>
        </div>
        <div className="qcc-status-col">
          <p className="qcc-section-label">Last Run</p>
          <div className="qcc-status-item"><span>Status</span><strong>{lastRunStatus}</strong></div>
          <div className="qcc-status-item"><span>Diagnostics</span><strong title={lastRunDiagnostics}>{lastRunDiagnostics}</strong></div>
        </div>
      </div>

      <div className="qcc-status-grid">
        <div className="qcc-status-col">
          <p className="qcc-section-label">Campaign Queue</p>
          <div className="qcc-status-item"><span>Selected</span><strong>{displayValue(selectedCampaign?.name || selectedCampaign?.campaign_name, 'None')}</strong></div>
          <div className="qcc-status-item"><span>Status</span><strong>{displayValue(selectedCampaign?.status)}</strong></div>
          <div className="qcc-status-item"><span>Ready Targets</span><strong>{displayNumber(depth.ready_targets ?? selectedCampaign?.ready_targets)}</strong></div>
          <div className="qcc-status-item"><span>Planned Targets</span><strong>{displayNumber(depth.planned_targets ?? selectedCampaign?.scheduled_targets)}</strong></div>
          <div className="qcc-status-item"><span>Active Queue Rows</span><strong>{displayNumber(depth.active_queue_rows ?? control?.campaign_queue_depth)}</strong></div>
        </div>
        <div className="qcc-status-col">
          <p className="qcc-section-label">Send Window</p>
          <div className="qcc-status-item"><span>Next</span><strong>{nextWindow?.window_start_utc ? new Date(nextWindow.window_start_utc).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'None'}</strong></div>
          <div className="qcc-status-item"><span>Market</span><strong>{displayValue(nextWindow?.market)}</strong></div>
          <div className="qcc-status-item"><span>State</span><strong>{displayValue(nextWindow?.state)}</strong></div>
          <div className="qcc-status-item"><span>Timezone</span><strong>{displayValue(nextWindow?.timezone)}</strong></div>
          <div className="qcc-status-item"><span>Window Status</span><strong>{displayValue(nextWindow?.status)}</strong></div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" className="qcc-btn is-secondary" onClick={() => handleWindowControl('open')} disabled={busy || !campaignSelected}>Open</button>
            <button type="button" className="qcc-btn is-secondary" onClick={() => handleWindowControl('close')} disabled={busy || !campaignSelected}>Close</button>
          </div>
        </div>
        <div className="qcc-status-col">
          <p className="qcc-section-label">Campaign Picker</p>
          <select value={selectedCampaignId} onChange={(event) => setSelectedCampaignId(event.target.value)} disabled={busy || campaigns.length === 0}>
            <option value="">Select campaign</option>
            {campaigns.map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name || campaign.id} ({campaign.status || 'draft'})
              </option>
            ))}
          </select>
          <div className="qcc-status-item"><span>Campaigns</span><strong>{displayNumber(campaigns.length)}</strong></div>
          <div className="qcc-status-item"><span>Total Targets</span><strong>{displayNumber(depth.total_targets)}</strong></div>
          <div className="qcc-status-item"><span>Blocked Targets</span><strong>{displayNumber(depth.blocked_targets)}</strong></div>
        </div>
      </div>

      {/* ── SECTION 3: Live Status Display ─────────────────────────── */}
      <div className="qcc-status-grid">
        <div className="qcc-status-col">
          <p className="qcc-section-label">System Status</p>
          <div className="qcc-status-item"><span>Mode</span><strong>{modeLabel(mode)}</strong></div>
          <div className="qcc-status-item"><span>Feeder Last</span><strong>{lastCheck}</strong></div>
          <div className="qcc-status-item"><span>Feeder Next</span><strong>{mode !== 'paused' ? 'Soon' : 'Paused'}</strong></div>
          <div className="qcc-status-item"><span>Rows Blocked</span><strong className={(health?.blockedCount ?? 0) > 0 ? 'qcc-text-warning' : ''}>{health?.blockedCount ?? 0}</strong></div>
        </div>
        <div className="qcc-status-col">
          <p className="qcc-section-label">Queue Status</p>
          <div className="qcc-status-item"><span>Queued Now</span><strong>{health?.queuedCount ?? 0}</strong></div>
          <div className="qcc-status-item"><span>Scheduled</span><strong>{health?.scheduledCount ?? 0}</strong></div>
          <div className="qcc-status-item"><span>Sending Now</span><strong>{health?.sendingCount ?? 0}</strong></div>
          <div className="qcc-status-item"><span>Sent Today</span><strong>{health?.sentTodayCount ?? 0}</strong></div>
          <div className="qcc-status-item"><span>Delivered</span><strong className={(health?.deliveredTodayCount ?? 0) > 0 ? 'qcc-text-good' : ''}>{health?.deliveredTodayCount ?? 0}</strong></div>
          <div className="qcc-status-item"><span>Failed Today</span><strong className={(health?.failedTodayCount ?? 0) > 0 ? 'qcc-text-critical' : ''}>{health?.failedTodayCount ?? 0}</strong></div>
        </div>
        <div className="qcc-status-col">
          <p className="qcc-section-label">Health</p>
          <div className="qcc-status-item"><span>Feeder</span><strong className={health?.processorHealthy ? 'qcc-text-good' : 'qcc-text-warning'}>{health?.processorHealthy ? 'Healthy' : 'Degraded'}</strong></div>
          <div className="qcc-status-item"><span>Runner</span><strong className={health?.processorHealthy ? 'qcc-text-good' : 'qcc-text-warning'}>{health?.processorHealthy ? 'Healthy' : 'Degraded'}</strong></div>
          <div className="qcc-status-item"><span>TextGrid</span><strong className={health?.webhookHealthy ? 'qcc-text-good' : 'qcc-text-warning'}>{health?.webhookHealthy ? 'Healthy' : 'Degraded'}</strong></div>
          <div className="qcc-status-item"><span>Database</span><strong className="qcc-text-good">Healthy</strong></div>
        </div>
      </div>

      {/* ── SECTION 4: Needs Attention ──────────────────────────────── */}
      <div className="qcc-attention">
        <p className="qcc-section-label">Needs Attention</p>

        {attentionItems.length === 0 && exactBlockers.length === 0 && blockedReasonRows.length === 0 ? (
          <div className="qcc-all-clear">No campaign blockers reported.</div>
        ) : (
          <div className="qcc-attention-list">
            {exactBlockers.map((blocker) => (
              <div key={blocker} className="qcc-attention-row">
                <div className="qcc-attention-row__info">
                  <strong>{blocker.replace(/_/g, ' ')}</strong>
                  <span>Campaign automation blocker</span>
                </div>
                <div className="qcc-attention-row__right">
                  <span className="qcc-attention-row__tag">Blocked</span>
                </div>
              </div>
            ))}
            {blockedReasonRows.map(([reason, count]) => (
              <div key={reason} className="qcc-attention-row">
                <div className="qcc-attention-row__info">
                  <strong>{reason.replace(/_/g, ' ')}</strong>
                  <span>Blocked reason count</span>
                </div>
                <div className="qcc-attention-row__right">
                  <b>{count}</b>
                  <span className="qcc-attention-row__tag">Review</span>
                </div>
              </div>
            ))}
            {attentionItems.map((item) => (
              item.onAction ? (
                <button
                  key={item.label}
                  type="button"
                  className="qcc-attention-row is-actionable"
                  onClick={item.onAction}
                  disabled={busy}
                >
                  <div className="qcc-attention-row__info">
                    <strong>{item.label}</strong>
                    <span>{item.desc}</span>
                  </div>
                  <div className="qcc-attention-row__right">
                    <b>{item.count}</b>
                    <span className="qcc-attention-row__action-hint">{item.action} →</span>
                  </div>
                </button>
              ) : (
                <div key={item.label} className="qcc-attention-row">
                  <div className="qcc-attention-row__info">
                    <strong>{item.label}</strong>
                    <span>{item.desc}</span>
                  </div>
                  <div className="qcc-attention-row__right">
                    <b>{item.count}</b>
                    <span className="qcc-attention-row__tag">Review</span>
                  </div>
                </div>
              )
            ))}
          </div>
        )}

        {/* Individual routing-blocked detail rows */}
        {(health?.routingBlockedRows?.length ?? 0) > 0 && (
          <div className="qcc-routing-rows">
            {health!.routingBlockedRows.map((row) => (
              <div key={row.id} className="qcc-routing-detail">
                <div className="qcc-routing-detail__info">
                  <strong>{row.sellerName}</strong>
                  <span>{row.market} · {row.reason}</span>
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

    </div>
  )
}
