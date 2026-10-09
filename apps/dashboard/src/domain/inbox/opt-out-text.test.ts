import { describe, expect, it } from 'vitest'
import { containsWord, isOptOutWording, isServerSuppressed } from './opt-out-text'
import { resolveInboxThreadState } from './resolveInboxThreadState'
import { buildConversationDecision } from './inbox-decisioning'
import { isSuppressedThread, getThreadMatchedKeywords } from '../../modules/inbox/inbox-ui-helpers'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'

// P0 2026-10-09: "chriSTOPher" contains "stop". Every Christopher thread was
// shown as suppressed and its composer disabled because the UI re-scanned the
// message text ("Hi Christopher, …") with substring matching.

const OPT_OUT = ['STOP', 'stop.', 'Stop texting me', 'please stop', 'Stop!', 'unsubscribe', 'STOP please', 'NFS. Stop', 'remove me from your list', 'opt out']
const NOT_OPT_OUT = [
  'Christopher', 'This is Christopher', 'Kristopher here', 'Stopher', 'Christophe', 'Hi Christopher, are you still the owner of 12 Oak St?',
  'non-stop', 'bus stop near the house', 'weekend works', 'Paramount', 'Endicott', 'I removed the tenant', 'stop by anytime',
]

describe('isOptOutWording (whole words, server classifier semantics)', () => {
  for (const text of OPT_OUT) it(`opt-out: ${JSON.stringify(text)}`, () => expect(isOptOutWording(text)).toBe(true))
  for (const text of NOT_OPT_OUT) it(`not opt-out: ${JSON.stringify(text)}`, () => expect(isOptOutWording(text)).toBe(false))
})

describe('containsWord', () => {
  it('never matches inside a word', () => {
    expect(containsWord('Christopher', 'stop')).toBe(false)
    expect(containsWord('weekend', 'end')).toBe(false)
    expect(containsWord('Paramount', 'para')).toBe(false)
    expect(containsWord('please stop', 'stop')).toBe(true)
    expect(containsWord('wrong   number', 'wrong number')).toBe(true)
  })
})

const thread = (over: Record<string, unknown>): InboxWorkflowThread => ({
  id: 't1',
  threadKey: 't1',
  ownerName: 'Christopher Stopher',
  sellerName: 'Kristopher Stopher',
  propertyAddress: '1 Stopford Ln',
  lastMessageBody: 'Hi Christopher, are you still the owner of 1 Stopford Ln?',
  preview: 'Hi Christopher, are you still the owner of 1 Stopford Ln?',
  conversationStage: 'ownership_check',
  inboxStatus: 'waiting',
  labels: [],
  isOptOut: false,
  isSuppressed: false,
  ...over,
} as unknown as InboxWorkflowThread)

describe('UI suppression reads server state only', () => {
  it('a Christopher thread with no server suppression is not suppressed anywhere', () => {
    const t = thread({})
    expect(isSuppressedThread(t)).toBe(false)
    expect(isServerSuppressed(t as unknown as Record<string, unknown>)).toBe(false)
    expect(resolveInboxThreadState(t).flags.is_suppressed).toBe(false)
    expect(resolveInboxThreadState(t).bucket).not.toBe('suppressed')
    expect(buildConversationDecision(t).suppression_status).toBe('clear')
  })

  it('an inbound "This is Christopher" is not suppressed', () => {
    const t = thread({ lastMessageBody: 'This is Christopher', preview: 'This is Christopher', direction: 'inbound' })
    expect(isSuppressedThread(t)).toBe(false)
    expect(resolveInboxThreadState(t).bucket).not.toBe('suppressed')
    expect(buildConversationDecision(t).suppression_status).toBe('clear')
  })

  it('server suppression still suppresses (flag, bucket, opt-out)', () => {
    expect(isSuppressedThread(thread({ isSuppressed: true }))).toBe(true)
    expect(isSuppressedThread(thread({ isOptOut: true }))).toBe(true)
    expect(isSuppressedThread(thread({ priorityBucket: 'suppressed' }))).toBe(true)
    expect(isSuppressedThread(thread({ inboxStatus: 'suppressed' }))).toBe(true)
    expect(resolveInboxThreadState(thread({ is_suppressed: true })).bucket).toBe('suppressed')
    expect(buildConversationDecision(thread({ is_suppressed: true })).suppression_status).toBe('suppressed')
  })

  it('keyword chips never read names/addresses as keywords', () => {
    expect(getThreadMatchedKeywords(thread({}))).not.toContain('stop')
    expect(getThreadMatchedKeywords(thread({ lastMessageBody: 'please stop', preview: 'please stop' }))).toContain('stop')
  })
})
