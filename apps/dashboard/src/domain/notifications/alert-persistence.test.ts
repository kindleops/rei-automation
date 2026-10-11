import { describe, expect, it } from 'vitest'
import type { NotificationEvent } from './notification-contract'
import { mapApiNotification } from './notification-contract'
import { ACTION_TTL_MS, alertExpiry, alertPersistence, collapseByConversation, INFO_TTL_MS, memberIdsOf, stickyCount, toastLifetime, visibleAlerts } from './alert-persistence'

const NOW = Date.parse('2026-10-10T18:00:00.000Z')
const ago = (h: number) => new Date(NOW - h * 3600e3).toISOString()
const ev = (id: string, over: Partial<NotificationEvent> = {}): NotificationEvent => ({
  id, domain: 'inbox', severity: 'positive', type: 'inbox_message_received', title: 't', body: '', status: 'unread', soundCategory: 'seller-reply',
  createdAt: ago(1), actions: [], threadKey: '+16125550101', ...over,
})

describe('persistence: only actionable alerts stay', () => {
  it('actionable vs informational', () => {
    for (const type of ['inbox_hot_lead', 'inbox_price_captured', 'inbox_needs_call', 'inbox_auto_reply_blocked', 'inbox_delivery_failure', 'inbox_sla_breach']) {
      expect(alertPersistence({ type, domain: 'inbox', severity: 'positive' })).toBe('actionable')
    }
    for (const type of ['inbox_message_received', 'inbox_negative_sentiment', 'inbox_opt_out_received', 'inbox_wrong_number', 'inbox_ownership_confirmed']) {
      expect(alertPersistence({ type, domain: 'inbox', severity: 'warning' })).toBe('informational')
    }
    expect(alertPersistence({ type: 'campaign_activated', domain: 'campaigns', severity: 'positive' })).toBe('informational')
    expect(alertPersistence({ type: 'sender_failure', domain: 'numbers', severity: 'critical' })).toBe('actionable')
  })
  it('toast life: actionable stays until dismissed; informational leaves after a few seconds', () => {
    expect(toastLifetime({ type: 'inbox_hot_lead', domain: 'inbox', severity: 'positive' })).toEqual({ autoDismiss: false, dismissMs: 0 })
    expect(toastLifetime({ type: 'inbox_message_received', domain: 'inbox', severity: 'neutral' })).toEqual({ autoDismiss: true, dismissMs: 5000 })
    expect(toastLifetime({ type: 'inbox_ownership_confirmed', domain: 'inbox', severity: 'positive' }, 4000).dismissMs).toBe(4000)
  })
})

describe('dedupe: one card per conversation, updated in place', () => {
  it('collapses a thread to its most actionable, newest alert; count + members carried; other threads untouched', () => {
    const list = [
      ev('n3', { createdAt: ago(0.5), type: 'inbox_message_received' }),
      ev('n2', { createdAt: ago(1), type: 'inbox_hot_lead', status: 'read', propertyId: 'p1' }),
      ev('x1', { threadKey: '+16125550199', createdAt: ago(2) }),
      ev('n1', { createdAt: ago(3), type: 'inbox_message_received', groupedCount: 2, sellerName: 'Sondra E' }),
      ev('c1', { domain: 'campaigns', type: 'campaign_activated', threadKey: null }),
    ]
    const out = collapseByConversation(list)
    expect(out.map((e) => e.id)).toEqual(['n2', 'x1', 'c1'])
    const card = out[0]
    expect(card.type).toBe('inbox_hot_lead')
    expect(card.createdAt).toBe(ago(0.5)) // moved when the newest member arrived
    expect(card.status).toBe('unread') // a member is unread
    expect(card.groupedCount).toBe(4)
    expect(memberIdsOf(card).sort()).toEqual(['n1', 'n2', 'n3'])
    expect(card.sellerName).toBe('Sondra E')
    expect(card.propertyId).toBe('p1')
  })
  it('a workflow alert on the thread (no property) collapses with the reply alerts', () => {
    const out = collapseByConversation([ev('w1', { type: 'inbox_needs_call', propertyId: null }), ev('r1', { propertyId: 'p1' })])
    expect(out).toHaveLength(1)
  })
})

describe('expiry: stale alerts leave (visibility only)', () => {
  it('answered: the thread had an outbound after the alert', () => {
    expect(alertExpiry(ev('a', { type: 'inbox_hot_lead', createdAt: ago(2), threadRepliedAt: ago(1) }), NOW)).toBe('answered')
    expect(alertExpiry(ev('a', { type: 'inbox_hot_lead', createdAt: ago(1), threadRepliedAt: ago(2) }), NOW)).toBeNull()
  })
  it('aged: informational after a day, actionable after three', () => {
    expect(alertExpiry(ev('i', { createdAt: new Date(NOW - INFO_TTL_MS + 1).toISOString() }), NOW)).toBeNull()
    expect(alertExpiry(ev('i', { createdAt: new Date(NOW - INFO_TTL_MS - 1).toISOString() }), NOW)).toBe('aged')
    expect(alertExpiry(ev('h', { type: 'inbox_hot_lead', createdAt: ago(48) }), NOW)).toBeNull()
    expect(alertExpiry(ev('h', { type: 'inbox_hot_lead', createdAt: new Date(NOW - ACTION_TTL_MS - 1).toISOString() }), NOW)).toBe('aged')
  })
  it('visibleAlerts: dismissed / expired out, then collapsed; stickyCount = unread actionable cards', () => {
    const list = [
      ev('h1', { type: 'inbox_hot_lead', createdAt: ago(1) }),
      ev('h0', { type: 'inbox_hot_lead', createdAt: ago(2) }),
      ev('old', { type: 'inbox_needs_call', threadKey: '+1999', createdAt: ago(100) }),
      ev('ans', { type: 'inbox_needs_call', threadKey: '+1888', createdAt: ago(5), threadRepliedAt: ago(4) }),
      ev('gone', { threadKey: '+1777', status: 'dismissed' }),
      ev('info', { threadKey: '+1666', createdAt: ago(2) }),
    ]
    const vis = visibleAlerts(list, NOW)
    expect(vis.map((e) => e.id)).toEqual(['h1', 'info'])
    expect(stickyCount(list, NOW)).toBe(1)
  })
})

describe('contract: a workflow alert finds its thread', () => {
  it('notify.operator rows name the thread only as the source entity — the card still deep-links', () => {
    const e = mapApiNotification({ id: 'w', domain: 'inbox', severity: 'positive', event_type: 'inbox_needs_call', title: 'Seller waiting on review for 4 hours', created_at: ago(1), source_entity_type: 'seller_thread', source_entity_id: '+16125550101', thread_last_outbound_at: ago(0.5), seller_display_name: 'Sondra E' })
    expect(e.threadKey).toBe('+16125550101')
    expect(e.threadRepliedAt).toBe(ago(0.5))
    expect(e.sellerName).toBe('Sondra E')
    // a campaign row never borrows a source id as a thread
    expect(mapApiNotification({ id: 'c', domain: 'campaigns', severity: 'positive', title: 'x', created_at: ago(1), source_entity_type: 'campaign', source_entity_id: 'c1' }).threadKey).toBeNull()
  })
})
