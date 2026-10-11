import { describe, expect, it, vi } from 'vitest'

vi.mock('../../app/router', () => ({ pushRoutePath: vi.fn() }))
vi.mock('../mobile/mobile-inbox-bridge', () => ({ openInboxThread: vi.fn() }))

import { pushRoutePath } from '../../app/router'
import { openInboxThread } from '../mobile/mobile-inbox-bridge'
import type { NotificationEvent } from '../../domain/notifications/notification-contract'
import { inboxThreadHref, openNotificationDestination, resolveNotificationDestination } from './notification-destination'

const ev = (over: Partial<NotificationEvent>): NotificationEvent => ({
  id: 'n', domain: 'inbox', severity: 'positive', type: 'inbox_hot_lead', title: 't', body: '', status: 'unread', soundCategory: 'seller-reply', createdAt: '2026-10-10T00:00:00Z', actions: [], ...over,
})

describe('notification destination — the exact object, with context', () => {
  it('a seller conversation → that thread (and its property)', () => {
    expect(resolveNotificationDestination(ev({ threadKey: '+16125550101', propertyId: 'p1' }))).toBe('/inbox?thread=%2B16125550101&thread_property=p1')
    expect(inboxThreadHref('+1612')).toBe('/inbox?thread=%2B1612')
  })
  it('property / campaign / closing case', () => {
    expect(resolveNotificationDestination(ev({ domain: 'acquisition', propertyId: 'p9' }))).toBe('/deal-intelligence?property_id=p9')
    expect(resolveNotificationDestination(ev({ domain: 'campaigns', campaignId: 'c1' }))).toBe('/campaign-command?campaign=c1')
    expect(resolveNotificationDestination(ev({ domain: 'closing', contractId: 'k1' }))).toBe('/closing-desk?case=k1')
  })
  it('an explicit server href wins', () => {
    expect(resolveNotificationDestination(ev({ threadKey: 't', actions: [{ type: 'navigate', label: 'Go', href: '/pipeline?opp=o1', primary: true }] }))).toBe('/pipeline?opp=o1')
  })
  it('opening a seller alert goes through the Inbox deep-link path (exact thread + property)', () => {
    expect(openNotificationDestination(ev({ threadKey: '+16125550101', propertyId: 'p1' }))).toBe(true)
    expect(openInboxThread).toHaveBeenCalledWith({ threadKey: '+16125550101', propertyId: 'p1' })
    expect(openNotificationDestination(ev({ domain: 'campaigns', campaignId: 'c1' }))).toBe(true)
    expect(pushRoutePath).toHaveBeenCalledWith('/campaign-command?campaign=c1')
    expect(openNotificationDestination(ev({ domain: 'platform' }))).toBe(false)
  })
})
