import { describe, expect, it, vi } from 'vitest'
import {
  INBOX_REALTIME_PUBLISHED_TABLES,
  buildThreadStateListPatch,
  createRealtimeOverlayStore,
  createRealtimeResubscribeTrigger,
  isDeadChannelStatus,
  realtimeRetryDelayMs,
} from './inbox-realtime-sync'

const fakeTarget = (extra: Record<string, unknown> = {}) => {
  const listeners = new Map<string, Set<() => void>>()
  return {
    ...extra,
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener: (type: string, fn: () => void) => { listeners.get(type)?.delete(fn) },
    fire: (type: string) => { listeners.get(type)?.forEach((fn) => fn()) },
    count: (type: string) => listeners.get(type)?.size ?? 0,
  }
}

describe('buildThreadStateListPatch', () => {
  it('moves the row: latest message, preview, direction, bucket, unread', () => {
    // Shape of the prod inbox_thread_state row after the 02:37:53 inbound.
    const patch = buildThreadStateListPatch({
      thread_key: '+16128072000',
      latest_message_at: '2026-10-03T02:37:53.587+00:00',
      latest_message_body: 'Test',
      latest_direction: 'inbound',
      inbox_bucket: 'new_replies',
      is_read: false,
    })
    expect(patch.latestMessageAt).toBe('2026-10-03T02:37:53.587+00:00')
    expect(patch.lastMessageIso).toBe('2026-10-03T02:37:53.587+00:00')
    expect(patch.preview).toBe('Test')
    expect(patch.latestDirection).toBe('inbound')
    expect(patch.inbox_bucket).toBe('new_replies')
    expect(patch.unreadCount).toBe(1)
    expect(patch.deliveryStatus).toBe('')
  })

  it('never blanks fields a partial UPDATE did not carry', () => {
    const patch = buildThreadStateListPatch({ is_starred: true, inbox_bucket: null, latest_message_body: '' })
    expect(patch).not.toHaveProperty('inbox_bucket')
    expect(patch).not.toHaveProperty('preview')
    expect(patch).not.toHaveProperty('latestMessageAt')
  })

  it('marks read when the operator read it', () => {
    expect(buildThreadStateListPatch({ is_read: true }).unreadCount).toBe(0)
  })
})

describe('createRealtimeOverlayStore', () => {
  it('canonical thread state replaces the event-derived overlay; others merge', () => {
    const store = createRealtimeOverlayStore({ now: () => 1_000 })
    store.record({ threadKey: 'a', patch: { preview: 'x', unreadCount: 1 }, upsert: true })
    store.record({ threadKey: 'a', patch: { latestMessageAt: 't' }, upsert: false })
    expect(store.list()[0]).toEqual({ threadKey: 'a', patch: { preview: 'x', unreadCount: 1, latestMessageAt: 't' }, upsert: true })
    store.record({ threadKey: 'a', patch: { preview: 'y' }, upsert: false, canonical: true })
    expect(store.list()[0]).toEqual({ threadKey: 'a', patch: { preview: 'y' }, upsert: false })
  })

  it('expires after the TTL', () => {
    let t = 0
    const store = createRealtimeOverlayStore({ ttlMs: 100, now: () => t })
    store.record({ threadKey: 'a', patch: {}, upsert: false })
    t = 50
    expect(store.list()).toHaveLength(1)
    t = 151
    expect(store.list()).toHaveLength(0)
  })
})

describe('createRealtimeResubscribeTrigger', () => {
  it('re-subscribes on page return after a real absence, on online, and on token refresh', () => {
    let t = 0
    const doc = fakeTarget({ hidden: false }) as ReturnType<typeof fakeTarget> & { hidden: boolean }
    const win = fakeTarget()
    let authListener: ((event: string) => void) | null = null
    const unsubscribeAuth = vi.fn()
    const onResubscribe = vi.fn()
    const stop = createRealtimeResubscribeTrigger({
      doc, win, now: () => t, minHiddenMs: 15_000, onResubscribe,
      subscribeAuth: (listener) => { authListener = listener; return unsubscribeAuth },
    })

    doc.hidden = true; doc.fire('visibilitychange')
    t = 2_000
    doc.hidden = false; doc.fire('visibilitychange')
    expect(onResubscribe).not.toHaveBeenCalled() // alt-tab flicker

    doc.hidden = true; doc.fire('visibilitychange')
    t = 2_000 + 20 * 60_000 // laptop lid closed across a token expiry
    doc.hidden = false; doc.fire('visibilitychange')
    expect(onResubscribe).toHaveBeenLastCalledWith('visible')

    win.fire('online')
    expect(onResubscribe).toHaveBeenLastCalledWith('online')

    authListener!('TOKEN_REFRESHED')
    expect(onResubscribe).toHaveBeenLastCalledWith('token_refreshed')
    authListener!('USER_UPDATED')
    expect(onResubscribe).toHaveBeenCalledTimes(3)

    stop()
    expect(doc.count('visibilitychange')).toBe(0)
    expect(win.count('online')).toBe(0)
    expect(unsubscribeAuth).toHaveBeenCalled()
  })
})

describe('channel retry policy', () => {
  it('backs off 2s -> 30s cap and treats error/timeout/closed as dead', () => {
    expect([0, 1, 2, 3, 4, 9].map(realtimeRetryDelayMs)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
    expect(isDeadChannelStatus('CHANNEL_ERROR')).toBe(true)
    expect(isDeadChannelStatus('TIMED_OUT')).toBe(true)
    expect(isDeadChannelStatus('CLOSED')).toBe(true)
    expect(isDeadChannelStatus('SUBSCRIBED')).toBe(false)
  })

  it('binds only tables in the supabase_realtime publication', () => {
    expect([...INBOX_REALTIME_PUBLISHED_TABLES].sort()).toEqual(['inbox_thread_state', 'message_events', 'send_queue'])
  })
})
