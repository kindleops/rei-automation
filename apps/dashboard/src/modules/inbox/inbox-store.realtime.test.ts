import { describe, expect, it } from 'vitest'
import { EMPTY_INBOX_STORE_STATE, emptyBucket, inboxReducer, reconcileFetchedRowsWithRealtime } from './inbox-store'
import { buildThreadStateListPatch } from '../../domain/inbox/inbox-realtime-sync'

const row = (threadKey: string, at: string, extra: Record<string, unknown> = {}) => ({
  id: threadKey, threadKey, canonicalE164: threadKey, latestMessageAt: at, lastMessageIso: at, preview: `old ${threadKey}`, inbox_bucket: 'waiting', ...extra,
})

const keys = (rows: unknown[]) => rows.map((r) => (r as { threadKey: string }).threadKey)

describe('live inbound reaches the top of the list', () => {
  const stateWith = (bucketKey: string, rows: unknown[]) => ({
    ...EMPTY_INBOX_STORE_STATE,
    activeBucketKey: bucketKey,
    buckets: { [bucketKey]: { ...emptyBucket(), rows } },
  })

  it('an inbox_thread_state UPDATE moves the thread to the top with its new preview', () => {
    const state = stateWith('all_messages', [
      row('+16125550001', '2026-10-03T02:00:00Z'),
      row('+16125550002', '2026-10-03T01:00:00Z'),
      row('+16128072000', '2026-10-02T20:00:00Z'),
    ])
    const patch = buildThreadStateListPatch({
      latest_message_at: '2026-10-03T02:37:53.587Z', latest_message_body: 'Test', latest_direction: 'inbound', inbox_bucket: 'new_replies', is_read: false,
    })
    const next = inboxReducer(state, { type: 'REALTIME_PATCH_THREAD', threadKey: '+16128072000', patch, targetBucketKey: 'new_replies', upsert: true })
    const rows = next.buckets.all_messages.rows as Array<Record<string, unknown>>
    expect(keys(rows)[0]).toBe('+16128072000')
    expect(rows[0].preview).toBe('Test')
    expect(rows).toHaveLength(3)
  })
})

describe('reconcileFetchedRowsWithRealtime', () => {
  const live = {
    threadKey: '+16128072000',
    patch: { latestMessageAt: '2026-10-03T02:37:53.795Z', lastMessageIso: '2026-10-03T02:37:53.795Z', preview: 'Test', inbox_bucket: '', conversationThreadId: 'ct:other' },
    upsert: true,
  }

  it('a fetch that read the read model before it caught up cannot undo the live row', () => {
    const fetched = [
      row('+16125550001', '2026-10-03T02:00:00Z'),
      row('+16128072000', '2026-10-02T20:00:00Z', { conversationThreadId: '+16128072000' }),
    ]
    const out = reconcileFetchedRowsWithRealtime(fetched, [live], 'all_messages') as Array<Record<string, unknown>>
    expect(keys(out)).toEqual(['+16128072000', '+16125550001'])
    expect(out[0].preview).toBe('Test')
    // identity and server bucket are never overwritten by the event patch
    expect(out[0].conversationThreadId).toBe('+16128072000')
    expect(out[0].inbox_bucket).toBe('waiting')
  })

  it('once the server has caught up (same or newer), the server row wins', () => {
    const fetched = [row('+16128072000', '2026-10-03T02:37:55Z', { preview: 'server' })]
    expect(reconcileFetchedRowsWithRealtime(fetched, [live], 'all_messages')).toBe(fetched)
  })

  it('re-adds a thread the fetch missed only where it belongs', () => {
    const fetched = [row('+16125550001', '2026-10-03T02:00:00Z')]
    expect(keys(reconcileFetchedRowsWithRealtime(fetched, [live], 'all_messages'))).toEqual(['+16128072000', '+16125550001'])
    expect(reconcileFetchedRowsWithRealtime(fetched, [live], 'dead')).toBe(fetched)
    expect(reconcileFetchedRowsWithRealtime(fetched, [{ ...live, upsert: false }], 'all_messages')).toBe(fetched)
  })

  it('is the identity when there is nothing live', () => {
    const fetched = [row('+16125550001', '2026-10-03T02:00:00Z')]
    expect(reconcileFetchedRowsWithRealtime(fetched, [], 'all_messages')).toBe(fetched)
  })
})
