import { useCallback, useEffect, useState } from 'react'
import { getQueueProcessorHealth } from '../../lib/data/inboxData'
import { useNotificationIntelligence } from '../../domain/notifications/useNotificationIntelligence'
import { useMobileInboxBadge } from './useMobileInboxBadge'
import type { DockAppBadges, PinnedAppId } from './pinned-app-dock.types'

export function usePinnedAppDockBadges(): DockAppBadges {
  const inboxUnread = useMobileInboxBadge()
  const { unreadCount: alertCount } = useNotificationIntelligence()
  const [queueFailed, setQueueFailed] = useState(0)
  const [queueStatus, setQueueStatus] = useState<'healthy' | 'warning' | 'critical' | 'unknown'>('unknown')

  const refreshQueue = useCallback(async () => {
    try {
      const health = await getQueueProcessorHealth()
      setQueueFailed(health?.failedTodayCount ?? 0)
      setQueueStatus(health?.status ?? 'unknown')
    } catch {
      setQueueFailed(0)
      setQueueStatus('unknown')
    }
  }, [])

  useEffect(() => {
    void refreshQueue()
    const interval = window.setInterval(() => { void refreshQueue() }, 60_000)
    return () => window.clearInterval(interval)
  }, [refreshQueue])

  const badges: DockAppBadges = {}

  if (inboxUnread > 0) {
    badges['/inbox'] = { count: inboxUnread, tone: 'default' }
  }

  if (queueFailed > 0 || queueStatus === 'critical' || queueStatus === 'warning') {
    badges['/queue'] = {
      count: queueFailed > 0 ? queueFailed : undefined,
      tone: queueStatus === 'critical' ? 'critical' : 'warning',
      dot: queueFailed === 0,
    }
  }

  if (alertCount > 0) {
    badges['/analytics'] = { count: alertCount, tone: 'warning' }
  }

  return badges
}

export function badgeForApp(badges: DockAppBadges, appId: PinnedAppId) {
  return badges[appId]
}