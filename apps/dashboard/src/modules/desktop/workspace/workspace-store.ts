import { useSyncExternalStore } from 'react'
import { normalizeRoutePath, setRouteNavigationInterceptor } from '../../../app/router'
import { NEXUS_APPS, getApp, resolveAppForRoute, type AppId } from '../../../domain/app-registry/app-registry'
import { resolveAppDestination } from '../../../domain/app-registry/contextual-navigation'
import { PROPERTY_LOCATOR_EVENT, readPropertyLocator, type PropertyLocator } from '../../../domain/locator/property-locator'
import * as L from './layout'

/**
 * THE WORKSPACE STORE — one per shell.
 *
 * Owns the layout tree, every app instance's own location, which pane has
 * focus, which instance the browser URL mirrors, saved workspaces, and the
 * linked context that lets panes follow one selection.
 *
 * URL rule: exactly one instance (the PRIMARY) is mirrored in the address bar,
 * so deep links, reload and Back/Forward keep working exactly as they did for
 * a single app. Every other instance keeps its own path in this store. The
 * primary only moves when it closes or when the address bar names an app that
 * is open elsewhere — never on focus, so a pane is never re-pointed under the
 * operator.
 *
 * Navigation rule (one instance per app): a navigation to an app that is
 * already open goes to THAT instance (and focuses it — "show me where");
 * anything else lands in the pane the operator just acted in.
 */

export interface SavedWorkspace { id: string; name: string; layout: L.Layout; linked: boolean; savedAt: number }

export interface WorkspaceSnapshot {
  layout: L.Layout
  /** panes follow the workspace selection */
  linked: boolean
  name: string | null
  savedId: string | null
  dirty: boolean
  /** instances animating out (pane → rail) */
  closing: Record<string, true>
  /** panes created after boot (they animate in; boot never animates) */
  entering: Record<string, true>
  saved: SavedWorkspace[]
  announce: string | null
  /** bumps when a workspace switch replaces the whole arrangement */
  generation: number
}

export type WorkspaceEvent =
  | { type: 'opened'; app: string; pane: string; how: L.Zone | 'navigate' }
  | { type: 'closed'; app: string }
  | { type: 'focused'; app: string; pane: string }
  | { type: 'maximized' | 'restored'; pane: string }
  | { type: 'switched'; name: string }
  | { type: 'pinned' | 'unpinned'; app: string }

const SESSION_KEY = 'lc.workspace.session.v1'
const SAVED_KEY = 'lc.workspaces.v1'
const CLOSE_MS = 300
const ENTER_MS = 700
const INTERACTION_WINDOW_MS = 2500

/* ── helpers ──────────────────────────────────────────────────────────── */

const pathnameOf = (path: string) => path.split('?')[0].split('#')[0] || '/'
export const appOfPath = (path: string): AppId => resolveAppForRoute(pathnameOf(path)).id
const appExists = (app: string) => app === 'settings' || NEXUS_APPS.some((a) => a.id === app)
const urlPath = () => (typeof window === 'undefined' ? '/inbox' : `${normalizeRoutePath(window.location.pathname)}${window.location.search}`)
const appLabel = (app: string) => { try { return getApp(app as AppId)?.label ?? app } catch { return app } }

const newInstance = (path: string): L.Instance => ({ id: L.newId('i'), app: appOfPath(path), path, pinned: false, pinLabel: null })

function readJSON<T>(store: Storage | undefined, key: string): T | null {
  try { return store ? (JSON.parse(store.getItem(key) || 'null') as T | null) : null } catch { return null }
}
function writeJSON(store: Storage | undefined, key: string, value: unknown) {
  try { store?.setItem(key, JSON.stringify(value)) } catch { /* private mode / quota */ }
}
const session = () => (typeof window === 'undefined' ? undefined : window.sessionStorage)
const local = () => (typeof window === 'undefined' ? undefined : window.localStorage)

function readSaved(): SavedWorkspace[] {
  const raw = readJSON<{ saved?: SavedWorkspace[] }>(local(), SAVED_KEY)
  return (raw?.saved ?? []).flatMap((w) => {
    const layout = L.reviveLayout(w?.layout, appExists)
    return layout && typeof w.name === 'string' ? [{ id: String(w.id), name: w.name, layout, linked: w.linked !== false, savedAt: Number(w.savedAt) || 0 }] : []
  })
}

/* ── boot ─────────────────────────────────────────────────────────────── */

function boot(): WorkspaceSnapshot {
  const url = urlPath()
  const urlApp = appOfPath(url)
  const saved = readSaved()
  const base = { closing: {}, entering: {}, saved, announce: null, generation: 0 }
  const stored = readJSON<{ layout: unknown; linked?: boolean; name?: string | null; savedId?: string | null; dirty?: boolean }>(session(), SESSION_KEY)
  const layout = stored ? L.reviveLayout(stored.layout, appExists) : null
  if (layout && stored) {
    // A reload of this tab: the arrangement returns. The address bar still wins
    // for the app it names (a deep link pasted into the same tab lands there).
    const prim = layout.instances[layout.primary]
    const holder = prim?.app === urlApp ? prim : L.instanceForApp(layout, urlApp)
    if (holder) {
      const pane = L.paneOf(layout, holder.id)!
      let next = L.updateInstance(layout, holder.id, { path: url })
      next = { ...L.activate(next, pane.id, holder.id), primary: holder.id }
      return { ...base, layout: next, linked: stored.linked !== false, name: stored.name ?? null, savedId: stored.savedId ?? null, dirty: Boolean(stored.dirty) }
    }
  }
  // An explicit address (or a fresh tab) opens exactly that, alone.
  return { ...base, layout: L.singleLayout(newInstance(url)), linked: true, name: null, savedId: null, dirty: false }
}

/* ── store ────────────────────────────────────────────────────────────── */

let snap: WorkspaceSnapshot | null = null
const listeners = new Set<() => void>()
const evListeners = new Set<(e: WorkspaceEvent) => void>()
let persistTimer = 0
let started = false

function get(): WorkspaceSnapshot {
  if (!snap) snap = boot()
  return snap
}

function writeSession() {
  const s = get()
  writeJSON(session(), SESSION_KEY, { layout: s.layout, linked: s.linked, name: s.name, savedId: s.savedId, dirty: s.dirty })
}

function persist() {
  if (typeof window === 'undefined') return
  window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(writeSession, 200)
}

function set(patch: Partial<WorkspaceSnapshot>, opts: { layoutChange?: boolean } = {}) {
  const cur = get()
  snap = { ...cur, ...patch, ...(opts.layoutChange && cur.savedId ? { dirty: true } : {}) }
  listeners.forEach((l) => l())
  persist()
}

function emit(e: WorkspaceEvent) { evListeners.forEach((l) => l(e)) }
export function onWorkspaceEvent(fn: (e: WorkspaceEvent) => void) { evListeners.add(fn); return () => { evListeners.delete(fn) } }

function say(text: string) { set({ announce: text }) }

function markEntering(paneId: string) {
  set({ entering: { ...get().entering, [paneId]: true } })
  window.setTimeout(() => {
    const { [paneId]: _gone, ...rest } = get().entering
    void _gone
    set({ entering: rest })
  }, ENTER_MS)
}

/* ── the address bar ──────────────────────────────────────────────────── */

let bypass = false
/** Run a router call that must reach the address bar untouched by the interceptor. */
function direct(fn: () => void) { bypass = true; try { fn() } finally { bypass = false } }

function mirrorPrimary(path: string) {
  if (typeof window === 'undefined') return
  if (urlPath() === path) return
  direct(() => {
    window.history.replaceState({ ...(window.history.state ?? {}) }, '', path)
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
}

/** The address bar moved (our own push/replace, or Back/Forward). */
function onUrl() {
  if (bypass) return
  const s = get()
  const url = urlPath()
  const prim = s.layout.instances[s.layout.primary]
  if (!prim || prim.path === url) return
  const app = appOfPath(url)
  if (app === prim.app) { set({ layout: L.updateInstance(s.layout, prim.id, { path: url }) }); return }
  const elsewhere = L.instanceForApp(s.layout, app)
  if (elsewhere) {
    // Back/Forward to an app that now lives in another pane: hand it the URL
    const pane = L.paneOf(s.layout, elsewhere.id)!
    let layout = L.updateInstance(s.layout, elsewhere.id, { path: url })
    layout = { ...L.activate(layout, pane.id, elsewhere.id), primary: elsewhere.id }
    set({ layout })
    return
  }
  // the primary instance's pane navigates to another application
  set({ layout: L.updateInstance(s.layout, prim.id, { app, path: url }) }, { layoutChange: true })
  const pane = L.paneOf(get().layout, prim.id)
  if (pane) emit({ type: 'opened', app, pane: pane.id, how: 'navigate' })
}

/* ── which pane the operator is acting in ─────────────────────────────── */

let lastInteraction: { pane: string; at: number } | null = null
export function markPaneInteraction(paneId: string) { lastInteraction = { pane: paneId, at: Date.now() } }
function actingPane(): string {
  const s = get()
  const recent = lastInteraction && Date.now() - lastInteraction.at < INTERACTION_WINDOW_MS ? lastInteraction.pane : null
  return recent && L.findPane(s.layout.root, recent) ? recent : s.layout.focus
}

/* ── navigation interceptor ───────────────────────────────────────────── */

function intercept(path: string, mode: 'push' | 'replace'): boolean {
  if (bypass) return false
  const s = get()
  const app = appOfPath(path)
  const holder = L.instanceForApp(s.layout, app)
  if (holder) {
    const pane = L.paneOf(s.layout, holder.id)!
    if (mode === 'push') {
      let layout = L.activate(s.layout, pane.id, holder.id)
      if (holder.id !== s.layout.primary) layout = L.updateInstance(layout, holder.id, { path })
      set({ layout })
      if (pane.id !== s.layout.focus) emit({ type: 'focused', app, pane: pane.id })
    } else if (holder.id !== s.layout.primary) {
      set({ layout: L.updateInstance(s.layout, holder.id, { path }) })
    }
    return holder.id !== s.layout.primary
  }
  // the app is not open: it replaces the active app of the pane being acted in
  const paneId = mode === 'push' ? actingPane() : (L.findPane(s.layout.root, s.layout.focus)?.id ?? s.layout.focus)
  const pane = L.findPane(s.layout.root, paneId)
  if (!pane) return false
  const target = s.layout.instances[pane.active]
  if (!target) return false
  if (target.id === s.layout.primary) return false // the address bar carries it; onUrl follows
  set({ layout: L.updateInstance(s.layout, target.id, { app, path }) }, { layoutChange: true })
  if (mode === 'push') emit({ type: 'opened', app, pane: pane.id, how: 'navigate' })
  return true
}

/* ── linked context ───────────────────────────────────────────────────── */

function followSelection(locator: PropertyLocator | null) {
  const s = get()
  if (!s.linked || !locator) return
  const source = actingPane()
  const sourceInst = L.findPane(s.layout.root, source)?.active ?? null
  let layout = s.layout
  let primaryPath: string | null = null
  for (const inst of Object.values(s.layout.instances)) {
    if (inst.id === sourceInst || inst.pinned) continue
    const app = (() => { try { return getApp(inst.app as AppId) } catch { return null } })()
    if (!app) continue
    const dest = resolveAppDestination(app, locator, 'contextual')
    // apps that seed from the locator themselves keep their own path
    if (!dest.focused || !dest.path || dest.path === app.route || dest.path === inst.path) continue
    if (inst.id === s.layout.primary) primaryPath = dest.path
    else layout = L.updateInstance(layout, inst.id, { path: dest.path })
  }
  if (layout !== s.layout) set({ layout })
  if (primaryPath) {
    const id = s.layout.primary
    direct(() => {
      window.history.replaceState({ ...(window.history.state ?? {}) }, '', primaryPath)
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    set({ layout: L.updateInstance(get().layout, id, { path: primaryPath }) })
  }
}

/* ── lifecycle ────────────────────────────────────────────────────────── */

let selectionAt = 0
/**
 * True once the operator has selected a subject in THIS workspace session.
 * The property locator itself persists per tab; a selection made before this
 * window loaded is history, and a newly composed pane should not quietly aim
 * at it.
 */
export const selectionInSession = () => selectionAt > 0

/** Mount once from the desktop shell. Returns teardown. */
export function startWorkspace(): () => void {
  if (started || typeof window === 'undefined') return () => {}
  started = true
  get()
  setRouteNavigationInterceptor(intercept)
  const onPop = () => onUrl()
  const onLocator = (e: Event) => {
    const detail = (e as CustomEvent<PropertyLocator | null>).detail ?? null
    selectionAt = detail ? Date.now() : 0
    followSelection(detail)
  }
  window.addEventListener('popstate', onPop)
  window.addEventListener(PROPERTY_LOCATOR_EVENT, onLocator)
  return () => {
    started = false
    setRouteNavigationInterceptor(null)
    window.removeEventListener('popstate', onPop)
    window.removeEventListener(PROPERTY_LOCATOR_EVENT, onLocator)
  }
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
export const getWorkspace = () => get()
export function useWorkspace(): WorkspaceSnapshot {
  return useSyncExternalStore(subscribe, get, get)
}

/* ── operations ───────────────────────────────────────────────────────── */

export type Where = 'beside' | L.Placement

/**
 * Open an application in the workspace. If it is already open it MOVES to
 * the requested place (one instance per app) and keeps its own state; a
 * contextual path updates its subject.
 */
export function openApp(path: string, where: Where = 'beside'): 'opened' | 'moved' | 'focused' | 'refused' {
  const s = get()
  const app = appOfPath(path)
  const existing = L.instanceForApp(s.layout, app)
  let at: L.Placement
  if (where === 'beside') {
    if (existing) {
      const pane = L.paneOf(s.layout, existing.id)!
      let layout = L.activate(s.layout, pane.id, existing.id)
      if (path !== app && path !== existing.path && path.includes('?')) layout = L.updateInstance(layout, existing.id, { path })
      set({ layout })
      emit({ type: 'focused', app, pane: pane.id })
      return 'focused'
    }
    at = { pane: s.layout.focus, zone: 'right' }
  } else {
    at = where
  }
  const inst = existing ? { ...existing, path: path.includes('?') ? path : existing.path } : newInstance(path)
  const { layout, pane } = L.place(s.layout, inst, at)
  if (layout === s.layout) return 'refused'
  const fresh = !L.findPane(s.layout.root, pane)
  set({ layout: { ...layout, maximized: null } }, { layoutChange: true })
  if (fresh) markEntering(pane)
  emit({ type: 'opened', app, pane, how: at.zone })
  const name = appLabel(app)
  say(at.zone === 'stack' ? `${name} added to the stack.` : at.zone === 'replace' ? `${name} replaced the app in that pane.` : `${name} opened on the ${at.zone}.`)
  return existing ? 'moved' : 'opened'
}

/** Close an instance with the pane → rail motion; the layout settles after it. */
export function closeApp(instanceId: string, opts: { immediate?: boolean } = {}) {
  const s = get()
  const inst = s.layout.instances[instanceId]
  if (!inst || s.closing[instanceId]) return
  const all = L.panes(s.layout.root)
  if (all.length === 1 && all[0].tabs.length === 1) return
  const finish = () => {
    const cur = get()
    const { [instanceId]: _gone, ...closing } = cur.closing
    void _gone
    const wasPrimary = cur.layout.primary === instanceId
    const layout = L.closeInstance(cur.layout, instanceId)
    set({ layout, closing }, { layoutChange: true })
    if (wasPrimary) mirrorPrimary(layout.instances[layout.primary]?.path ?? '/inbox')
    emit({ type: 'closed', app: inst.app })
    say(`${appLabel(inst.app)} closed.`)
  }
  if (opts.immediate) { finish(); return }
  set({ closing: { ...s.closing, [instanceId]: true } })
  window.setTimeout(finish, CLOSE_MS)
}

export function closePaneApps(paneId: string) {
  const pane = L.findPane(get().layout.root, paneId)
  if (!pane) return
  // the stack goes with its pane: close the hidden tabs at once, animate the active one
  for (const t of pane.tabs) if (t !== pane.active) closeApp(t, { immediate: true })
  closeApp(pane.active)
}

export function focusPane(paneId: string) {
  const s = get()
  if (s.layout.focus === paneId) return
  set({ layout: L.focus(s.layout, paneId) })
}

export function activateTab(paneId: string, instanceId: string) {
  set({ layout: L.activate(get().layout, paneId, instanceId) })
}

export function setSplitSizes(splitId: string, sizes: number[]) {
  set({ layout: L.setSizes(get().layout, splitId, sizes) }, { layoutChange: true })
}
export function resetSplit(splitId: string) {
  set({ layout: L.resetSizes(get().layout, splitId) }, { layoutChange: true })
}

export function toggleMaximize(paneId: string) {
  const s = get()
  const next = s.layout.maximized === paneId ? null : paneId
  set({ layout: L.maximize(s.layout, next) })
  emit(next ? { type: 'maximized', pane: paneId } : { type: 'restored', pane: paneId })
  const app = s.layout.instances[L.findPane(s.layout.root, paneId)?.active ?? '']?.app
  if (app) say(next ? `${appLabel(app)} fills the workspace.` : 'Workspace restored.')
}

export function movePane(paneId: string, side: L.Side, rects: Record<string, L.Rect>) {
  const s = get()
  const pane = L.findPane(s.layout.root, paneId)
  const to = L.neighbour(s.layout, paneId, side, rects)
  if (!pane || !to) return
  const inst = s.layout.instances[pane.active]
  // swap: the active app goes beside its neighbour on that side
  const { layout } = L.place(s.layout, inst, { pane: to, zone: side === 'left' ? 'left' : side === 'right' ? 'right' : side === 'top' ? 'top' : 'bottom' })
  set({ layout }, { layoutChange: true })
  say(`${appLabel(inst.app)} moved ${side === 'top' ? 'up' : side === 'bottom' ? 'down' : side}.`)
}

export function setLinked(linked: boolean) {
  set({ linked })
  say(linked ? 'Panes follow the selection.' : 'Panes are independent.')
  if (linked) followSelection(readPropertyLocator())
}

export function setPinned(instanceId: string, pinned: boolean) {
  const s = get()
  const inst = s.layout.instances[instanceId]
  if (!inst) return
  const loc = readPropertyLocator()
  set({ layout: L.updateInstance(s.layout, instanceId, { pinned, pinLabel: pinned ? (loc?.address ?? null) : null }) })
  emit({ type: pinned ? 'pinned' : 'unpinned', app: inst.app })
  say(pinned ? `${appLabel(inst.app)} pinned${loc?.address ? ` to ${loc.address}` : ''}.` : `${appLabel(inst.app)} follows the selection again.`)
  if (!pinned && s.linked) followSelection(loc)
}

/* ── saved workspaces ─────────────────────────────────────────────────── */

function writeSaved(saved: SavedWorkspace[]) { writeJSON(local(), SAVED_KEY, { saved }) }

export function saveWorkspace(name?: string): SavedWorkspace {
  const s = get()
  const id = s.savedId && !name ? s.savedId : L.newId('w')
  const entry: SavedWorkspace = { id, name: (name ?? s.name ?? 'Workspace').trim() || 'Workspace', layout: { ...s.layout, maximized: null }, linked: s.linked, savedAt: Date.now() }
  const saved = [...s.saved.filter((w) => w.id !== id), entry].sort((a, b) => a.name.localeCompare(b.name))
  writeSaved(saved)
  set({ saved, savedId: id, name: entry.name, dirty: false })
  say(`Saved “${entry.name}”.`)
  return entry
}

export function renameWorkspace(id: string, name: string) {
  const s = get()
  const clean = name.trim()
  if (!clean) return
  const saved = s.saved.map((w) => (w.id === id ? { ...w, name: clean } : w))
  writeSaved(saved)
  set({ saved, ...(s.savedId === id ? { name: clean } : {}) })
}

export function deleteWorkspace(id: string) {
  const s = get()
  const saved = s.saved.filter((w) => w.id !== id)
  writeSaved(saved)
  set({ saved, ...(s.savedId === id ? { savedId: null, name: null, dirty: false } : {}) })
}

export function duplicateWorkspace(id: string) {
  const s = get()
  const w = s.saved.find((x) => x.id === id)
  if (!w) return
  const copy = { ...w, id: L.newId('w'), name: `${w.name} copy`, savedAt: Date.now() }
  const saved = [...s.saved, copy].sort((a, b) => a.name.localeCompare(b.name))
  writeSaved(saved)
  set({ saved })
}

function adopt(layout: L.Layout, meta: { name: string | null; savedId: string | null; linked: boolean }) {
  const s = get()
  set({ layout: { ...layout, maximized: null }, name: meta.name, savedId: meta.savedId, linked: meta.linked, dirty: false, closing: {}, entering: {}, generation: s.generation + 1 })
  mirrorPrimary(layout.instances[layout.primary]?.path ?? '/inbox')
}

export function switchWorkspace(id: string) {
  const w = get().saved.find((x) => x.id === id)
  if (!w) return
  adopt(w.layout, { name: w.name, savedId: w.id, linked: w.linked })
  emit({ type: 'switched', name: w.name })
  say(`${w.name} workspace.`)
}

/** Back to one application: the focused one. */
export function resetWorkspace() {
  const s = get()
  const keep = L.focusedInstance(s.layout) ?? s.layout.instances[s.layout.primary]
  if (!keep) return
  adopt(L.singleLayout({ ...keep, pinned: false, pinLabel: null }), { name: null, savedId: null, linked: true })
  say('Workspace reset to one application.')
}

/** Start a workspace from a template: the first path anchors, the rest arrange around it. */
export function newWorkspaceFrom(template: { name: string; paths: string[]; arrangement: 'row' | 'main-right-stack' | 'grid' }) {
  const [first, ...rest] = template.paths
  if (!first) return
  let layout = L.singleLayout(newInstance(first))
  const anchor = layout.focus
  if (template.arrangement === 'row') {
    let last = anchor
    for (const p of rest) { const r = L.place(layout, newInstance(p), { pane: last, zone: 'right' }); layout = r.layout; last = r.pane }
  } else if (template.arrangement === 'main-right-stack') {
    const [second, ...others] = rest
    if (second) {
      const r = L.place(layout, newInstance(second), { pane: anchor, zone: 'right' })
      layout = r.layout
      let last = r.pane
      for (const p of others) { const b = L.place(layout, newInstance(p), { pane: last, zone: 'bottom' }); layout = b.layout; last = b.pane }
    }
  } else {
    const [b, c, d] = rest
    let right = anchor
    if (b) { const r = L.place(layout, newInstance(b), { pane: anchor, zone: 'right' }); layout = r.layout; right = r.pane }
    if (c) layout = L.place(layout, newInstance(c), { pane: anchor, zone: 'bottom' }).layout
    if (d) layout = L.place(layout, newInstance(d), { pane: right, zone: 'bottom' }).layout
  }
  layout = { ...layout, focus: anchor, primary: Object.values(layout.instances).find((i) => i.path === first)?.id ?? layout.primary }
  adopt(layout, { name: template.name, savedId: null, linked: true })
  emit({ type: 'switched', name: template.name })
  say(`${template.name} workspace.`)
}

export const WORKSPACE_TEMPLATES = [
  { id: 'acquisitions', name: 'Acquisitions', paths: ['/inbox', '/deal-intelligence', '/map'], arrangement: 'main-right-stack' as const },
  { id: 'campaign-ops', name: 'Campaign Ops', paths: ['/campaign-command', '/queue', '/analytics'], arrangement: 'main-right-stack' as const },
  { id: 'disposition', name: 'Disposition', paths: ['/buyer-match', '/comp-intelligence', '/entity-graph'], arrangement: 'main-right-stack' as const },
  { id: 'closing', name: 'Closing', paths: ['/closing-desk', '/email-command', '/calendar'], arrangement: 'main-right-stack' as const },
]

/** Test seam. */
export const __workspaceTest = { reset: () => { snap = null; lastInteraction = null }, flush: () => { window.clearTimeout(persistTimer); writeSession() }, intercept, onUrl, followSelection }
