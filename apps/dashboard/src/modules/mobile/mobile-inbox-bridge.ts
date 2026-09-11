import { normalizeRoutePath, pushRoutePath } from '../../app/router'

export const MOBILE_INBOX_BADGE_EVENT = 'nx:mobile-inbox-badge'
export const OPEN_INBOX_DEAL_INTEL_EVENT = 'nx:open-inbox-deal-intelligence'

export interface MobileInboxBadgeDetail {
  unreadCount: number
}

const INBOX_DEAL_INTEL_ROUTES = new Set(['/', '/inbox', '/conversation'])
const PENDING_DEAL_INTEL_KEY = 'nx.pending-deal-intel'
/**
 * WHICH deal to open, not merely that one should open.
 *
 * Without this the pending flag was identity-free, so InboxPage resolved Deal
 * Intelligence to the FIRST thread in the list whenever it was reached from
 * another app - i.e. it opened somebody else's deal. Stored alongside the flag
 * so both survive the route change and the unmount.
 */
const PENDING_DEAL_INTEL_IDENTITY_KEY = 'nx.pending-deal-intel-identity'

export interface PendingDealIntelIdentity {
  threadKey?: string | null
  propertyId?: string | null
  prospectId?: string | null
  masterOwnerId?: string | null
}

export function peekPendingInboxDealIntelligenceIdentity(): PendingDealIntelIdentity | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(PENDING_DEAL_INTEL_IDENTITY_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PendingDealIntelIdentity
    const hasAny = Boolean(parsed?.threadKey || parsed?.propertyId || parsed?.prospectId || parsed?.masterOwnerId)
    return hasAny ? parsed : null
  } catch {
    return null
  }
}

export function clearPendingInboxDealIntelligenceIdentity() {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.removeItem(PENDING_DEAL_INTEL_IDENTITY_KEY)
  } catch {
    /* ignore */
  }
}

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
export function openInboxDealIntelligence(identity?: PendingDealIntelIdentity) {
  if (typeof window === 'undefined') return
  sessionStorage.setItem(PENDING_DEAL_INTEL_KEY, '1')
  try {
    const hasAny = Boolean(
      identity?.threadKey || identity?.propertyId || identity?.prospectId || identity?.masterOwnerId,
    )
    // Only overwrite when a real identity was supplied. A caller with nothing to
    // say must not erase an identity a previous caller established.
    if (hasAny) sessionStorage.setItem(PENDING_DEAL_INTEL_IDENTITY_KEY, JSON.stringify(identity))
  } catch {
    /* a blocked sessionStorage must not stop the panel opening */
  }
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