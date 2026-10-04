import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCompDetailStore, type CompDetailFetcher } from './comp-detail-store'
import type { CompRecord } from './comp-card-model'

const rec = (id: string): CompRecord => ({ comp_id: id, price: 100000 })

function deferredFetcher() {
  const calls: Array<{ id: string; signal: AbortSignal; resolve: (r: CompRecord | null) => void }> = []
  const fetcher: CompDetailFetcher = vi.fn((id, signal) => new Promise<CompRecord | null>((resolve) => { calls.push({ id, signal, resolve }) }))
  return { fetcher, calls }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => { vi.useRealTimers() })

describe('comp click hydration — one keyed request', () => {
  it('a click makes exactly one request for that comp id', async () => {
    const { fetcher, calls } = deferredFetcher()
    const store = createCompDetailStore(fetcher)
    store.request('t:1')
    store.request('t:1') // a re-render / second click while in flight
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(calls[0].id).toBe('t:1')
    calls[0].resolve(rec('t:1'))
    await flush()
    expect(store.get('t:1')).toEqual({ status: 'ready', data: rec('t:1') })
    store.request('t:1') // re-opening a loaded comp costs nothing
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(store.peek('t:1')?.comp_id).toBe('t:1')
  })

  it('a newer click aborts the stale read, and a late stale answer never paints', async () => {
    const { fetcher, calls } = deferredFetcher()
    const store = createCompDetailStore(fetcher)
    store.request('t:1')
    store.request('t:2')
    expect(calls[0].signal.aborted).toBe(true)
    expect(calls[1].signal.aborted).toBe(false)
    calls[0].resolve(rec('t:1'))
    calls[1].resolve(rec('t:2'))
    await flush()
    expect(store.get('t:1').status).toBe('idle')
    expect(store.get('t:2').status).toBe('ready')
  })

  it('closing the card cancels its read; a StrictMode remount reuses it', async () => {
    const { fetcher, calls } = deferredFetcher()
    const store = createCompDetailStore(fetcher)
    const release = store.retain('t:9')
    release()
    const again = store.retain('t:9') // remount in the same tick
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(calls[0].signal.aborted).toBe(false)
    again()
    await flush()
    expect(calls[0].signal.aborted).toBe(true)
  })

  it('a failed read is an error state (never fake data) and a later click retries', async () => {
    const fetcher: CompDetailFetcher = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(rec('t:3'))
    const store = createCompDetailStore(fetcher)
    store.request('t:3')
    await flush()
    expect(store.get('t:3').status).toBe('error')
    store.request('t:3')
    await flush()
    expect(store.get('t:3').status).toBe('ready')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
