import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { instanceBodyKey } from './instance-key'

const here = dirname(fileURLToPath(import.meta.url))

/* the same small window the store tests use */
function installWindow(path: string) {
  const [pathname, search = ''] = path.split('?')
  const loc = { pathname, search: search ? `?${search}` : '' }
  const handlers = new Map<string, Set<(e: Event) => void>>()
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) }, clear: () => m.clear() } }
  const go = (url: string) => { const u = new URL(url, 'http://x'); loc.pathname = u.pathname; loc.search = u.search }
  const w = {
    location: loc,
    history: { state: null as unknown, replaceState: (_s: unknown, _t: string, url: string) => go(url), pushState: (_s: unknown, _t: string, url: string) => go(url) },
    sessionStorage: mem(), localStorage: mem(),
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
}

describe('one app, one mount (symptom 1: Inbox → rail Map showed the conversation)', () => {
  beforeEach(() => { vi.useRealTimers() })

  it('the Inbox primary navigating to the Map keeps its instance id but changes the body key', async () => {
    vi.resetModules()
    installWindow('/inbox')
    const store = await import('./workspace-store')
    const router = await import('../../../app/router')
    store.__workspaceTest.reset()
    const stop = store.startWorkspace()
    const before = store.getWorkspace().layout
    const inbox = before.instances[before.primary]
    router.pushRoutePath('/map')
    const after = store.getWorkspace().layout
    const map = after.instances[after.primary]
    // the trap: the same instance (same AppInstanceHost) now shows another app,
    // and /inbox and /map both render InboxView
    expect(map.id).toBe(inbox.id)
    expect(map.app).toBe('map')
    expect(instanceBodyKey(map)).not.toBe(instanceBodyKey(inbox))
    stop()
  })

  it('the same app retargeting its path (a linked follow) keeps the mount — no remount, no flash', () => {
    expect(instanceBodyKey({ app: 'map' })).toBe(instanceBodyKey({ app: 'map' }))
    expect(instanceBodyKey({ app: 'entity-graph' })).toBe('entity-graph')
  })

  it('the host keys the route body by the app (not by the path or the instance)', () => {
    const src = readFileSync(join(here, 'AppInstanceHost.tsx'), 'utf8')
    expect(src).toMatch(/<Suspense key=\{instanceBodyKey\(inst\)\}/)
  })
})
