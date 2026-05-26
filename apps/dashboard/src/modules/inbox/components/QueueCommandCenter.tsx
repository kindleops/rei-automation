import { useState } from 'react'
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

interface QueueCommandCenterProps {
  health: QueueProcessorHealth | null
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
  if (mode === 'assisted') return 'Assisted Autopilot'
  if (mode === 'automatic') return 'Automatic'
  return 'Paused'
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

  const tone = toneFor(health)
  const status = health?.status ?? 'unknown'
  const busy = loading || actionLoading !== null

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
          <button type="button" className={cls('qcc-chip', mode === 'assisted' && 'is-active')} onClick={() => onModeChange('assisted')} disabled={busy}>Assisted</button>
          <button
            type="button"
            className={cls('qcc-chip', mode === 'automatic' && 'is-active')}
            onClick={() => onModeChange('automatic')}
            disabled={busy}
          >
            Automatic
          </button>
        </div>

        <div className="qcc-primary-actions">
          <button type="button" className="qcc-btn is-primary" onClick={onQueueMore} disabled={busy}>
            {actionLoading === 'queue_more' ? 'Finding...' : 'Find Sellers'}
          </button>
          <button type="button" className="qcc-btn is-primary" onClick={onRunSafeBatch} disabled={busy}>
            {actionLoading === 'safe_batch' ? 'Sending...' : 'Send Small Batch'}
          </button>
          {mode !== 'automatic' && (
            <button type="button" className="qcc-btn is-primary" onClick={() => onModeChange('automatic')} disabled={busy}>
              Start Automatic
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
                {actionLoading === 'run_now' ? 'Start Sending...' : 'Run Queue Once'}
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

        {attentionItems.length === 0 ? (
          <div className="qcc-all-clear">All systems clear.</div>
        ) : (
          <div className="qcc-attention-list">
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
