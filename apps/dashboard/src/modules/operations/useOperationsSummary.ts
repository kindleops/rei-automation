import { useEffect, useMemo, useRef, useState } from 'react'
import { getQueueProcessorHealth, type QueueProcessorHealth } from '../../lib/data/inboxData'
import { getQueueControlSettings } from '../../lib/api/backendClient'
import { useNotificationIntelligence } from '../../domain/notifications/useNotificationIntelligence'
import { resolveSendingStatus, type ControlInput, type SendingStatus } from './ops-status'

/**
 * One poll for the whole Operations Center.
 *
 * Before this, queue health was polled independently by InboxPage, by
 * `usePinnedAppDockBadges` (its own 60s timer) and by the queue popover, each
 * feeding a different status derivation. This is the single read, and
 * `resolveSendingStatus` is the single interpretation.
 */

const POLL_MS = 45_000

export interface OperationsSummary {
  status: SendingStatus
  health: QueueProcessorHealth | null
  control: ControlInput | null
  loading: boolean
  /** True when the health read itself failed — never reported as healthy. */
  healthError: string | null
  /** Unread, deduplicated notifications. */
  unreadCount: number
  /** Items that need an operator decision: blockers + unread criticals. */
  attentionCount: number
  refresh: () => void
  lastCheckedAt: string | null
}

export function useOperationsSummary(): OperationsSummary {
  const [health, setHealth] = useState<QueueProcessorHealth | null>(null)
  const [control, setControl] = useState<ControlInput | null>(null)
  const [loading, setLoading] = useState(true)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const mountedRef = useRef(true)

  const { notifications, unreadCount } = useNotificationIntelligence()

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    let cancelled = false

    const read = async () => {
      try {
        const [healthResult, controlResult] = await Promise.allSettled([
          getQueueProcessorHealth(),
          getQueueControlSettings(),
        ])

        if (cancelled || !mountedRef.current) return

        if (healthResult.status === 'fulfilled') {
          setHealth(healthResult.value)
          setHealthError(null)
        } else {
          setHealth(null)
          setHealthError('Queue health could not be read.')
        }

        if (controlResult.status === 'fulfilled' && controlResult.value.ok) {
          const diagnostics = controlResult.value.data?.diagnostics as ControlInput | undefined
          setControl(diagnostics ?? null)
        } else {
          setControl(null)
        }
      } catch {
        if (cancelled || !mountedRef.current) return
        setHealth(null)
        setHealthError('Queue health could not be read.')
      } finally {
        if (!cancelled && mountedRef.current) setLoading(false)
      }
    }

    void read()
    const interval = window.setInterval(() => { void read() }, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [tick])

  const status = useMemo(
    () => resolveSendingStatus({ health, control, loading }),
    [health, control, loading],
  )

  const attentionCount = useMemo(() => {
    const blockers = status.reasons.filter((r) => r.severity === 'blocker').length
    const criticalUnread = notifications.filter(
      (item) => item.status === 'unread' && (item.severity === 'critical' || item.severity === 'warning'),
    ).length
    return blockers + criticalUnread
  }, [status.reasons, notifications])

  return {
    status,
    health,
    control,
    loading,
    healthError,
    unreadCount,
    attentionCount,
    refresh: () => setTick((n) => n + 1),
    lastCheckedAt: health?.checkedAt ?? null,
  }
}
