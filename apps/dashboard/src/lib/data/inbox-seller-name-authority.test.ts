/**
 * RC 8.4.3 — the Inbox never shows a phone as the seller name when a real
 * name exists.
 *
 * Prod 10-05, thread +18177347618: inbox_thread_state.seller_display_name was
 * "Jose G Deleon", but the list/header/composer resolvers only rejected RAW
 * E.164 as a "poor name". The formatted phone their own fallback produces
 * ("(817) 734-7618") is written back onto the thread as ownerName /
 * prospectName, and on the next resolve it outranked the canonical name. The
 * manual composer then carried it into send_queue as seller_full_name.
 */
import { describe, expect, it } from 'vitest'
import {
  buildQueuePersonalization,
  isPhoneLikeName,
  resolveInboxOwnerNameWithSource,
  resolveInboxProspectNameWithSource,
  resolveInboxSellerNameWithSource,
  type InboxThread,
} from './inboxData'

const JOSE = '+18177347618'

describe('isPhoneLikeName', () => {
  it('rejects formatted, E.164, bare and fragment phones', () => {
    for (const v of ['(817) 734-7618', '+18177347618', '8177347618', '+1 (817) 734-7618', '(817)']) {
      expect(isPhoneLikeName(v), v).toBe(true)
    }
  })
  it('keeps real names', () => {
    for (const v of ['Jose G Deleon', 'José Deleón', 'Abel M Arana Jr.', '2832 Milam LLC', '']) {
      expect(isPhoneLikeName(v), v).toBe(false)
    }
  })
})

describe('thread name resolvers prefer a real name over a phone', () => {
  // The shape of a thread that was normalized once while nameless: the
  // camelCase fields hold the formatted phone fallback.
  const staleThread = {
    threadKey: JOSE,
    canonicalE164: JOSE,
    ownerName: '(817) 734-7618',
    ownerDisplayName: '(817) 734-7618',
    prospectName: '(817) 734-7618',
    sellerName: '(817) 734-7618',
    owner_name: '(817) 734-7618',
    seller_display_name: 'Jose G Deleon',
  }

  it('list row (prospect headline) shows the thread-state name', () => {
    expect(resolveInboxProspectNameWithSource(staleThread)).toEqual({ value: 'Jose G Deleon', source: 'seller_display_name' })
  })
  it('conversation header (owner headline) shows the thread-state name', () => {
    expect(resolveInboxOwnerNameWithSource(staleThread).value).toBe('Jose G Deleon')
  })
  it('legacy seller resolver shows the thread-state name', () => {
    expect(resolveInboxSellerNameWithSource(staleThread).value).toBe('Jose G Deleon')
  })
  it('only falls back to the phone when no name exists anywhere', () => {
    const nameless = { canonicalE164: JOSE, ownerName: '(817) 734-7618', seller_display_name: '(817) 734-7618' }
    expect(resolveInboxProspectNameWithSource(nameless)).toEqual({ value: '+1 (817) 734-7618', source: 'phone_fallback' })
    expect(resolveInboxOwnerNameWithSource(nameless).source).toBe('fallback_phone_fallback')
  })
})

describe('manual send personalization never carries a phone as a name', () => {
  it('drops a phone-shaped ownerName from the queue candidate snapshot', () => {
    const thread = { id: JOSE, threadKey: JOSE, canonicalE164: JOSE, ownerName: '(817) 734-7618', ownerDisplayName: '(817) 734-7618' } as unknown as InboxThread
    const { candidateSnapshot, renderVariables } = buildQueuePersonalization(thread, 'Hi there, quick question.')
    expect(candidateSnapshot.seller_full_name).toBeNull()
    expect(candidateSnapshot.owner_display_name).toBeNull()
    expect(renderVariables.seller_first_name).toBe('')
  })
  it('keeps a real name', () => {
    const thread = { id: JOSE, threadKey: JOSE, ownerName: 'Jose G Deleon', prospect_full_name: 'Jose G Deleon' } as unknown as InboxThread
    expect(buildQueuePersonalization(thread, 'Hi').candidateSnapshot.seller_full_name).toBe('Jose G Deleon')
  })
})
