import { useState } from 'react'
import type { QueueProcessorHealth } from '../../../lib/data/inboxData'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

export type QueueCommandMode = 'off' | 'safe' | 'live'

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
  if (mode === 'safe') return 'Safe Autopilot'
  if (mode === 'live') return 'Live Autopilot'
  return 'Off'
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
}: QueueCommandCenterProps) {
  const [showAdvanced, setShowAdvanced] = useState(false)

  const tone = toneFor(health)
  const status = health?.status ?? 'unknown'
  const liveBlocked = health?.liveAutopilotAllowed === false
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
          <button type="button" className={cls('qcc-chip', mode === 'off' && 'is-active')} onClick={() => onModeChange('off')} disabled={busy}>Off</button>
          <button type="button" className={cls('qcc-chip', mode === 'safe' && 'is-active')} onClick={() => onModeChange('safe')} disabled={busy}>Safe</button>
          <button
            type="button"
            className={cls('qcc-chip', mode === 'live' && 'is-active')}
            onClick={() => onModeChange('live')}
            disabled={busy || liveBlocked}
            title={liveBlocked ? 'Live Autopilot blocked — queue health is Critical' : undefined}
          >
            Live
          </button>
        </div>

        <div className="qcc-primary-actions">
          <button type="button" className="qcc-btn is-primary" onClick={onRunSafeBatch} disabled={busy}>
            {actionLoading === 'safe_batch' ? 'Running...' : 'Run Safe Batch'}
          </button>
          <button type="button" className="qcc-btn is-primary" onClick={onQueueMore} disabled={busy}>
            {actionLoading === 'queue_more' ? 'Queueing...' : 'Queue More'}
          </button>
          <button type="button" className="qcc-btn is-primary" onClick={onRunQueueNow} disabled={busy || liveBlocked} title={liveBlocked ? 'Blocked — queue health is Critical' : undefined}>
            {actionLoading === 'run_now' ? 'Running...' : 'Run Queue Now'}
          </button>
          <button type="button" className="qcc-btn is-secondary" onClick={onEmergencyPause} disabled={busy}>
            {actionLoading === 'emergency_pause' ? 'Pausing...' : 'Emergency Pause'}
          </button>
          {/* TODO: wire secondary queue commands into Command-K */}
          <button type="button" className={cls('qcc-btn is-ghost', showAdvanced && 'is-active')} onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? 'Hide' : 'Advanced'}
          </button>
        </div>
        <p className="qcc-cmd-hint">Press <kbd>⌘K</kbd> for queue commands</p>

        {/* TODO: move advanced queue diagnostics into command palette / advanced drawer */}
        {showAdvanced && (
          <div className="qcc-advanced">
            <div className="qcc-advanced__actions">
              <button type="button" className="qcc-btn is-secondary" onClick={onRunQueueNow} disabled={busy || liveBlocked} title={liveBlocked ? 'Blocked — queue health is Critical' : undefined}>
                {actionLoading === 'run_now' ? 'Running...' : 'Run Queue Now'}
              </button>
              <button type="button" className="qcc-btn is-secondary" onClick={() => onReprocessPaused()} disabled={busy}>
                {actionLoading === 'reprocess_paused' ? 'Reprocessing...' : 'Reprocess Paused'}
              </button>
              <button type="button" className="qcc-btn is-secondary" onClick={onRetryFailed} disabled={busy}>
                {actionLoading === 'retry_failed' ? 'Retrying...' : 'Retry Failed'}
              </button>
              <button type="button" className="qcc-btn is-secondary" onClick={onReconcileDelivery} disabled={busy}>
                {actionLoading === 'reconcile_delivery' ? 'Reconciling...' : 'Reconcile Delivery'}
              </button>
              <button type="button" className="qcc-btn is-secondary" onClick={onCancelStaleFollowUps} disabled={busy}>
                {actionLoading === 'cancel_stale_followups' ? 'Cancelling...' : 'Cancel Stale Follow-Ups'}
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

      {/* ── SECTION 3: Key Metrics ──────────────────────────────────── */}
      <div className="qcc-metrics">
        {([
          ['Queued', health?.queuedCount ?? 0, null],
          ['Scheduled', health?.scheduledCount ?? 0, null],
          ['Sent Today', health?.sentTodayCount ?? 0, null],
          ['Delivered Today', health?.deliveredTodayCount ?? 0, (health?.deliveredTodayCount ?? 0) > 0 ? 'good' : null],
          ['Routing Blocked', health?.routingBlockedCount ?? 0, (health?.routingBlockedCount ?? 0) > 0 ? 'warning' : null],
          ['Failed Today', health?.failedTodayCount ?? 0, (health?.failedTodayCount ?? 0) > 0 ? 'critical' : null],
        ] as Array<[string, number, string | null]>).map(([label, value, accent]) => (
          <div key={label} className={cls('qcc-metric', accent && `is-${accent}`)}>
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
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
