/**
 * SystemToast bus — immediate, local confirmation of something the operator
 * just did ("Message sent", "Campaign duplicated", "Couldn’t pause …").
 *
 * A toast is NOT a notification: it is never persisted, never counted and
 * never the record of a system event. Notifications (the Notification
 * Center) are a separate read model. Keep this module to the transient
 * confirmation only.
 *
 * Pure (no React) so data modules and action handlers can confirm an action
 * without importing the overlay engine.
 */
import type { SoundEvent } from '../sounds'

export type LCToastSeverity = 'info' | 'success' | 'warning' | 'critical'

export interface LCToastMessage {
  id: string
  title: string
  detail?: string
  severity: LCToastSeverity
  timestamp: Date
  sound?: SoundEvent
  /** default: true, except critical (stays until dismissed) */
  autoDismiss?: boolean
  /** default: 6000 */
  dismissMs?: number
  read?: boolean
  /** module that raised it */
  source?: string
  /** the caller already played its own sound (or chose silence) */
  silent?: boolean
  action?: { label: string; onClick: () => void }
}

export type LCToastInput = Omit<LCToastMessage, 'id' | 'timestamp'>

type Listener = (toast: LCToastMessage) => void

const listeners = new Set<Listener>()
let counter = 0

/** Raise a toast. Same shape as the legacy `emitNotification`. */
export function lcToast(partial: LCToastInput): void {
  counter++
  const toast: LCToastMessage = {
    id: `toast-${counter}-${Date.now()}`,
    timestamp: new Date(),
    autoDismiss: partial.severity !== 'critical',
    dismissMs: 6000,
    read: false,
    ...partial,
  }
  for (const fn of listeners) fn(toast)
}

export function subscribeToasts(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** LC tone for a toast severity — red only for a true failure. */
export const TOAST_TONE: Record<LCToastSeverity, 'exec' | 'ok' | 'attn' | 'crit'> = {
  info: 'exec',
  success: 'ok',
  warning: 'attn',
  critical: 'crit',
}
