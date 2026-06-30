import { normalizeRoutePath, pushRoutePath } from '../../app/router'

export const MOBILE_INBOX_BADGE_EVENT = 'nx:mobile-inbox-badge'
export const OPEN_INBOX_DEAL_INTEL_EVENT = 'nx:open-inbox-deal-intelligence'

export interface MobileInboxBadgeDetail {
  unreadCount: number
}

const INBOX_DEAL_INTEL_ROUTES = new Set(['/', '/inbox', '/conversation'])
const PENDING_DEAL_INTEL_KEY = 'nx.pending-deal-intel'

export function publishMobileInboxBadge(unreadCount: number) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<MobileInboxBadgeDetail>(MOBILE_INBOX_BADGE_EVENT, {
    detail: { unreadCount: Math.max(0, unreadCount) },
  }))
}

const dispatchOpenInboxDealIntel = () => {
  window.dispatchEvent(new CustomEvent(OPEN_INBOX_DEAL_INTEL_EVENT))
}

/** Opens Deal Desk deal intelligence (25% panel) inside the inbox workspace. */
export function openInboxDealIntelligence() {
  if (typeof window === 'undefined') return
  sessionStorage.setItem(PENDING_DEAL_INTEL_KEY, '1')
  const path = normalizeRoutePath(window.location.pathname)
  if (!INBOX_DEAL_INTEL_ROUTES.has(path)) {
    pushRoutePath('/inbox')
  }
  dispatchOpenInboxDealIntel()
  window.setTimeout(dispatchOpenInboxDealIntel, 50)
  window.setTimeout(dispatchOpenInboxDealIntel, 250)
}

export function peekPendingInboxDealIntelligence(): boolean {
  if (typeof window === 'undefined') return false
  return sessionStorage.getItem(PENDING_DEAL_INTEL_KEY) === '1'
}

export function clearPendingInboxDealIntelligence() {
  if (typeof window === 'undefined') return
  sessionStorage.removeItem(PENDING_DEAL_INTEL_KEY)
}

export function consumePendingInboxDealIntelligence(): boolean {
  const pending = peekPendingInboxDealIntelligence()
  if (pending) clearPendingInboxDealIntelligence()
  return pending
}