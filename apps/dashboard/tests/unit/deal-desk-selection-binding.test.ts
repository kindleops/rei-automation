import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dealContextMatchesThread,
  mergeSelectedThreadAndDealContext,
  resolveCanonicalWorkspaceContext,
} from '../../src/domain/entity-graph/universal-sync.ts'
import type { InboxWorkflowThread } from '../../src/lib/data/inboxWorkflowData.ts'
import type { DealContext } from '../../src/lib/data/dealContext.ts'
import { buildOptimisticThreadPatch } from '../../src/domain/inbox/optimistic-thread-patch.ts'
import { resolveInboxThreadState } from '../../src/domain/inbox/resolveInboxThreadState.ts'
import { sortThreadsByDecision } from '../../src/domain/inbox/inbox-decisioning.ts'
import { inboxReducer, emptyBucket, EMPTY_INBOX_STORE_STATE } from '../../src/modules/inbox/inbox-store.ts'

const thread = (overrides: Partial<InboxWorkflowThread> & Record<string, unknown> = {}): InboxWorkflowThread => ({
  id: String(overrides.id || overrides.threadKey || 't1'),
  threadKey: String(overrides.threadKey || overrides.id || 't1'),
  ownerName: String(overrides.ownerName || 'Owner A'),
  propertyAddress: String(overrides.propertyAddress || '123 Main St'),
  propertyId: String(overrides.propertyId || 'prop-a'),
  prospectId: overrides.prospectId as string | undefined,
  ownerId: overrides.ownerId as string | undefined,
  canonicalE164: overrides.canonicalE164 as string | undefined,
  isPinned: Boolean(overrides.isPinned),
  isStarred: Boolean(overrides.isStarred),
  isArchived: Boolean(overrides.isArchived),
  isRead: Boolean(overrides.isRead),
  lastMessageAt: String(overrides.lastMessageAt || '2026-07-01T12:00:00.000Z'),
  ...overrides,
} as InboxWorkflowThread)

const dc = (overrides: Record<string, unknown> = {}): DealContext => ({
  id: String(overrides.id || 'dc1'),
  propertyId: overrides.propertyId as string | undefined,
  property_id: overrides.property_id as string | undefined,
  propertyAddress: overrides.propertyAddress as string | undefined,
  ownerName: overrides.ownerName as string | undefined,
  threadKey: overrides.threadKey as string | undefined,
  thread_key: overrides.thread_key as string | undefined,
  ...overrides,
} as DealContext)

test('rejects deal context from a different property', () => {
  const selected = thread({ threadKey: '+15551111111', propertyId: 'prop-a', propertyAddress: '123 Main' })
  const stale = dc({ threadKey: '+15552222222', propertyId: 'prop-b', propertyAddress: '999 Other', ownerName: 'Other Owner' })
  assert.equal(dealContextMatchesThread(selected, stale), false)
})

test('never merges previous-property deal context into selected thread', () => {
  const selected = thread({
    threadKey: '+15551111111',
    propertyId: 'prop-a',
    propertyAddress: '123 Main St',
    ownerName: 'Carlos Negrin',
  })
  const stale = dc({
    threadKey: '+15552222222',
    propertyId: 'prop-b',
    propertyAddress: '999 Other Ave',
    ownerName: 'Stale Owner',
  })
  const merged = mergeSelectedThreadAndDealContext(selected, stale)
  assert.equal(merged.propertyId, 'prop-a')
  assert.ok(String(merged.propertyAddress || '').includes('123 Main'))
  assert.equal(merged.ownerName, 'Carlos Negrin')
  assert.equal(merged.threadKey, '+15551111111')
})

test('resolveCanonicalWorkspaceContext drops mismatched dealContext', () => {
  const selected = thread({ threadKey: 'phone-a', propertyId: 'prop-a', propertyAddress: '1 A St' })
  const stale = dc({ threadKey: 'phone-b', propertyId: 'prop-b', propertyAddress: '2 B St' })
  const resolved = resolveCanonicalWorkspaceContext({
    selected,
    dealContext: stale,
    activeContext: { threadKey: 'phone-a', propertyId: 'prop-a', sourceView: 'inbox' },
  })
  assert.equal(resolved?.propertyId, 'prop-a')
  assert.ok(String(resolved?.propertyAddress || '').includes('1 A'))
})

test('keeps inbound in new_replies after is_read=true', () => {
  const row = thread({
    latestDirection: 'inbound',
    latest_message_direction: 'inbound',
    lastInboundAt: '2026-07-01T12:00:00.000Z',
    lastOutboundAt: '2026-06-30T12:00:00.000Z',
    isRead: true,
    inbox_bucket: 'new_replies',
  } as any)
  const state = resolveInboxThreadState(row)
  assert.equal(state.bucket, 'new_replies')
})

test('mark-read optimistic patch does not rewrite inboxStatus', () => {
  const patch = buildOptimisticThreadPatch('read', thread())
  assert.equal(patch.isRead, true)
  assert.equal((patch as any).inboxStatus, undefined)
})

test('sorts pinned threads above newer unpinned activity', () => {
  const olderPinned = thread({
    id: 'pinned',
    threadKey: 'pinned',
    isPinned: true,
    lastMessageAt: '2026-07-01T10:00:00.000Z',
  })
  const newer = thread({
    id: 'newer',
    threadKey: 'newer',
    isPinned: false,
    lastMessageAt: '2026-07-01T18:00:00.000Z',
  })
  const sorted = sortThreadsByDecision([newer, olderPinned], new Map())
  assert.equal(sorted[0]?.id, 'pinned')
})

test('BUCKET_APPEND_ROWS preserves existing rows and appends fresh ones', () => {
  const start = {
    ...EMPTY_INBOX_STORE_STATE,
    activeBucketKey: 'new_replies',
    buckets: {
      new_replies: {
        ...emptyBucket(),
        lastRequestId: 'req-1',
        rows: [
          { id: 'a', threadKey: 'a', lastMessageAt: '2026-07-01T10:00:00.000Z' },
          { id: 'b', threadKey: 'b', lastMessageAt: '2026-07-01T09:00:00.000Z' },
        ],
      },
    },
  }
  const next = inboxReducer(start, {
    type: 'BUCKET_APPEND_ROWS',
    bucketKey: 'new_replies',
    requestId: 'req-1',
    rows: [
      { id: 'c', threadKey: 'c', lastMessageAt: '2026-07-01T08:00:00.000Z' },
      { id: 'a', threadKey: 'a', lastMessageAt: '2026-07-01T10:00:00.000Z' },
    ],
    cursor: 'cursor-2',
    hasMore: true,
  })
  const rows = next.buckets.new_replies.rows as Array<Record<string, unknown>>
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b', 'c'])
  assert.equal(next.buckets.new_replies.cursor, 'cursor-2')
})

test('does not drop new_replies membership solely because is_read is true', () => {
  const start = {
    ...EMPTY_INBOX_STORE_STATE,
    buckets: {
      new_replies: {
        ...emptyBucket(),
        rows: [{
          id: 'a',
          threadKey: '+15550001111',
          latest_message_direction: 'inbound',
          last_inbound_at: '2026-07-01T12:00:00.000Z',
          last_outbound_at: '2026-06-30T12:00:00.000Z',
          is_read: false,
          inbox_bucket: 'new_replies',
        }],
      },
    },
  }
  const next = inboxReducer(start, {
    type: 'REALTIME_PATCH_THREAD',
    threadKey: '+15550001111',
    patch: { is_read: true, isRead: true },
  })
  const rows = next.buckets.new_replies.rows as Array<Record<string, unknown>>
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.is_read, true)
})
