import { useMobileInboxBadge } from './useMobileInboxBadge'
import { useOperationsSummary } from '../operations/useOperationsSummary'
import { toLegacyBadgeStatus } from '../operations/ops-status'
import type { DockAppBadges, PinnedAppId } from './pinned-app-dock.types'

/**
 * LANE F — this hook used to run its own 60s poll of `getQueueProcessorHealth`
 * and read `health.status` directly, giving the dock a fourth, independently
 * timed queue derivation that could disagree with the top bar and the popover.
 * It now reads the shared Operations summary, so the dock badge carries the
 * same verdict as every other queue surface.
 */
export function usePinnedAppDockBadges(): DockAppBadges {
  const inboxUnread = useMobileInboxBadge()
  const { status, health } = useOperationsSummary()

  const queueFailed = health?.failedTodayCount ?? 0
  const queueStatus = toLegacyBadgeStatus(status)

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

  /*
   * The notification count used to be badged onto the Analytics app icon,
   * which has nothing to do with notifications — an operator seeing "12" on
   * Analytics would go look for twelve analytics items. Operations owns
   * notifications now, so the badge is removed rather than pointed at another
   * unrelated route.
   */

  return badges
}

export function badgeForApp(badges: DockAppBadges, appId: PinnedAppId) {
  return badges[appId]
}