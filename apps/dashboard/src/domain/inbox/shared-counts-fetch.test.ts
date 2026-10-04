import { describe, expect, it, vi } from 'vitest'
import { createSharedFetch } from './shared-counts-fetch'

describe('one counts read for every Inbox instance', () => {
  it('three instances mounting together → one request', async () => {
    let clock = 0
    const fetcher = vi.fn(async () => ({ ok: true }))
    const read = createSharedFetch(fetcher, { now: () => clock })
    await Promise.all([read(), read(), read()])
    expect(fetcher).toHaveBeenCalledTimes(1)
    clock += 500
    await read()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('a later change still re-reads once the window passed', async () => {
    let clock = 0
    const fetcher = vi.fn(async () => ({ ok: true }))
    const read = createSharedFetch(fetcher, { now: () => clock })
    await read()
    clock += 2000
    await read()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('a pending request is always joined, however long it takes', async () => {
    let clock = 0
    let resolve: (v: unknown) => void = () => undefined
    const fetcher = vi.fn(() => new Promise((r) => { resolve = r }))
    const read = createSharedFetch(fetcher, { now: () => clock })
    const a = read()
    clock += 10_000
    const b = read()
    expect(fetcher).toHaveBeenCalledTimes(1)
    resolve({ ok: true })
    await Promise.all([a, b])
  })
})
