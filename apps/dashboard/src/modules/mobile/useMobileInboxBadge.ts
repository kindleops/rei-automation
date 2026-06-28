import { useEffect, useState } from 'react'
import { MOBILE_INBOX_BADGE_EVENT, type MobileInboxBadgeDetail } from './mobile-inbox-bridge'

export function useMobileInboxBadge(): number {
  const [unreadCount, setUnreadCount] = useState(0)

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<MobileInboxBadgeDetail>).detail
      if (detail) setUnreadCount(detail.unreadCount)
    }
    window.addEventListener(MOBILE_INBOX_BADGE_EVENT, handler as EventListener)
    return () => window.removeEventListener(MOBILE_INBOX_BADGE_EVENT, handler as EventListener)
  }, [])

  return unreadCount
}