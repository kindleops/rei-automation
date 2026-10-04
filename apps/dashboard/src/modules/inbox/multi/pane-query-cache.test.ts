import { describe, expect, it, vi } from 'vitest'
import { createPaneQueryCache, paneKeyOf, type PaneFetchKey, type PageResult } from './pane-query-cache'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'

const row = (key: string) => ({ id: key, threadKey: key }) as unknown as InboxWorkflowThread
const page = (keys: string[], nextCursor: string | null = null): PageResult => ({ threads: keys.map(row), nextCursor, hasMore: Boolean(nextCursor), total: keys.length })
const q = (filter: string, text = ''): PaneFetchKey => ({ filter, q: text, advanced: '' })

function harness(impl?: (key: PaneFetchKey, cursor: string | null) => PageResult) {
  const calls: Array<{ key: string; cursor: string | null }> = []
  let resolveAll: Array<() => void> = []
  const fetchPage = vi.fn((key: PaneFetchKey, cursor: string | null) => new Promise<PageResult>((resolve) => {
    calls.push({ key: paneKeyOf(key), cursor })
    resolveAll.push(() => resolve(impl ? impl(key, cursor) : page([`${key.filter}-1`, `${key.filter}-2`])))
  }))
  let clock = 1_000_000
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let nextId = 1
  const cache = createPaneQueryCache({
    fetchPage,
    now: () => clock,
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ at: clock + ms, fn, id }); return id },
    clearTimer: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1) },
    safetyMs: 60_000,
  })
  const flush = async () => { const r = resolveAll; resolveAll = []; r.forEach((f) => f()); await Promise.resolve(); await new Promise((r2) => setTimeout(r2, 0)) }
  const advance = async (ms: number) => {
    clock += ms
    for (const t of [...timers].filter((x) => x.at <= clock)) { timers.splice(timers.indexOf(t), 1); t.fn() }
    await Promise.resolve()
  }
  return { cache, calls, flush, advance, fetchPage }
}

describe('pane query cache — no linear N× load', () => {
  it('measured: 1/2/3/4 panes on distinct buckets = one request each; identical panes merge', async () => {
    const measure = async (queries: PaneFetchKey[]) => {
      const h = harness()
      queries.forEach((k) => { h.cache.retain(k); void h.cache.ensure(k) })
      await h.flush()
      return h.calls.length
    }
    expect(await measure([q('new_replies')])).toBe(1)
    expect(await measure([q('new_replies'), q('needs_review')])).toBe(2)
    expect(await measure([q('new_replies'), q('needs_review'), q('follow_up')])).toBe(3)
    // four panes, two asking the same question → three requests, not four
    expect(await measure([q('new_replies'), q('needs_review'), q('follow_up'), q('new_replies')])).toBe(3)
    // four identical panes → one request
    expect(await measure([q('priority'), q('priority'), q('priority'), q('priority')])).toBe(1)
  })

  it('at most two page reads run at once; the rest queue', async () => {
    const h = harness()
    ;['a', 'b', 'c', 'd'].forEach((f) => { void h.cache.ensure(q(f)) })
    await Promise.resolve()
    expect(h.calls.length).toBe(2)
    await h.flush()
    await h.flush()
    expect(h.calls.length).toBe(4)
    expect(h.cache.stats().peakInFlight).toBe(2)
  })

  it('a fresh entry is served from cache', async () => {
    const h = harness()
    void h.cache.ensure(q('priority'))
    await h.flush()
    expect(h.cache.ensure(q('priority'))).toBeNull()
    expect(h.calls.length).toBe(1)
    expect(h.cache.stats().cacheHits).toBe(1)
  })

  it('a realtime burst becomes ONE trailing re-read of mounted queries', async () => {
    const h = harness()
    const release = h.cache.retain(q('priority'))
    void h.cache.ensure(q('priority'))
    await h.flush()
    for (let i = 0; i < 25; i += 1) h.cache.invalidateSoon('realtime')
    await h.advance(10_000)
    await h.flush()
    expect(h.calls.length).toBe(2)
    release()
    for (let i = 0; i < 5; i += 1) h.cache.invalidateSoon('realtime')
    await h.advance(20_000)
    expect(h.calls.length).toBe(2) // unmounted queries are not re-read
  })

  it('archived in one pane → gone from every entry at once', async () => {
    const h = harness((key) => page(key.filter === 'priority' ? ['+16125550001', '+16125550002'] : ['+16125550002', '+16125550003']))
    void h.cache.ensure(q('priority'))
    void h.cache.ensure(q('new_replies'))
    await h.flush()
    h.cache.removeThreads(['16125550002'])
    expect(h.cache.get(paneKeyOf(q('priority'))).rows.map((r) => r.threadKey)).toEqual(['+16125550001'])
    expect(h.cache.get(paneKeyOf(q('new_replies'))).rows.map((r) => r.threadKey)).toEqual(['+16125550003'])
  })

  it('load more appends without duplicates and stops without a cursor', async () => {
    const h = harness((_key, cursor) => (cursor ? page(['r2', 'r3']) : page(['r1', 'r2'], 'c'.repeat(30))))
    void h.cache.ensure(q('all'))
    await h.flush()
    void h.cache.loadMore(q('all'))
    await h.flush()
    expect(h.cache.get(paneKeyOf(q('all'))).rows.map((r) => r.threadKey)).toEqual(['r1', 'r2', 'r3'])
    expect(h.cache.loadMore(q('all'))).toBeNull()
  })

  it('a failed refresh keeps the rows and says so (no false empty)', async () => {
    let fail = false
    const cache = createPaneQueryCache({ fetchPage: async () => { if (fail) throw new Error('timeout'); return page(['a']) }, ttlMs: 0 })
    await cache.ensure(q('priority'))
    fail = true
    await cache.ensure(q('priority'))
    const entry = cache.get(paneKeyOf(q('priority')))
    expect(entry.rows).toHaveLength(1)
    expect(entry.status).toBe('ready')
    expect(entry.error).toBe('timeout')
  })

  it('snapshots are referentially stable until something changes', () => {
    const h = harness()
    expect(h.cache.get('nothing')).toBe(h.cache.get('nothing'))
  })
})
