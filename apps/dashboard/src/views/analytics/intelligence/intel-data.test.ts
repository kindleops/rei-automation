import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[] = []
let resolveAll: Array<() => void> = []
vi.mock('../../../lib/api/backendClient', () => ({
  callBackend: (path: string) => {
    calls.push(path)
    return new Promise((resolve) => {
      resolveAll.push(() => resolve({ ok: true, data: { ok: true, data: { path } } }))
    })
  },
}))

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('the Lab query store', () => {
  beforeEach(() => { calls.length = 0; resolveAll = [] })

  it('two sections asking the same question make ONE request', async () => {
    const { intelStore } = await import('./intel-data')
    const a = intelStore.subscribe('/q/one', () => {})
    const b = intelStore.subscribe('/q/one', () => {})
    intelStore.ensure('/q/one')
    intelStore.ensure('/q/one')
    expect(calls).toEqual(['/q/one'])
    resolveAll.forEach((r) => r())
    await flush(); await flush()
    expect(intelStore.read('/q/one').data).toEqual({ path: '/q/one' })
    // a fresh answer is reused, not re-read
    intelStore.ensure('/q/one')
    expect(calls).toEqual(['/q/one'])
    a(); b()
  })

  it('never runs more than four reads at once; the rest wait their turn', async () => {
    const { intelStore } = await import('./intel-data')
    const unsub = ['/q/a', '/q/b', '/q/c', '/q/d', '/q/e', '/q/f'].map((p) => { const u = intelStore.subscribe(p, () => {}); intelStore.ensure(p); return u })
    expect(calls).toHaveLength(4)
    resolveAll.splice(0, 2).forEach((r) => r())
    await flush(); await flush()
    expect(calls).toHaveLength(6)
    resolveAll.forEach((r) => r())
    await flush()
    unsub.forEach((u) => u())
  })

  it('stable JSON paths: the same context in another key order is the same request', async () => {
    const { paths } = await import('./intel-data')
    expect(paths.query({ b: 1, a: { y: 2, x: 1 } }, 'series')).toBe(paths.query({ a: { x: 1, y: 2 }, b: 1 }, 'series'))
  })
})
