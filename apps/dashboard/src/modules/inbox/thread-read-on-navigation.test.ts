/**
 * NAVIGATION NEVER MARKS A CONVERSATION READ (Sender Routing 2.0 §E).
 *
 * Three layers, because the defect crossed three:
 *   1. the policy: only `open_conversation` writes `is_read`, through the canonical key;
 *   2. the wiring: every InboxPage host binds Map / Pipeline / Calendar / Queue /
 *      Entity Graph selection to the navigate handler, and the open paths (Inbox row,
 *      desk open, deep link / Notification Open) to the read handler;
 *   3. the universal object actions (click, Show on Map, Inspect, Open beside, from all
 *      six apps and from a notification) make no network write of their own.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { applyThreadReadOnSelect, marksReadOnSelect, type ThreadSelectIntent } from './thread-read-policy'

/* ── 1. the policy ───────────────────────────────────────────────────── */

const SELLER = '+15550100001'
const writableThread = { id: SELLER, threadKey: SELLER, thread_key: SELLER, canonicalE164: SELLER, canonical_e164: SELLER }

/** A tiny thread-state store: is_read flips only when the canonical write lands. */
function threadState() {
  const read = new Map<string, boolean>([[SELLER, false]])
  const patchRead = vi.fn(async (key: string) => { read.set(key, true); return { ok: true } })
  return { read, patchRead }
}

describe('thread read policy', () => {
  it('only an opened conversation is a read', () => {
    expect(marksReadOnSelect('open_conversation')).toBe(true)
    expect(marksReadOnSelect('navigate')).toBe(false)
  })

  it('a navigate selection leaves the thread unread and makes no request', () => {
    const s = threadState()
    const onUnwritable = vi.fn()
    expect(applyThreadReadOnSelect('navigate', writableThread, { patchRead: s.patchRead, onUnwritable })).toBe('skipped')
    expect(s.patchRead).not.toHaveBeenCalled()
    expect(onUnwritable).not.toHaveBeenCalled()
    expect(s.read.get(SELLER)).toBe(false)
  })

  it('a navigate selection of an unwritable reference is silent too (no "could not mark read" toast)', () => {
    const onUnwritable = vi.fn()
    expect(applyThreadReadOnSelect('navigate', { id: 'conv-1', threadKey: 'conv-1' }, { patchRead: vi.fn(), onUnwritable })).toBe('skipped')
    expect(onUnwritable).not.toHaveBeenCalled()
  })

  it('opening the conversation still marks it read, once, by the canonical E.164 key', async () => {
    const s = threadState()
    const onWritten = vi.fn()
    expect(applyThreadReadOnSelect('open_conversation', writableThread, { patchRead: s.patchRead, onWritten })).toBe('requested')
    expect(s.patchRead).toHaveBeenCalledTimes(1)
    expect(s.patchRead).toHaveBeenCalledWith(SELLER)
    await Promise.resolve(); await Promise.resolve()
    expect(s.read.get(SELLER)).toBe(true)
    expect(onWritten).toHaveBeenCalledTimes(1)
  })

  it('an opened conversation with no writable phone route reports it instead of guessing a key', () => {
    const patchRead = vi.fn()
    const onUnwritable = vi.fn()
    expect(applyThreadReadOnSelect('open_conversation', { id: 'conv-1', threadKey: 'conv-1' }, { patchRead, onUnwritable })).toBe('unwritable')
    expect(patchRead).not.toHaveBeenCalled()
    expect(onUnwritable).toHaveBeenCalledTimes(1)
  })

  it('a failed write does not claim success', async () => {
    const onWritten = vi.fn()
    applyThreadReadOnSelect('open_conversation', writableThread, { patchRead: async () => ({ ok: false }), onWritten })
    await Promise.resolve(); await Promise.resolve()
    expect(onWritten).not.toHaveBeenCalled()
  })
})

/* ── 2. the wiring in every InboxPage host ───────────────────────────── */

const INBOX_PAGE = readFileSync(fileURLToPath(new URL('./InboxPage.tsx', import.meta.url)), 'utf8')
const count = (needle: string) => INBOX_PAGE.split(needle).length - 1

describe('InboxPage selection wiring', () => {
  it('has exactly one is_read write, and it goes through the policy', () => {
    expect(count('patch: { is_read: true }')).toBe(1)
    expect(count('applyThreadReadOnSelect(')).toBe(1)
    expect(INBOX_PAGE).toMatch(/const handleSelect = useCallback\(\(id: string\) => selectThreadWithIntent\(id, 'open_conversation'\)/)
    expect(INBOX_PAGE).toMatch(/const handleSelectInView = useCallback\(\(id: string\) => selectThreadWithIntent\(id, 'navigate'\)/)
  })

  it('Map pin taps, Map arrival, linked focus and Show on Map (both Map hosts) select without reading', () => {
    // InboxCommandMap reports every one of those through onSelectThreadId.
    expect(count('onSelectThreadId={handleSelect}')).toBe(0)
    expect(count('onSelectThreadId={handleSelectInView}')).toBe(2)
  })

  it.each([
    ['Pipeline card', 'onSelect={handleSelectInView}\n            onAnchorThread={anchorThreadSelection}'],
    ['Calendar thread', 'onSelectThread={handleSelectInView}'],
    ['Calendar event', '        handleSelectInView(match.id)\n        return\n      }\n    }\n    setActiveContext(buildContextFromCalendarEvent(event)'],
    ['Queue item', '              handleSelectInView(linkedThread.id)'],
    ['Entity Graph selection', "if (match) handleSelectInView(match.id)\n              else setActiveContext({ threadKey, ...activeInboxFromUniversalContext(universalEntityContext, 'entity_graph') }"],
  ])('%s selects without reading', (_surface, binding) => {
    expect(INBOX_PAGE).toContain(binding)
  })

  it.each([
    ['Inbox list row', '        onSelect={handleSelect}\n        onThreadAction={handleThreadAction}'],
    ['Inbox desk open', '    handleSelect(threadId)\n  }, [cancelDeskRoomClose, handleSelect, threads])'],
    ['Open conversation / Notification Open (thread in the loaded page)', "      clearPendingInboxThread()\n      handleSelect(inList.id)\n      focusWorkspaceView('sms_thread')"],
    ['Open conversation / Notification Open (thread fetched by key)', "      selectThread(hit)\n      // An explicit open (Open conversation, Notification Open) -- a read, exactly like\n      // the in-list branch above, which goes through handleSelect.\n      readOnSelect('open_conversation', hit)"],
    ['Pipeline "open in conversation"', "              if (threadId) handleSelect(threadId)\n              handleFocusWorkspaceView('sms_thread')"],
  ])('%s opens the conversation (a read)', (_surface, binding) => {
    expect(INBOX_PAGE).toContain(binding)
  })

  it('linked context / locator seeding anchors a selection without any read', () => {
    const setActiveContext = INBOX_PAGE.slice(INBOX_PAGE.indexOf('const setActiveContext = useCallback('), INBOX_PAGE.indexOf('SEED FROM THE LOCATOR ON MOUNT'))
    expect(setActiveContext).toContain('selectFromExternalContext(match)')
    expect(setActiveContext).not.toMatch(/handleSelect\(|readOnSelect\(|is_read/)
  })
})

/* ── 3. the universal object actions make no write ───────────────────── */

function installWindow(path: string) {
  const [pathname, search = ''] = path.split('?')
  const loc = { pathname, search: search ? `?${search}` : '' }
  const handlers = new Map<string, Set<(e: Event) => void>>()
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) }, clear: () => m.clear() } }
  const go = (url: string) => { const u = new URL(url, 'http://x'); loc.pathname = u.pathname; loc.search = u.search }
  const w = {
    location: loc,
    history: { state: null as unknown, replaceState: (_s: unknown, _t: string, url: string) => go(url), pushState: (_s: unknown, _t: string, url: string) => go(url) },
    sessionStorage: mem(),
    localStorage: mem(),
    innerWidth: 1600, innerHeight: 1000, screen: { width: 1600, height: 1000 },
    matchMedia: () => ({ matches: false }),
    addEventListener: (type: string, fn: (e: Event) => void) => { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type)!.add(fn) },
    removeEventListener: (type: string, fn: (e: Event) => void) => { handlers.get(type)?.delete(fn) },
    dispatchEvent: (e: Event) => { handlers.get(e.type)?.forEach((fn) => fn(e)); return true },
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id),
    getSelection: () => null,
  }
  Object.assign(globalThis, { window: w, sessionStorage: w.sessionStorage, localStorage: w.localStorage })
  class PopStateEvent { type: string; constructor(type: string) { this.type = type } }
  class CustomEvent<T> { type: string; detail: T; constructor(type: string, init?: { detail: T }) { this.type = type; this.detail = init?.detail as T } }
  Object.assign(globalThis, { PopStateEvent, CustomEvent })
  return w
}

async function load(path: string) {
  vi.resetModules()
  installWindow(path)
  const fetchSpy = vi.fn(async () => new Response('{}'))
  vi.stubGlobal('fetch', fetchSpy)
  const store = await import('../desktop/workspace/workspace-store')
  const actions = await import('../desktop/objects/object-actions')
  const reg = await import('../desktop/objects/object-registry')
  const inspector = await import('../desktop/inspector/inspector-store')
  const bridge = await import('../mobile/mobile-inbox-bridge')
  store.__workspaceTest.reset()
  inspector.__inspectorTest.reset()
  const stop = store.startWorkspace()
  return { store, actions, reg, inspector, bridge, fetchSpy, stop }
}

describe('universal object actions on a property with a conversation', () => {
  it('click, ⇧-click, ⌘-click, Show on Map, Inspect and Open beside from all six apps make no write', { timeout: 30000 }, async () => {
    const env = await load('/inbox')
    env.store.openApp('/map', 'beside')
    const { propertyObject } = env.reg
    const base = { propertyId: '273312064', threadKey: SELLER, label: '3635 Emerson Ave N' }
    const surfaces = {
      inbox: propertyObject({ ...base, source: 'inbox' }),
      map: propertyObject({ ...base, source: 'map' }),
      'deal-intelligence': propertyObject({ ...base, opportunityId: 'opp-1', source: 'deal-intelligence' }),
      'comp-intelligence': propertyObject({ ...base, source: 'comp-intelligence', lat: 45.0193, lng: -93.2943 }),
      pipeline: propertyObject({ ...base, opportunityId: 'opp-1', source: 'pipeline' }),
      'entity-graph': propertyObject({ ...base, source: 'entity-graph' }),
      analytics: propertyObject({ ...base, source: 'analytics' }),
    }
    for (const [surface, ref] of Object.entries(surfaces)) {
      env.actions.showOnMap(ref, { source: surface })
      env.actions.inspectObject(ref)
      env.actions.handleObjectClick({ shiftKey: true }, ref, () => {})
      env.actions.handleObjectClick({ metaKey: true }, ref, () => {})
      env.actions.openObjectBeside(ref)
      env.actions.openObject(ref)
    }
    expect(env.fetchSpy).not.toHaveBeenCalled()
    env.stop()
    vi.unstubAllGlobals()
  })

  it('Notification Inspect on a seller conversation opens the quick view, never the thread', async () => {
    const env = await load('/map')
    const seller = env.reg.sellerObject({ threadKey: SELLER, propertyId: '273312064', source: 'notifications' })
    const r = env.actions.inspectObject(seller)
    expect(r.ok).toBe(true)
    expect(env.inspector.readInspectorState().current?.type).toBe('seller')
    // no pending thread open -> InboxPage.openPendingThread has nothing to read
    expect(env.bridge.peekPendingInboxThread()).toBeNull()
    expect(env.fetchSpy).not.toHaveBeenCalled()
    env.stop()
    vi.unstubAllGlobals()
  })

  it('Notification Open on a seller conversation hands the Inbox an explicit open (the read path)', async () => {
    const env = await load('/map')
    const seller = env.reg.sellerObject({ threadKey: SELLER, propertyId: '273312064', source: 'notifications' })
    env.actions.openObject(seller)
    // /inbox?thread=… is consumed by openPendingThread -> handleSelect ('open_conversation')
    expect(env.bridge.peekPendingInboxThread()?.threadKey).toBe(SELLER)
    expect(env.fetchSpy).not.toHaveBeenCalled()
    env.stop()
    vi.unstubAllGlobals()
  })
})

// Exhaustiveness: a new intent must decide its read behaviour here.
const _intents: Record<ThreadSelectIntent, boolean> = { open_conversation: true, navigate: false }
void _intents
