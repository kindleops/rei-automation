import { useState, useEffect, useCallback, useRef } from 'react'
import { getSupabaseClient } from '../../lib/supabaseClient'
import { fetchQueueModel } from '../../lib/data/queueData'
import type { QueueModel, QueueItem } from '../../lib/data/queueData'
import * as backendClient from '../../lib/api/backendClient'
import type { BackendResult, BackendClientError } from '../../lib/api/backendClient'
import { emitNotification } from '../../shared/NotificationToast'
import { Icon } from '../../shared/icons'
import { formatRelativeTime } from '../../shared/formatters'

type LogEntry = { id: string; text: string; level: 'ok' | 'err' | 'info' | 'warn' }

interface ConfirmState {
  open: boolean
  title: string
  desc: string
  onConfirm: () => void
  danger?: boolean
}

const StatusBadge = ({ status }: { status: string }) => {
  const map: Record<string, string> = {
    ready: 'Ready', sent: 'Sent', delivered: 'Delivered',
    failed: 'Failed', scheduled: 'Scheduled', held: 'Held',
    approval: 'Pending', retry: 'Retrying', queued: 'Queued',
  }
  return (
    <span className={`nx-m-status is-${status}`}>
      {map[status] || status}
    </span>
  )
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
            Confirm
          </button>
          <button className="nx-m-modal-btn is-cancel" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

export const MobileQueueTab = () => {
  const [model, setModel] = useState<QueueModel | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])
  const [confirm, setConfirm] = useState<ConfirmState>({ open: false, title: '', desc: '', onConfirm: () => {} })
  const logRef = useRef<HTMLDivElement>(null)

  const addLog = useCallback((text: string, level: LogEntry['level'] = 'info') => {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    setLog(prev => [...prev.slice(-50), { id: `${Date.now()}-${Math.random()}`, text: `[${ts}] ${text}`, level }])
    setTimeout(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }) }, 50)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const data = await fetchQueueModel()
      setModel(data)
    } catch (err) {
      addLog(`Queue load error: ${err instanceof Error ? err.message : 'unknown'}`, 'err')
    } finally {
      setLoading(false)
    }
  }, [addLog])

  useEffect(() => {
    refresh()
    const supabase = getSupabaseClient()
    const ch = supabase
      .channel('mobile-queue-live')
      .on('postgres_changes', { event: '*', table: 'send_queue', schema: 'public' }, () => refresh())
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [refresh])

  const runAction = async (label: string, fn: () => Promise<BackendResult<unknown>>) => {
    setActionLoading(label)
    addLog(`Starting ${label}...`, 'info')
    try {
      const res = await fn()
      if (res.ok) {
        addLog(`${label} completed OK`, 'ok')
        emitNotification({ title: label, detail: 'Completed successfully', severity: 'success', sound: 'notification' })
        await refresh()
      } else {
        const errMsg = (res as BackendClientError).message
        addLog(`${label} failed: ${errMsg}`, 'err')
        emitNotification({ title: `${label} Failed`, detail: errMsg, severity: 'critical' })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error'
      addLog(`${label} error: ${msg}`, 'err')
      emitNotification({ title: `${label} Error`, detail: msg, severity: 'critical' })
    } finally {
      setActionLoading(null)
    }
  }

  const handleFeedQueue = () => {
    const count = model?.readyCount || 0
    setConfirm({
      open: true,
      title: 'Feed Queue',
      desc: `This will feed candidates into the queue. Currently ${count} items ready. Continue?`,
      onConfirm: () => runAction('Feed Queue', () => backendClient.runQueueNow({ dry_run: false }) as Promise<BackendResult<unknown>>),
    })
  }

  const handleRunQueue = () => {
    const count = model?.readyCount || 0
    if (count > 50) {
      setConfirm({
        open: true,
        title: 'Run Queue',
        desc: `This will send ${count} messages immediately. This action cannot be undone. Are you sure?`,
        danger: true,
        onConfirm: () => runAction('Run Queue', () => backendClient.runQueueNow({ limit: count }) as Promise<BackendResult<unknown>>),
      })
    } else {
      runAction('Run Queue', () => backendClient.runQueueNow({}) as Promise<BackendResult<unknown>>)
    }
  }

  const handleRetryFailed = () => {
    const count = model?.failedCount || 0
    setConfirm({
      open: true,
      title: 'Retry Failed',
      desc: `Retry ${count} failed items? Items that are retry-eligible will be requeued.`,
      onConfirm: () => runAction('Retry Failed', () => backendClient.retryFailed({}) as Promise<BackendResult<unknown>>),
    })
  }

  const handleReconcile = () => {
    runAction('Reconcile Delivery', () => backendClient.reconcileDelivery({}) as Promise<BackendResult<unknown>>)
  }

  const failedItems = (model?.items || []).filter((i: QueueItem) => i.status === 'failed').slice(0, 8)
  const pendingItems = (model?.items || []).filter((i: QueueItem) => i.status === 'ready' || i.status === 'scheduled').slice(0, 8)

  if (loading) {
    return (
      <div className="nx-m-loading">
        <div className="nx-m-spinner" />
        <span>Syncing queue...</span>
      </div>
    )
  }

  return (
    <div className="nx-m-queue">
      {/* Stats */}
      <div className="nx-m-stat-grid">
        <div className="nx-m-stat-card is-queued">
          <div className="nx-m-stat-val">{model?.readyCount || 0}</div>
          <div className="nx-m-stat-label">Ready</div>
        </div>
        <div className="nx-m-stat-card is-sent">
          <div className="nx-m-stat-val">{model?.sentTodayCount || 0}</div>
          <div className="nx-m-stat-label">Sent</div>
        </div>
        <div className="nx-m-stat-card is-delivered">
          <div className="nx-m-stat-val">{model?.approvalCount || 0}</div>
          <div className="nx-m-stat-label">Approval</div>
        </div>
        <div className="nx-m-stat-card is-failed">
          <div className="nx-m-stat-val">{model?.failedCount || 0}</div>
          <div className="nx-m-stat-label">Failed</div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="nx-m-action-grid">
        <button
          className="nx-m-action-btn is-feed"
          onClick={handleFeedQueue}
          disabled={!!actionLoading}
        >
          {actionLoading === 'Feed Queue' ? <div className="nx-m-spinner" style={{ width: 16, height: 16 }} /> : <Icon name="zap" style={{ width: 16, height: 16 }} />}
          Feed Queue
        </button>
        <button
          className="nx-m-action-btn is-run"
          onClick={handleRunQueue}
          disabled={!!actionLoading}
        >
          {actionLoading === 'Run Queue' ? <div className="nx-m-spinner" style={{ width: 16, height: 16 }} /> : <Icon name="play" style={{ width: 16, height: 16 }} />}
          Run Queue
        </button>
        <button
          className="nx-m-action-btn is-retry"
          onClick={handleRetryFailed}
          disabled={!!actionLoading || (model?.failedCount || 0) === 0}
        >
          {actionLoading === 'Retry Failed' ? <div className="nx-m-spinner" style={{ width: 16, height: 16 }} /> : <Icon name="refresh-cw" style={{ width: 16, height: 16 }} />}
          Retry Failed
        </button>
        <button
          className="nx-m-action-btn is-reconcile"
          onClick={handleReconcile}
          disabled={!!actionLoading}
        >
          {actionLoading === 'Reconcile Delivery' ? <div className="nx-m-spinner" style={{ width: 16, height: 16 }} /> : <Icon name="activity" style={{ width: 16, height: 16 }} />}
          Reconcile
        </button>
      </div>

      {/* Capacity bar */}
      {model && (
        <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: '12px 14px', border: '1px solid rgba(255,255,255,0.07)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
            <span>Daily capacity</span>
            <span style={{ color: 'rgba(255,255,255,0.8)', fontWeight: 700 }}>{model.sentTodayCount} / 1,200</span>
          </div>
          <div style={{ height: 6, borderRadius: 4, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              width: `${Math.min((model.sentTodayCount / 1200) * 100, 100)}%`,
              background: model.sentTodayCount > 1000 ? '#ef4444' : model.sentTodayCount > 700 ? '#eab308' : '#22c55e',
              borderRadius: 4,
              transition: 'width 0.4s ease',
            }} />
          </div>
        </div>
      )}

      {/* Response log */}
      <div className="nx-m-queue-section">
        <div className="nx-m-section-title">
          <span className="nx-m-live-dot" style={{ marginRight: 6 }} />
          Live Response Log
        </div>
        <div className="nx-m-log" ref={logRef}>
          {log.length === 0 ? (
            <div className="nx-m-log-entry">No activity yet. Run a queue action to see output.</div>
          ) : (
            log.map(entry => (
              <div key={entry.id} className={`nx-m-log-entry is-${entry.level}`}>
                {entry.text}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Failed items */}
      {failedItems.length > 0 && (
        <div className="nx-m-queue-section">
          <div className="nx-m-section-title">Failed Items</div>
          {failedItems.map((item: QueueItem) => (
            <div key={item.id} className="nx-m-queue-item is-failed">
              <div className="nx-m-queue-item-header">
                <div>
                  <div className="nx-m-queue-seller">{item.sellerName}</div>
                  <div className="nx-m-queue-addr">{item.propertyAddress}</div>
                </div>
                <StatusBadge status={item.status} />
              </div>
              <div className="nx-m-queue-preview">{item.messageText || item.failureReason || '—'}</div>
              <div className="nx-m-queue-footer">
                <div className="nx-m-queue-meta">{formatRelativeTime(item.scheduledForLocal)} · {item.market}</div>
                <div className="nx-m-queue-actions">
                  {item.retryEligible && (
                    <button
                      className="nx-m-icon-btn is-success"
                      title="Retry"
                                        onClick={() => runAction(`Retry ${item.sellerName}`, () => backendClient.retryQueueItem(item.id) as Promise<BackendResult<unknown>>)}
                    >
                      <Icon name="refresh-cw" />
                    </button>
                  )}
                  <button
                    className="nx-m-icon-btn is-danger"
                    title="Cancel"
                    onClick={() => runAction(`Cancel ${item.sellerName}`, () => backendClient.cancelQueueItem(item.id) as Promise<BackendResult<unknown>>)}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pending items */}
      {pendingItems.length > 0 && (
        <div className="nx-m-queue-section">
          <div className="nx-m-section-title">Ready to Send</div>
          {pendingItems.map((item: QueueItem) => (
            <div key={item.id} className="nx-m-queue-item">
              <div className="nx-m-queue-item-header">
                <div>
                  <div className="nx-m-queue-seller">{item.sellerName}</div>
                  <div className="nx-m-queue-addr">{item.propertyAddress}</div>
                </div>
                <StatusBadge status={item.status} />
              </div>
              <div className="nx-m-queue-preview">{item.messageText}</div>
              <div className="nx-m-queue-footer">
                <div className="nx-m-queue-meta">{formatRelativeTime(item.scheduledForLocal)} · {item.market}</div>
                <div className="nx-m-queue-actions">
                  <button
                    className="nx-m-icon-btn"
                    title="Hold"
                    onClick={() => runAction(`Hold ${item.sellerName}`, () => backendClient.holdQueueItem(item.id) as Promise<BackendResult<unknown>>)}
                  >
                    <Icon name="pause" />
                  </button>
                  <button
                    className="nx-m-icon-btn is-danger"
                    title="Cancel"
                    onClick={() => runAction(`Cancel ${item.sellerName}`, () => backendClient.cancelQueueItem(item.id) as Promise<BackendResult<unknown>>)}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && (model?.items || []).length === 0 && (
        <div className="nx-m-empty">Queue is empty</div>
      )}

      <ConfirmModal state={confirm} onClose={() => setConfirm(s => ({ ...s, open: false }))} />
    </div>
  )
}
