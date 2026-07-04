import { describe, expect, it } from 'vitest'
import type { InboxThread } from '../../src/domain/inbox/inbox-model-types'
import type { ThreadContext } from '../../src/lib/data/inboxData'
import { buildTemplateContextFromThread } from '../../src/lib/data/templateData'

const baseThread = {
  id: 'property:prop-1',
  leadId: 'owner-1',
  marketId: 'memphis',
  ownerName: 'West 7th Apartments LLC',
  sellerName: 'West 7th Apartments LLC',
  subject: '2246 7th St W, Bradenton, FL',
  preview: '',
  status: 'read',
  priority: 'normal',
  sentiment: 'neutral',
  messageCount: 0,
  lastMessageLabel: '',
  lastMessageIso: new Date().toISOString(),
  unreadCount: 0,
  aiDraft: null,
  labels: [],
  ownerDisplayName: 'West 7th Apartments LLC',
  owner_display_name: 'West 7th Apartments LLC',
  seller_name: 'West 7th Apartments LLC',
} as unknown as InboxThread

describe('buildTemplateContextFromThread identity guard (launch blocker: Master Owner as SMS recipient)', () => {
  it('never resolves seller_first_name/seller_name from the Master Owner entity name', () => {
    const context = buildTemplateContextFromThread(baseThread, null)
    expect(context.seller_first_name).toBe('')
    expect(context.seller_name).toBe('')
    // owner_name is still available for ownership-context copy, just not as the greeting name.
    expect(context.owner_name).toBe('West 7th Apartments LLC')
  })

  it('resolves seller_first_name/seller_name from the linked prospect when present', () => {
    const thread = {
      ...baseThread,
      prospect_full_name: 'Maria Lopez',
    } as unknown as InboxThread
    const context = buildTemplateContextFromThread(thread, null)
    expect(context.seller_first_name).toBe('Maria')
    expect(context.seller_name).toBe('Maria Lopez')
  })

  it('never resolves a first name from a household/individual owner string without a resolved prospect', () => {
    const thread = {
      ...baseThread,
      ownerName: 'Jose A Valdizon & Rocio Mendoza',
      owner_display_name: 'Jose A Valdizon & Rocio Mendoza',
    } as unknown as InboxThread
    const context = buildTemplateContextFromThread(thread, null)
    expect(context.seller_first_name).toBe('')
    expect(context.seller_name).toBe('')
  })

  it('threadContext.seller.name (Master Owner label) never wins over an unresolved prospect', () => {
    const context = buildTemplateContextFromThread(baseThread, {
      seller: { id: 'owner-1', name: 'West 7th Apartments LLC', market: 'memphis' },
      property: null,
      phone: null,
      contactStack: [],
      dealContext: { stage: 'unknown', nextAction: '' },
      aiContext: null,
      queueContext: null,
    } as unknown as ThreadContext)
    expect(context.seller_first_name).toBe('')
  })
})
