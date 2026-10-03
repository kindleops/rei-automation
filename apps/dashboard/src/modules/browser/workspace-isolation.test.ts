import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * Browser state is owned by ONE workspace instance: saved workspaces never
 * cross-write, duplicates are independent copies, restore forks, reload keeps
 * the live tabs, and legacy saved layouts that shared a session are split.
 * Runs the real workspace store + session store over an in-memory window.
 */

type Mem = Map<string, string>
const memStore = (m: Mem) => ({ getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) }, clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size } })

function installWindow(path: string, local: Mem, session: Mem) {
  const [pathname, search = ''] = path.split('?')
  const loc = { pathname, search: search ? `?${search}` : '', origin: 'http://x' }
  const handlers = new Map<string, Set<(e: Event) => void>>()
  const go = (url: string) => { const u = new URL(url, 'http://x'); loc.pathname = u.pathname; loc.search = u.search }
  const w = {
    location: loc,
    history: { state: null as unknown, replaceState: (_s: unknown, _t: string, url: string) => go(url), pushState: (_s: unknown, _t: string, url: string) => go(url) },
    sessionStorage: memStore(session),
    localStorage: memStore(local),
    innerWidth: 1600, innerHeight: 1000, screen: { width: 1600, height: 1000 },
    matchMedia: () => ({ matches: false }),
    addEventListener: (type: string, fn: (e: Event) => void) => { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type)!.add(fn) },
    removeEventListener: (type: string, fn: (e: Event) => void) => { handlers.get(type)?.delete(fn) },
    dispatchEvent: (e: Event) => { handlers.get(e.type)?.forEach((fn) => fn(e)); return true },
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id),
  }
  Object.assign(globalThis, { window: w, sessionStorage: w.sessionStorage, localStorage: w.localStorage })
  class PopStateEvent { type: string; constructor(type: string) { this.type = type } }
  class CustomEvent<T> { type: string; detail: T; constructor(type: string, init?: { detail: T }) { this.type = type; this.detail = init?.detail as T } }
  Object.assign(globalThis, { PopStateEvent, CustomEvent })
  return w
}

async function boot(path: string, local: Mem, session: Mem) {
  vi.resetModules()
  installWindow(path, local, session)
  const store = await import('../desktop/workspace/workspace-store')
  const sessions = await import('./session-store')
  const M = await import('./session-model')
  store.__workspaceTest.reset()
  const stop = store.startWorkspace()
  return { store, sessions, M, stop }
}

type Booted = Awaited<ReturnType<typeof boot>>
const sidOf = (path: string) => new URLSearchParams(path.split('?')[1] ?? '').get('s')
const browserPath = (b: Booted, layout = b.store.getWorkspace().layout) => Object.values(layout.instances).find((i) => i.app === 'browser')!.path
const savedBrowserSid = (b: Booted, name: string) => sidOf(browserPath(b, b.store.getWorkspace().saved.find((w) => w.name === name)!.layout))!
/** Open real tabs in a session (what the Browser does when the operator researches). */
function research(b: Booted, sid: string, urls: string[]) {
  b.sessions.updateSession(sid, ({ s, h }) => {
    let cur = { s, h }
    for (const url of urls) { const r = b.M.openTab(cur.s, cur.h, { url, title: url }, Date.now()); cur = { s: r.s, h: r.h } }
    return cur
  })
}
/** Tab URLs as stored for a sid (what a restore would read). */
const storedTabs = (local: Mem, sid: string) => {
  const raw = local.get(`lc.browser.session.v1:${sid}`)
  return raw ? (JSON.parse(raw).tabs as Array<{ url: string | null }>).map((t) => t.url).filter(Boolean) : []
}
/** Tabs as the Browser would show them for a sid (store first, so unflushed writes count). */
const liveTabs = (b: Booted, sid: string) => b.sessions.getSession(sid).s.tabs.map((t) => t.url).filter(Boolean)

const HENNEPIN = ['https://www16.co.hennepin.mn.us/pins/pidresult.jsp?pid=0402924430175', 'https://www16.co.hennepin.mn.us/taxpayments/taxesdue.jsp?pid=0402924430175', 'https://gis.hennepin.us/property/']
const DALLAS = ['https://www.dallascad.org/SearchAddr.aspx', 'https://dallas.tx.publicsearch.us/', 'https://www.dallasact.com/']

describe('Browser state is owned by its workspace', () => {
  let local: Mem
  let session: Mem
  beforeEach(() => { vi.useRealTimers(); local = new Map(); session = new Map() })

  it('two saved workspaces never cross-write', async () => {
    const b = await boot('/browser?s=live0001', local, session)
    research(b, 'live0001', HENNEPIN)
    b.store.saveWorkspace('Underwrite Emerson')
    const emerson = savedBrowserSid(b, 'Underwrite Emerson')
    expect(emerson).not.toBe('live0001')
    expect(storedTabs(local, emerson)).toEqual(HENNEPIN)

    // keep browsing in the live workspace: the saved snapshot does not move
    b.sessions.updateSession('live0001', ({ s, h }) => { let cur = { s, h }; for (const t of s.tabs) cur = b.M.closeTab(cur.s, cur.h, t.id, Date.now()); return cur })
    research(b, 'live0001', DALLAS)
    b.store.saveWorkspace('Dallas Acquisition')
    const dallas = savedBrowserSid(b, 'Dallas Acquisition')
    expect(new Set([emerson, dallas, 'live0001']).size).toBe(3)
    expect(storedTabs(local, emerson)).toEqual(HENNEPIN)
    expect(storedTabs(local, dallas)).toEqual(DALLAS)

    // restore Emerson: a FORK — working in it never rewrites the saved snapshot or Dallas
    const emersonId = b.store.getWorkspace().saved.find((w) => w.name === 'Underwrite Emerson')!.id
    b.store.switchWorkspace(emersonId)
    const forked = sidOf(browserPath(b))!
    expect([emerson, dallas]).not.toContain(forked)
    expect(liveTabs(b, forked)).toEqual(HENNEPIN)
    research(b, forked, ['https://maps.dcad.org/prd/dpm/'])
    b.store.saveWorkspace() // saving again updates Emerson only
    const emerson2 = savedBrowserSid(b, 'Underwrite Emerson')
    expect(storedTabs(local, emerson2)).toEqual([...HENNEPIN, 'https://maps.dcad.org/prd/dpm/'])
    expect(storedTabs(local, dallas)).toEqual(DALLAS)
    // the replaced snapshot is released
    expect(local.has(`lc.browser.session.v1:${emerson}`)).toBe(false)
    b.stop()
  })

  it('duplicate makes an independent copy', async () => {
    const b = await boot('/browser?s=live0002', local, session)
    research(b, 'live0002', DALLAS)
    const original = b.store.saveWorkspace('Dallas Acquisition')
    b.store.duplicateWorkspace(original.id)
    const orig = savedBrowserSid(b, 'Dallas Acquisition')
    const copy = savedBrowserSid(b, 'Dallas Acquisition copy')
    expect(copy).not.toBe(orig)
    expect(storedTabs(local, copy)).toEqual(DALLAS)
    // change the copy (restore it, browse, save): the original is untouched
    b.store.switchWorkspace(b.store.getWorkspace().saved.find((w) => w.name === 'Dallas Acquisition copy')!.id)
    research(b, sidOf(browserPath(b))!, ['https://tarrant.prodigycad.com/'])
    b.store.saveWorkspace()
    expect(storedTabs(local, orig)).toEqual(DALLAS)
    expect(storedTabs(local, savedBrowserSid(b, 'Dallas Acquisition copy'))).toEqual([...DALLAS, 'https://tarrant.prodigycad.com/'])
    // deleting the copy releases only the copy's state
    b.store.deleteWorkspace(b.store.getWorkspace().saved.find((w) => w.name === 'Dallas Acquisition copy')!.id)
    expect(storedTabs(local, orig)).toEqual(DALLAS)
    b.stop()
  })

  it('restore after reload works (live tabs and saved snapshots both come back)', async () => {
    let b = await boot('/browser?s=live0003', local, session)
    research(b, 'live0003', HENNEPIN)
    b.store.saveWorkspace('Underwrite Emerson')
    research(b, 'live0003', ['https://gisweb.miamidade.gov/'])
    await new Promise((r) => setTimeout(r, 450)) // the session store's write-behind
    b.store.__workspaceTest.flush()
    b.stop()

    b = await boot('/browser?s=live0003', local, session)
    expect(sidOf(browserPath(b))).toBe('live0003')
    expect(liveTabs(b, 'live0003')).toEqual([...HENNEPIN, 'https://gisweb.miamidade.gov/'])
    expect(storedTabs(local, savedBrowserSid(b, 'Underwrite Emerson'))).toEqual(HENNEPIN)
    b.stop()
  })

  it('Browser panes in different workspaces stay isolated; separate sessions never share tabs', async () => {
    const b = await boot('/browser?s=paneaaaa', local, session)
    research(b, 'paneaaaa', HENNEPIN)
    research(b, 'panebbbb', DALLAS)
    expect(liveTabs(b, 'paneaaaa')).toEqual(HENNEPIN)
    expect(liveTabs(b, 'panebbbb')).toEqual(DALLAS)
    const a = b.store.saveWorkspace('A')
    b.store.newWorkspaceFrom({ name: 'B', paths: ['/browser?s=panebbbb', '/map'], arrangement: 'row' })
    b.store.saveWorkspace('B')
    b.store.switchWorkspace(a.id)
    research(b, sidOf(browserPath(b))!, ['https://hcpa.example/'])
    expect(storedTabs(local, savedBrowserSid(b, 'B'))).toEqual(DALLAS)
    expect(storedTabs(local, savedBrowserSid(b, 'A'))).toEqual(HENNEPIN)
    b.stop()
  })

  it('migrates legacy saved workspaces that shared one ?s= session (each gets its own copy, nothing lost)', async () => {
    local.set('lc.browser.session.v1:legacy01', JSON.stringify({ v: 1, id: 'legacy01', activeId: 't1', link: 'linked', subject: null, handled: [], tabs: [{ id: 't1', url: HENNEPIN[0], title: 'PINS', createdAt: 1, lastActive: 1 }] }))
    const layout = (id: string) => ({ root: { kind: 'pane', id: `p${id}`, tabs: [`i${id}`], active: `i${id}` }, instances: { [`i${id}`]: { id: `i${id}`, app: 'browser', path: '/browser?s=legacy01', pinned: false } }, focus: `p${id}`, primary: `i${id}`, maximized: null })
    local.set('lc.workspaces.v1', JSON.stringify({ saved: [{ id: 'w1', name: 'One', layout: layout('1'), linked: true, savedAt: 1 }, { id: 'w2', name: 'Two', layout: layout('2'), linked: true, savedAt: 2 }] }))
    const b = await boot('/inbox', local, session)
    const one = savedBrowserSid(b, 'One')
    const two = savedBrowserSid(b, 'Two')
    expect(one).not.toBe(two)
    expect(storedTabs(local, one)).toEqual([HENNEPIN[0]])
    expect(storedTabs(local, two)).toEqual([HENNEPIN[0]])
    // written back: a second boot does not split again
    const again = JSON.parse(local.get('lc.workspaces.v1')!).saved.map((w: { layout: { instances: Record<string, { path: string }> } }) => sidOf(Object.values(w.layout.instances)[0].path))
    expect(again).toEqual([one, two])
    b.stop()
  })
})
