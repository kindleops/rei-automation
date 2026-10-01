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

/**
 * Deal Intelligence is a PANEL inside the inbox workspace, not a route of its
 * own - it lives at /inbox just like the thread list. So tapping Inbox in the
 * dock to get back out of it called pushRoutePath('/inbox') while already on
 * /inbox, which is a no-op: the panel stayed open and the operator was stuck
 * with no way back to the list.
 *
 * This is the counterpart event. The dock fires it instead of a dead navigation
 * when Inbox is tapped while already on an inbox route.
 */
export const CLOSE_INBOX_DEAL_INTEL_EVENT = 'nx:close-inbox-deal-intelligence'

export function closeInboxDealIntelligence() {
  if (typeof window === 'undefined') return
  clearPendingInboxDealIntelligence()
  clearPendingInboxDealIntelligenceIdentity()
  window.dispatchEvent(new CustomEvent(CLOSE_INBOX_DEAL_INTEL_EVENT))
}

export function isInboxRoute(path: string): boolean {
  return INBOX_DEAL_INTEL_ROUTES.has(normalizeRoutePath(path))
}

/**
 * IS THE DEAL INTELLIGENCE PANEL SHOWING?
 *
 * Deal Intelligence lives at /inbox, so anything that names the current app
 * from the route alone (the desktop sidebar) highlighted Inbox while the
 * operator was reading Deal Intelligence. The main window's InboxPage reports
 * whether its panel is showing; readers subscribe.
 */
let dealIntelShowing = false
const dealIntelListeners = new Set<() => void>()

export function publishInboxDealIntelligenceShowing(showing: boolean) {
  if (dealIntelShowing === showing) return
  dealIntelShowing = showing
  dealIntelListeners.forEach((listener) => listener())
}

export function isInboxDealIntelligenceShowing(): boolean {
  return dealIntelShowing
}

export function subscribeInboxDealIntelligenceShowing(listener: () => void): () => void {
  dealIntelListeners.add(listener)
  return () => { dealIntelListeners.delete(listener) }
}

/**
 * OPEN ONE CONVERSATION FROM ANOTHER APP.
 *
 * Map, Live Activity and Campaign replies used to push `/inbox?thread=<key>`,
 * but nothing read the parameter: the operator landed on the Inbox list and
 * had to find the seller by hand. The pending thread is stored (it survives the
 * route change and a cold mount) and InboxPage opens exactly that conversation
 * — fetched by key when it is not in the loaded page — never a different one.
 */
export const OPEN_INBOX_THREAD_EVENT = 'nx:open-inbox-thread'
const PENDING_THREAD_KEY = 'nx.pending-open-thread'

export interface PendingInboxThread {
  threadKey: string
  propertyId?: string | null
}

export function openInboxThread(target: PendingInboxThread) {
  if (typeof window === 'undefined' || !target.threadKey) return
  try { sessionStorage.setItem(PENDING_THREAD_KEY, JSON.stringify(target)) } catch { /* the URL still carries it */ }
  const path = normalizeRoutePath(window.location.pathname)
  const url = `/inbox?thread=${encodeURIComponent(target.threadKey)}`
  if (path !== '/inbox' || !window.location.search.includes(encodeURIComponent(target.threadKey))) pushRoutePath(url)
  window.dispatchEvent(new CustomEvent(OPEN_INBOX_THREAD_EVENT))
  window.setTimeout(() => window.dispatchEvent(new CustomEvent(OPEN_INBOX_THREAD_EVENT)), 60)
}

export function peekPendingInboxThread(): PendingInboxThread | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(PENDING_THREAD_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as PendingInboxThread
      if (parsed?.threadKey) return parsed
    }
  } catch { /* fall through to the URL */ }
  if (!isInboxRoute(window.location.pathname)) return null
  const fromUrl = new URLSearchParams(window.location.search).get('thread')
  return fromUrl ? { threadKey: fromUrl } : null
}

export function clearPendingInboxThread() {
  if (typeof window === 'undefined') return
  try { sessionStorage.removeItem(PENDING_THREAD_KEY) } catch { /* ignore */ }
  const params = new URLSearchParams(window.location.search)
  if (params.has('thread')) {
    params.delete('thread')
    const qs = params.toString()
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`)
  }
}
