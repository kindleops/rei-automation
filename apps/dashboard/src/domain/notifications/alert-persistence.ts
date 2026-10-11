/**
 * ALERT PERSISTENCE — which alerts stay, which go, and when one is stale.
 *
 * Pure (no React, no I/O). Every rule here is VISIBILITY ONLY: hiding,
 * collapsing or expiring an alert never writes to it and never touches a lead.
 *
 *   actionable     the operator has something to do (a hot lead to work, a
 *                  price to answer, a reply that was blocked or failed, a real
 *                  call request, a seller waiting on review, a system failure).
 *                  Its pop-up stays until it is swiped / closed / opened.
 *   informational  a fact (a reply arrived, ownership confirmed, an opt-out was
 *                  applied, a campaign launched). Its pop-up leaves on its own.
 *
 *   collapse       inbox alerts collapse to ONE card per conversation, the
 *                  latest / most actionable one, updated in place (its count
 *                  says how many it stands for).
 *   expiry         an alert is stale once its conversation was answered after
 *                  it (the list carries the thread's latest outbound), once an
 *                  informational alert is a day old, or once an actionable one
 *                  has asked for three days with nothing new.
 */
import type { NotificationEvent } from './notification-contract'

export type AlertPersistence = 'actionable' | 'informational'

/** Inbox alert types that ask the operator to act. */
const ACTIONABLE_INBOX = new Set([
  'inbox_hot_lead',
  'inbox_price_captured',
  'inbox_needs_call',
  'inbox_auto_reply_blocked',
  'inbox_scheduled_reply_failed',
  'inbox_delivery_failure',
  'inbox_sla_breach',
  'inbox_thread_escalation',
])

export const INFO_TTL_MS = 24 * 3600e3
export const ACTION_TTL_MS = 72 * 3600e3
/** pop-up life of an informational alert */
export const INFO_TOAST_MS = 5_000

export function alertPersistence(event: Pick<NotificationEvent, 'type' | 'domain' | 'severity'>): AlertPersistence {
  const type = String(event.type ?? '').toLowerCase()
  if (event.domain === 'inbox' || type.startsWith('inbox_')) return ACTIONABLE_INBOX.has(type) ? 'actionable' : 'informational'
  if (event.severity === 'critical') return 'actionable'
  if (event.domain === 'closing' && event.severity === 'warning') return 'actionable'
  if (event.domain === 'signals' && event.severity === 'warning') return 'actionable'
  return 'informational'
}

export const isActionableAlert = (event: Pick<NotificationEvent, 'type' | 'domain' | 'severity'>): boolean => alertPersistence(event) === 'actionable'

/** Toast lifetime for an arrival: actionable stays (null), informational leaves after `infoMs`. */
export function toastLifetime(event: Pick<NotificationEvent, 'type' | 'domain' | 'severity'>, infoMs = INFO_TOAST_MS): { autoDismiss: boolean; dismissMs: number } {
  return isActionableAlert(event) ? { autoDismiss: false, dismissMs: 0 } : { autoDismiss: true, dismissMs: infoMs }
}

const ms = (v: string | null | undefined): number => {
  const t = Date.parse(v ?? '')
  return Number.isFinite(t) ? t : NaN
}

export type ExpiryReason = 'answered' | 'aged' | null

/** Why this alert no longer belongs on screen (null = it does). */
export function alertExpiry(event: NotificationEvent, now: number = Date.now()): ExpiryReason {
  const created = ms(event.createdAt)
  const replied = ms(event.threadRepliedAt)
  if (Number.isFinite(created) && Number.isFinite(replied) && replied > created) return 'answered'
  if (!Number.isFinite(created)) return null
  const ttl = isActionableAlert(event) ? ACTION_TTL_MS : INFO_TTL_MS
  return now - created > ttl ? 'aged' : null
}

/** One conversation's key: the thread (a workflow alert on it often carries no property, so property is not part of it). */
export function conversationKey(event: Pick<NotificationEvent, 'domain' | 'threadKey'>): string | null {
  if (event.domain !== 'inbox' || !event.threadKey) return null
  return `thread:${event.threadKey}`
}

const rank = (e: NotificationEvent) => (isActionableAlert(e) ? 1 : 0)

/**
 * Collapse inbox alerts to one card per conversation: the most actionable,
 * then newest, alert represents it; unread if any member is unread; its count
 * is the members' total. Non-inbox alerts pass through. Order is preserved
 * (newest-first in, newest-first out by the representative's position).
 */
export function collapseByConversation(events: NotificationEvent[]): NotificationEvent[] {
  const groups = new Map<string, NotificationEvent[]>()
  const order: Array<string | NotificationEvent> = []
  for (const e of events) {
    const key = conversationKey(e)
    if (!key) { order.push(e); continue }
    const g = groups.get(key)
    if (g) g.push(e)
    else { groups.set(key, [e]); order.push(key) }
  }
  return order.map((slot) => {
    if (typeof slot !== 'string') return slot
    const members = groups.get(slot) ?? []
    if (members.length === 1) return members[0]
    const rep = [...members].sort((a, b) => rank(b) - rank(a) || ms(b.createdAt) - ms(a.createdAt))[0]
    const newest = [...members].sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0]
    const unread = members.some((m) => m.status === 'unread')
    return {
      ...rep,
      // the card sits where its newest member arrived and says when it last moved
      createdAt: newest.createdAt,
      status: unread ? 'unread' : rep.status,
      groupedCount: members.reduce((n, m) => n + Math.max(1, m.groupedCount ?? 1), 0),
      memberIds: members.flatMap((m) => m.memberIds ?? [m.id]),
      sellerName: members.map((m) => m.sellerName).find(Boolean) ?? null,
      propertyId: rep.propertyId ?? members.map((m) => m.propertyId).find(Boolean) ?? null,
      threadRepliedAt: members.map((m) => m.threadRepliedAt).filter(Boolean).sort().pop() ?? null,
    }
  })
}

/** What the notification centre shows: undismissed, unexpired, one card per conversation. */
export function visibleAlerts(events: NotificationEvent[], now: number = Date.now()): NotificationEvent[] {
  const live = events.filter((e) => e.status !== 'dismissed' && !alertExpiry(e, now))
  return collapseByConversation(live).filter((e) => !alertExpiry(e, now))
}

/** Every row id a (possibly collapsed) card stands for. */
export const memberIdsOf = (event: NotificationEvent): string[] => (event.memberIds?.length ? event.memberIds : [event.id])

/** Sticky = what would stay on screen asking for the operator. */
export function stickyCount(events: NotificationEvent[], now: number = Date.now()): number {
  return visibleAlerts(events, now).filter((e) => e.status === 'unread' && isActionableAlert(e)).length
}
