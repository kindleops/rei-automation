/**
 * NEXUS Notification Toast System
 *
 * Real-time notification toasts that slide in from the top-right corner.
 * Supports multiple severity levels, auto-dismiss, and a persistent
 * notification center accessible from the bell icon.
 *
 * Uses a global event bus pattern — any module can emit notifications.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './icons'
import { playSound } from './sounds'
import type { SoundEvent } from './sounds'

// ── Types ─────────────────────────────────────────────────────────────────

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'critical'

export interface NexusNotification {
  id: string
  title: string
  detail?: string
  severity: NotificationSeverity
  timestamp: Date
  sound?: SoundEvent
  autoDismiss?: boolean     // default: true
  dismissMs?: number        // default: 3000
  read?: boolean
  source?: string           // module that emitted the notification
  action?: {
    label: string
    onClick: () => void
  }
}

// ── Global notification bus ───────────────────────────────────────────────

type NotifyListener = (notification: NexusNotification) => void

const _listeners = new Set<NotifyListener>()
let _notifCounter = 0

export function emitNotification(
  partial: Omit<NexusNotification, 'id' | 'timestamp'>,
): void {
  _notifCounter++
  const notif: NexusNotification = {
    id: `notif-${_notifCounter}-${Date.now()}`,
    timestamp: new Date(),
    autoDismiss: true,
    dismissMs: 3000,
    read: false,
    ...partial,
  }
  for (const fn of _listeners) fn(notif)
}

function subscribeNotifications(fn: NotifyListener): () => void {
  _listeners.add(fn)
  return () => { _listeners.delete(fn) }
}

// ── Toast Stack Component ─────────────────────────────────────────────────

const MAX_VISIBLE_TOASTS = 4

const severityClass: Record<NotificationSeverity, string> = {
  info: 'is-info',
  success: 'is-success',
  warning: 'is-warning',
  critical: 'is-critical',
}

const severityIcon: Record<NotificationSeverity, string> = {
  info: 'bell',
  success: 'check',
  warning: 'alert',
  critical: 'shield',
}

export const NotificationToasts = () => {
  const [toasts, setToasts] = useState<NexusNotification[]>([])
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
  }, [])

  useEffect(() => {
    const unsub = subscribeNotifications((notif) => {
      setToasts((prev) => [notif, ...prev].slice(0, MAX_VISIBLE_TOASTS + 2))

      // Play sound
      if (notif.sound) {
        playSound(notif.sound)
      } else if (notif.severity === 'critical') {
        playSound('alert-triggered')
      } else {
        playSound('notification')
      }

      // Auto-dismiss
      if (notif.autoDismiss !== false) {
        const ms = notif.dismissMs ?? 3000
        const timer = setTimeout(() => {
          dismiss(notif.id)
        }, ms)
        timersRef.current.set(notif.id, timer)
      }
    })

    return () => {
      unsub()
      for (const timer of timersRef.current.values()) clearTimeout(timer)
      timersRef.current.clear()
    }
  }, [dismiss])

  if (toasts.length === 0) return null

  return (
    <div className="nx-toasts" aria-live="polite">
      {toasts.slice(0, MAX_VISIBLE_TOASTS).map((toast, i) => (
        <div
          key={toast.id}
          className={`nx-toast ${severityClass[toast.severity]}`}
          style={{ '--toast-index': i } as React.CSSProperties}
        >
          <div className="nx-toast__icon-wrap">
            <Icon name={severityIcon[toast.severity] as Parameters<typeof Icon>[0]['name']} className="nx-toast__icon" />
          </div>
          <div className="nx-toast__body">
            <span className="nx-toast__title">{toast.title}</span>
            {toast.detail && <span className="nx-toast__detail">{toast.detail}</span>}
            {toast.action && (
              <button 
                type="button" 
                className="nx-toast__action" 
                onClick={(e) => {
                  e.stopPropagation()
                  toast.action?.onClick()
                  dismiss(toast.id)
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
          <button type="button" className="nx-toast__dismiss" onClick={() => dismiss(toast.id)}>
            <Icon name="close" className="nx-toast__dismiss-icon" />
          </button>
        </div>
      ))}
    </div>
  )
}

// ── Notification Center ───────────────────────────────────────────────────
// Persistent log of all notifications, accessible from the bell icon.

interface NotificationCenterProps {
  open: boolean
  onClose: () => void
}

export const NotificationCenter = ({ open, onClose }: NotificationCenterProps) => {
  const [history, setHistory] = useState<NexusNotification[]>([])
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const unsub = subscribeNotifications((notif) => {
      setHistory((prev) => [notif, ...prev].slice(0, 100))
    })
    return unsub
  }, [])

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  if (!open) return null

  const unreadCount = history.filter((n) => !n.read).length

  return (
    <div className="nx-notif-center-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <aside className="nx-notif-center" ref={panelRef} role="dialog" aria-label="Notification Center">
        <header className="nx-notif-center__header">
          <h2>Notifications</h2>
          {unreadCount > 0 && <span className="nx-badge nx-badge--primary">{unreadCount} new</span>}
          <button type="button" className="nx-notif-center__close" onClick={onClose}>
            <Icon name="close" className="nx-notif-center__close-icon" />
          </button>
        </header>
        <div className="nx-notif-center__list">
          {history.length === 0 ? (
            <div className="nx-empty-state">No notifications yet.</div>
          ) : (
            history.map((notif) => (
              <div key={notif.id} className={`nx-notif-item ${severityClass[notif.severity]} ${notif.read ? 'is-read' : ''}`}>
                <Icon name={severityIcon[notif.severity] as Parameters<typeof Icon>[0]['name']} className="nx-notif-item__icon" />
                <div className="nx-notif-item__body">
                  <span className="nx-notif-item__title">{notif.title}</span>
                  {notif.detail && <span className="nx-notif-item__detail">{notif.detail}</span>}
                  <span className="nx-notif-item__time">
                    {notif.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    {notif.source && ` · ${notif.source}`}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </aside>
    </div>
  )
}

// ── Hook for easy notification center usage ───────────────────────────────

export function useNotificationCount(): number {
  const [count, setCount] = useState(0)

  useEffect(() => {
    const unsub = subscribeNotifications(() => {
      setCount((prev) => prev + 1)
    })
    return unsub
  }, [])

  return count
}
