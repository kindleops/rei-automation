import { useState, useEffect, useCallback } from 'react'
import * as backendClient from '../../lib/api/backendClient'
import type { BackendResult } from '../../lib/api/backendClient'
import { emitNotification } from '../../shared/NotificationToast'
import { Icon } from '../../shared/icons'

interface ConfirmState {
  open: boolean
  title: string
  desc: string
  onConfirm: () => void
  danger?: boolean
}

const ConfirmModal = ({ state, onClose }: { state: ConfirmState; onClose: () => void }) => {
  if (!state.open) return null
  return (
    <div className="nx-m-modal-overlay" onClick={onClose}>
      <div className="nx-m-modal" onClick={e => e.stopPropagation()}>
        <div className="nx-m-modal-handle" />
        <div className="nx-m-modal-title">{state.title}</div>
        <div className="nx-m-modal-desc">{state.desc}</div>
        <div className="nx-m-modal-actions">
          <button
            className={`nx-m-modal-btn ${state.danger ? 'is-danger-confirm' : 'is-confirm'}`}
            onClick={() => { state.onConfirm(); onClose() }}
          >
            {state.danger ? 'YES, EXECUTE' : 'Confirm'}
          </button>
          <button className="nx-m-modal-btn is-cancel" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

const MARKETS = ['Charlotte', 'Atlanta', 'Dallas', 'Houston', 'Phoenix', 'Las Vegas']

const SENDER_NUMBERS = [
  { number: '21610', label: 'TextGrid Primary', health: 'healthy' as const },
  { number: '21611', label: 'TextGrid Secondary', health: 'degraded' as const },
  { number: '21612', label: 'TextGrid Backup', health: 'healthy' as const },
]

export const MobileControlsTab = () => {
  const [autopilot, setAutopilot] = useState(true)
  const [pauseAllSends, setPauseAllSends] = useState(false)
  const [marketEnabled, setMarketEnabled] = useState<Record<string, boolean>>(
    Object.fromEntries(MARKETS.map(m => [m, true]))
  )
  const [marketCaps, setMarketCaps] = useState<Record<string, number>>(
    Object.fromEntries(MARKETS.map(m => [m, 200]))
  )
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState>({ open: false, title: '', desc: '', onConfirm: () => {} })
  const [queueStatus, setQueueStatus] = useState<backendClient.QueueStatusResponse | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const res = await backendClient.getQueueStatus()
      if (res.ok) setQueueStatus(res.data)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { loadStatus() }, [loadStatus])

  const runWithLoading = async (label: string, fn: () => Promise<void | BackendResult<unknown>>) => {
    setActionLoading(label)
    try {
      await fn()
    } finally {
      setActionLoading(null)
    }
  }

  const handleAutopilot = (val: boolean) => {
    if (!val) {
      setConfirm({
        open: true,
        title: 'Disable Autopilot',
        desc: 'This will pause all automated AI outreach decisions. You can re-enable at any time.',
        onConfirm: () => { setAutopilot(false); emitNotification({ title: 'Autopilot Paused', detail: 'Manual control only', severity: 'warning', sound: 'notification' }) },
      })
    } else {
      setAutopilot(true)
      emitNotification({ title: 'Autopilot Active', detail: 'AI automation resumed', severity: 'success', sound: 'notification' })
    }
  }

  const handlePauseAll = (val: boolean) => {
    if (val) {
      setConfirm({
        open: true,
        title: 'Pause All Sends',
        desc: 'This will halt ALL outbound SMS sends immediately. The queue will not drain until resumed.',
        danger: true,
        onConfirm: () => {
          setPauseAllSends(true)
          runWithLoading('Pause All', async () => {
            const res = await backendClient.pauseBatch({ reason: 'operator_mobile_pause' })
            if (res.ok) {
              emitNotification({ title: 'All Sends Paused', detail: 'No messages will send until resumed', severity: 'warning', sound: 'alert-triggered' })
            }
          })
        },
      })
    } else {
      setPauseAllSends(false)
      emitNotification({ title: 'Sends Resumed', detail: 'Queue is active', severity: 'success', sound: 'notification' })
    }
  }

  const handleEmergencyStop = () => {
    setConfirm({
      open: true,
      title: '⛔ EMERGENCY STOP',
      desc: 'This will IMMEDIATELY halt all outbound messages, cancel pending queue items, and freeze automation. This is a critical operation.',
      danger: true,
      onConfirm: () => {
        runWithLoading('Emergency Stop', async () => {
          const res = await backendClient.pauseBatch({ reason: 'emergency_stop_mobile' })
          setPauseAllSends(true)
          setAutopilot(false)
          if (res.ok) {
            emitNotification({ title: '⛔ Emergency Stop Executed', detail: 'All sends halted. Autopilot off.', severity: 'critical', sound: 'alert-triggered' })
          }
        })
      },
    })
  }

  const totalDailyCap = Object.values(marketCaps).reduce((a, b) => a + b, 0)

  return (
    <div className="nx-m-controls">
      {/* Autopilot */}
      <div className="nx-m-control-section">
        <div className="nx-m-control-section-header">AI Automation</div>
        <div className="nx-m-control-row">
          <div>
            <div className="nx-m-control-label">Autopilot</div>
            <div className="nx-m-control-desc">AI drives all outreach decisions</div>
          </div>
          <label className="nx-m-switch">
            <input
              type="checkbox"
              checked={autopilot}
              onChange={e => handleAutopilot(e.target.checked)}
            />
            <span className="nx-m-switch-track" />
            <span className="nx-m-switch-thumb" />
          </label>
        </div>
        <div className="nx-m-control-row">
          <div>
            <div className="nx-m-control-label">Pause All Sends</div>
            <div className="nx-m-control-desc">Halt queue drain immediately</div>
          </div>
          <label className="nx-m-switch">
            <input
              type="checkbox"
              checked={pauseAllSends}
              onChange={e => handlePauseAll(e.target.checked)}
            />
            <span className="nx-m-switch-track" style={{ background: pauseAllSends ? '#ef4444' : undefined }} />
            <span className="nx-m-switch-thumb" />
          </label>
        </div>
      </div>

      {/* Sender health */}
      <div className="nx-m-control-section">
        <div className="nx-m-control-section-header">Sender Number Health</div>
        {SENDER_NUMBERS.map(s => (
          <div key={s.number} className="nx-m-control-row">
            <div>
              <div className="nx-m-control-label">{s.label}</div>
              <div className="nx-m-control-desc">#{s.number}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className={`nx-m-health-dot is-${s.health}`} />
              <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', textTransform: 'capitalize' }}>{s.health}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Queue status */}
      {queueStatus && (
        <div className="nx-m-control-section">
          <div className="nx-m-control-section-header">Live Queue Status</div>
          {queueStatus.by_status && Object.entries(queueStatus.by_status).slice(0, 6).map(([status, count]) => (
            <div key={status} className="nx-m-control-row">
              <div className="nx-m-control-label" style={{ textTransform: 'capitalize' }}>{status}</div>
              <span style={{ fontSize: 16, fontWeight: 700, color: 'rgba(255,255,255,0.8)' }}>{count as number}</span>
            </div>
          ))}
          {queueStatus.total !== undefined && (
            <div className="nx-m-control-row" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <div className="nx-m-control-label">Total</div>
              <span style={{ fontSize: 16, fontWeight: 800, color: '#60a5fa' }}>{queueStatus.total}</span>
            </div>
          )}
        </div>
      )}

      {/* Market controls */}
      <div className="nx-m-control-section">
        <div className="nx-m-control-section-header">
          Market Send Controls · Total cap: {totalDailyCap.toLocaleString()}
        </div>
        {MARKETS.map(market => (
          <div key={market} className="nx-m-control-row">
            <div>
              <div className="nx-m-control-label">{market}</div>
              <div className="nx-m-control-desc">Daily cap</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                type="number"
                className="nx-m-cap-input"
                value={marketCaps[market]}
                min={0}
                max={2000}
                onChange={e => setMarketCaps(prev => ({ ...prev, [market]: parseInt(e.target.value) || 0 }))}
              />
              <label className="nx-m-switch" style={{ width: 40, height: 24 }}>
                <input
                  type="checkbox"
                  checked={marketEnabled[market]}
                  onChange={e => setMarketEnabled(prev => ({ ...prev, [market]: e.target.checked }))}
                />
                <span className="nx-m-switch-track" />
                <span className="nx-m-switch-thumb" style={{ width: 18, height: 18, top: 3, left: 3 }} />
              </label>
            </div>
          </div>
        ))}
      </div>

      {/* Emergency stop */}
      <button
        className="nx-m-emergency-stop"
        onClick={handleEmergencyStop}
        disabled={actionLoading === 'Emergency Stop'}
      >
        {actionLoading === 'Emergency Stop' ? (
          <div className="nx-m-spinner" style={{ width: 20, height: 20, borderTopColor: '#f87171' }} />
        ) : (
          <Icon name="alert" style={{ width: 22, height: 22 }} />
        )}
        Emergency Stop
      </button>

      {/* Quick actions */}
      <div className="nx-m-action-grid">
        <button
          className="nx-m-action-btn"
          onClick={() => runWithLoading('Reconcile', async () => {
            const res = await backendClient.reconcileDelivery({})
            if (res.ok) emitNotification({ title: 'Reconcile Done', detail: 'Delivery statuses updated', severity: 'success', sound: 'notification' })
          })}
          disabled={!!actionLoading}
        >
          <Icon name="activity" style={{ width: 16, height: 16 }} />
          Reconcile
        </button>
        <button
          className="nx-m-action-btn is-retry"
          onClick={() => runWithLoading('Retry Failed', async () => {
            const res = await backendClient.retryFailed({})
            if (res.ok) emitNotification({ title: 'Retried', detail: 'Failed items requeued', severity: 'success', sound: 'notification' })
          })}
          disabled={!!actionLoading}
        >
          <Icon name="refresh-cw" style={{ width: 16, height: 16 }} />
          Retry Failed
        </button>
      </div>

      <ConfirmModal state={confirm} onClose={() => setConfirm(s => ({ ...s, open: false }))} />
    </div>
  )
}
