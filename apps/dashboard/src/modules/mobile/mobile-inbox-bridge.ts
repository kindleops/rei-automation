export const MOBILE_INBOX_BADGE_EVENT = 'nx:mobile-inbox-badge'

export interface MobileInboxBadgeDetail {
  unreadCount: number
}

export function publishMobileInboxBadge(unreadCount: number) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<MobileInboxBadgeDetail>(MOBILE_INBOX_BADGE_EVENT, {
    detail: { unreadCount: Math.max(0, unreadCount) },
  }))
}