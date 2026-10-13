import { describe, expect, it } from 'vitest'
import { EMPTY_INBOX_STORE_STATE, emptyBucket, inboxReducer } from './inbox-store'

// 2026-10-13: after Load More, a realtime rejoin re-read page 1 and the list
// collapsed back to 30 rows. A background refresh now refreshes the head and
// keeps every loaded row and the deeper cursor; a deliberate load still replaces.
const row = (n: number) => ({ id: `t${n}`, threadKey: `t${n}`, preview: `p${n}` })
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => row(from + i))
const keys = (rows: unknown[]) => rows.map((r) => (r as { threadKey: string }).threadKey)

const loaded = (rows: unknown[]) => ({
  ...EMPTY_INBOX_STORE_STATE,
  activeBucketKey: 'all',
  buckets: { all: { ...emptyBucket(), rows, cursor: 'deep-cursor', hasMore: true, lastRequestId: 'r2' } },
})

describe('background refresh after Load More', () => {
  it('keeps the loaded pages and the deep cursor; page 1 refreshes the head', () => {
    const state = loaded(range(0, 80))
    const fresh = [row(999), ...range(0, 29)] // one new thread on top, page 1 again
    const next = inboxReducer(state, { type: 'BUCKET_FETCH_DONE', bucketKey: 'all', requestId: 'r2', rows: fresh, cursor: 'page1-cursor', hasMore: true, preserveLoadedTail: true })
    const rows = next.buckets.all.rows
    expect(rows).toHaveLength(81)
    expect(keys(rows)[0]).toBe('t999')
    expect(new Set(keys(rows)).size).toBe(81) // no duplicates
    expect(keys(rows).slice(-1)[0]).toBe('t79') // the last loaded row is still there
    expect(next.buckets.all.cursor).toBe('deep-cursor')
    expect(next.buckets.all.hasMore).toBe(true)
  })

  it('a deliberate load (no preserveLoadedTail) still replaces the list', () => {
    const state = loaded(range(0, 80))
    const next = inboxReducer(state, { type: 'BUCKET_FETCH_DONE', bucketKey: 'all', requestId: 'r2', rows: range(0, 30), cursor: 'page1-cursor', hasMore: true })
    expect(next.buckets.all.rows).toHaveLength(30)
    expect(next.buckets.all.cursor).toBe('page1-cursor')
  })

  it('a background refresh on a list that has only page 1 just refreshes it', () => {
    const state = loaded(range(0, 30))
    const next = inboxReducer(state, { type: 'BUCKET_FETCH_DONE', bucketKey: 'all', requestId: 'r2', rows: [row(999), ...range(0, 29)], cursor: 'page1-cursor', hasMore: true, preserveLoadedTail: true })
    expect(keys(next.buckets.all.rows)[0]).toBe('t999')
    expect(next.buckets.all.rows).toHaveLength(30)
    expect(next.buckets.all.cursor).toBe('page1-cursor')
  })

  it('a stale response still cannot commit', () => {
    const state = loaded(range(0, 80))
    const next = inboxReducer(state, { type: 'BUCKET_FETCH_DONE', bucketKey: 'all', requestId: 'old', rows: range(0, 30), cursor: null, hasMore: false, preserveLoadedTail: true })
    expect(next).toBe(state)
  })
})
