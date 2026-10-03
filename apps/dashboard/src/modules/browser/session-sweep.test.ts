import { beforeEach, describe, expect, it, vi } from 'vitest'

/* Bounded cleanup of orphaned Browser sessions (lc.browser.session.v1:<sid>). */
type Mem = Map<string, string>
const memStore = (m: Mem) => ({ getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) }, clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size } })

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 2, 12)
const doc = (sid: string, used: number) => JSON.stringify({ v: 1, id: sid, activeId: 't1', link: 'linked', subject: null, handled: [], tabs: [{ id: 't1', url: 'https://gis.hennepin.us/property/', createdAt: used, lastActive: used }] })
const keyOf = (sid: string) => `lc.browser.session.v1:${sid}`

let local: Mem
async function load() {
  vi.resetModules()
  Object.assign(globalThis, { window: { localStorage: memStore(local), sessionStorage: memStore(new Map()) } })
  return import('./session-snapshot')
}
const sids = () => [...local.keys()].filter((k) => k.startsWith('lc.browser.session.v1:')).map((k) => k.slice(22)).sort()

beforeEach(() => { local = new Map() })

describe('orphaned Browser session cleanup', () => {
  it('removes orphans unused for more than 7 days; keeps recent orphans and every referenced session', async () => {
    const S = await load()
    local.set(keyOf('oldorphan'), doc('oldorphan', NOW - 8 * DAY))
    local.set(keyOf('neworphan'), doc('neworphan', NOW - 2 * DAY))
    local.set(keyOf('oldsaved1'), doc('oldsaved1', NOW - 90 * DAY))
    local.set('lc.workspaces.v1', '{"saved":[]}')
    const removed = S.sweepSessions(new Set(['oldsaved1']), NOW)
    expect(removed).toEqual(['oldorphan'])
    expect(sids()).toEqual(['neworphan', 'oldsaved1'])
    expect(local.has('lc.workspaces.v1')).toBe(true) // other keys are never touched
  })

  it('caps at 50 sessions, least recently used orphans first, never a referenced one', async () => {
    const S = await load()
    for (let i = 0; i < 60; i++) local.set(keyOf(`orph${String(i).padStart(4, '0')}`), doc('x', NOW - 2 * DAY + i * 60_000))
    // 10 referenced sessions, all older than every orphan: they still stay
    const refs = new Set<string>()
    for (let i = 0; i < 10; i++) { const sid = `saved${i}xx`; refs.add(sid); local.set(keyOf(sid), doc(sid, NOW - 6 * DAY)) }
    const removed = S.sweepSessions(refs, NOW)
    expect(sids().length).toBe(50)
    for (const r of refs) expect(sids()).toContain(r)
    // the 20 oldest orphans went, in LRU order
    expect(removed).toEqual(Array.from({ length: 20 }, (_, i) => `orph${String(i).padStart(4, '0')}`))
  })

  it('the cap never evicts a session used within the last hour (another OS tab may hold it)', async () => {
    const S = await load()
    for (let i = 0; i < 55; i++) local.set(keyOf(`hot${String(i).padStart(4, '0')}`), doc('x', NOW - 10 * 60_000))
    expect(S.sweepSessions(new Set(), NOW)).toEqual([])
    expect(sids().length).toBe(55)
  })

  it('referenced sessions survive even past the age limit and over the cap', async () => {
    const S = await load()
    const refs = new Set<string>()
    for (let i = 0; i < 60; i++) { const sid = `ref${String(i).padStart(4, '0')}`; refs.add(sid); local.set(keyOf(sid), doc(sid, NOW - 30 * DAY)) }
    expect(S.sweepSessions(refs, NOW)).toEqual([])
    expect(sids().length).toBe(60)
  })
})
