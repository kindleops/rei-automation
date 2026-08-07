import { useEffect, useState } from 'react'
import { subscribeToasts, type NexusNotification } from '../../shared/NotificationToast'
import { toastSeverityToDomain } from './ops-humanize'

/**
 * Bridge between the toast bus and the Operations Center.
 *
 * `shared/NotificationToast.tsx` was a third, parallel notification system: its
 * own event bus, its own severity enum ('info'|'success'|'warning'|'critical')
 * incompatible with the domain's ('positive'|'neutral'|'warning'|'critical'),
 * and it was never synced with the bell. A toast fired, auto-dismissed after
 * 6s, and left no trace anywhere the operator could go back and look.
 *
 * Toasts are transient by design (R10.3), so they are not promoted into the
 * server-backed notification feed. Instead they are retained for the session
 * and rendered in the Operations Center's Activity section, with the severity
 * enum reconciled, so nothing an operator saw for six seconds is lost.
 */

export interface SessionEvent {
  id: string
  at: string
  title: string
  body: string
  actor: string
  tone: 'positive' | 'neutral' | 'caution' | 'critical'
  source: 'session'
  threadKey?: string
}

const MAX_SESSION_EVENTS = 60

const toneFor = (severity: string): SessionEvent['tone'] => {
  switch (toastSeverityToDomain(severity)) {
    case 'positive': return 'positive'
    case 'warning': return 'caution'
    case 'critical': return 'critical'
    default: return 'neutral'
  }
}

const store: SessionEvent[] = []
const listeners = new Set<(events: SessionEvent[]) => void>()

const record = (toast: NexusNotification) => {
  store.unshift({
    id: `session-${toast.id}`,
    at: toast.timestamp.toISOString(),
    title: toast.title,
    body: toast.detail ?? '',
    actor: toast.source ?? 'This session',
    tone: toneFor(toast.severity),
    source: 'session',
  })
  if (store.length > MAX_SESSION_EVENTS) store.length = MAX_SESSION_EVENTS
  const snapshot = [...store]
  for (const listener of listeners) listener(snapshot)
}

let bridgeStarted = false

/** Called once at app start so events are captured even with no panel open. */
export function startSessionEventBridge(): () => void {
  if (bridgeStarted) return () => {}
  bridgeStarted = true
  const unsubscribe = subscribeToasts(record)
  return () => {
    bridgeStarted = false
    unsubscribe()
  }
}

export function useSessionEvents(): SessionEvent[] {
  const [events, setEvents] = useState<SessionEvent[]>(() => [...store])

  useEffect(() => {
    listeners.add(setEvents)
    setEvents([...store])
    return () => { listeners.delete(setEvents) }
  }, [])

  return events
}
