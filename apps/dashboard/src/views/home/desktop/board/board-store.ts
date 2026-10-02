import { useSyncExternalStore } from 'react'
import { copyLayout, layoutFromPreset, migrateLayout, PRESETS, type HomeLayout, type PresetId } from './home-layout-model'
import type { HomeLayoutApi } from './home-layout-api'

/**
 * HOME BOARD STORE — the operator's saved boards and where they persist.
 *
 *   local   always: written synchronously on every change, keyed by operator
 *           (`lc.home.board.v1:<operator>`), so the board survives a reload
 *           with or without the server
 *   server  when /api/cockpit/home/layouts answers: every changed layout is
 *           saved (debounced) with its revision; the server refuses a stale
 *           revision and this board adopts the server's copy
 *
 * The first time the server is available and holds nothing for this operator,
 * the local layouts are uploaded — local persistence migrates itself.
 *
 * The board opens on the operator's default layout. A new operator gets the
 * Command preset as their default: never an empty canvas, never a wizard.
 * Removed widgets are never forced back.
 */

export type Persistence = 'booting' | 'local' | 'server'

export interface BoardSnapshot {
  ready: boolean
  operatorKey: string | null
  layouts: HomeLayout[]
  activeId: string | null
  editing: boolean
  /** the Add Widget library is open (edit mode only) */
  library: boolean
  persistence: Persistence
  /** why persistence is local, in operator words */
  note: string | null
  /** a newer copy arrived from another session */
  adoptedAt: number | null
}

export interface BoardDeps {
  api: HomeLayoutApi
  storage: Pick<Storage, 'getItem' | 'setItem'> | null
  now: () => number
  /** debounce for server writes (ms) */
  saveDelayMs: number
}

const LOCAL_PREFIX = 'lc.home.board.v1:'
interface LocalFile { v: 1; activeId: string | null; layouts: unknown[]; synced: string[] }

const EMPTY: BoardSnapshot = { ready: false, operatorKey: null, layouts: [], activeId: null, editing: false, library: false, persistence: 'booting', note: null, adoptedAt: null }

let snap: BoardSnapshot = EMPTY
let deps: BoardDeps | null = null
/** layout ids the server is known to hold (to tell "deleted elsewhere" from "never uploaded") */
let synced = new Set<string>()
const dirty = new Set<string>()
const deleted = new Set<string>()
let saveTimer: ReturnType<typeof setTimeout> | null = null
let bootToken = 0
/** the starter layout created on an empty device (dropped if the server already holds layouts) */
let freshId: string | null = null
const listeners = new Set<() => void>()

const set = (patch: Partial<BoardSnapshot>) => { snap = { ...snap, ...patch }; listeners.forEach((l) => l()) }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const get = () => snap

export const useBoard = () => useSyncExternalStore(subscribe, get, get)
export const getBoard = () => snap
export const subscribeBoard = subscribe

/* ── local file ───────────────────────────────────────────────────────── */

function readLocal(key: string): LocalFile | null {
  try {
    const raw = deps?.storage?.getItem(LOCAL_PREFIX + key)
    if (!raw) return null
    const f = JSON.parse(raw) as Partial<LocalFile>
    return { v: 1, activeId: typeof f.activeId === 'string' ? f.activeId : null, layouts: Array.isArray(f.layouts) ? f.layouts : [], synced: Array.isArray(f.synced) ? f.synced.filter((x): x is string => typeof x === 'string') : [] }
  } catch {
    return null
  }
}

function writeLocal() {
  if (!snap.operatorKey) return
  try {
    const file: LocalFile = { v: 1, activeId: snap.activeId, layouts: snap.layouts, synced: [...synced] }
    deps?.storage?.setItem(LOCAL_PREFIX + snap.operatorKey, JSON.stringify(file))
  } catch { /* storage full or private mode: the server copy (if any) still holds */ }
}

/* ── boot + sync ──────────────────────────────────────────────────────── */

const defaultOf = (layouts: HomeLayout[]) => layouts.find((l) => l.isDefault) ?? layouts[0] ?? null

/** Open the operator's boards: local first (instant), then the server. Safe to call again for the same operator. */
export async function bootBoard(operatorKey: string, d: BoardDeps): Promise<void> {
  if (snap.ready && snap.operatorKey === operatorKey && deps === d) return
  deps = d
  const token = ++bootToken
  synced = new Set()
  dirty.clear()
  deleted.clear()
  const local = readLocal(operatorKey)
  let layouts = (local?.layouts ?? []).map(migrateLayout).filter((l): l is HomeLayout => Boolean(l))
  synced = new Set(local?.synced ?? [])
  if (!layouts.length) {
    layouts = [layoutFromPreset('command', { isDefault: true, now: new Date(d.now()) })]
    dirty.add(layouts[0].id)
    freshId = layouts[0].id
  } else {
    freshId = null
  }
  const activeId = layouts.some((l) => l.id === local?.activeId) ? local!.activeId : defaultOf(layouts)!.id
  snap = { ...EMPTY, ready: true, operatorKey, layouts, activeId, persistence: 'booting', editing: snap.editing && snap.operatorKey === operatorKey }
  listeners.forEach((l) => l())
  writeLocal()
  await syncWithServer(token)
}

async function syncWithServer(token: number) {
  if (!deps) return
  const res = await deps.api.list().catch(() => ({ ok: false as const, reason: 'network' as const, message: 'Layouts are saved on this device — the server could not be reached.' }))
  if (token !== bootToken) return
  if (!res.ok) { set({ persistence: 'local', note: res.message }); return }

  const server = new Map(res.layouts.map((l) => [l.id, l]))
  const merged: HomeLayout[] = []
  for (const l of snap.layouts) {
    const remote = server.get(l.id)
    if (remote) {
      // the higher revision wins; a tie is the server's
      merged.push(remote.revision >= l.revision ? remote : l)
      if (l.revision > remote.revision) dirty.add(l.id)
      server.delete(l.id)
    } else if (synced.has(l.id) && res.layouts.length) {
      // the server had it and no longer does: deleted in another session
      continue
    } else {
      merged.push(l)
      dirty.add(l.id)
    }
  }
  for (const remote of server.values()) merged.push(remote)
  synced = new Set(res.layouts.map((l) => l.id))
  // the starter board made for an empty device never displaces boards the operator already has on the server
  if (freshId && res.layouts.length) {
    const i = merged.findIndex((l) => l.id === freshId)
    if (i >= 0 && merged[i].revision === 0) { merged.splice(i, 1); dirty.delete(freshId) }
  }
  freshId = null
  const activeId = merged.some((l) => l.id === snap.activeId) ? snap.activeId : defaultOf(merged)?.id ?? null
  set({ layouts: merged, activeId, persistence: 'server', note: null })
  writeLocal()
  if (dirty.size) scheduleSave(0)
}

let lastRetry = 0
/** Try the server again (the board calls this when it becomes visible); no-op unless persistence fell back to local. */
export function retryServer(minGapMs = 120_000): void {
  if (!deps || !snap.ready || snap.persistence !== 'local') return
  const now = deps.now()
  if (now - lastRetry < minGapMs) return
  lastRetry = now
  void syncWithServer(++bootToken)
}

function scheduleSave(delay = deps?.saveDelayMs ?? 900) {
  if (snap.persistence !== 'server') return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { saveTimer = null; void flushSaves() }, delay)
}

/** Write pending changes now (tests, unload). */
export async function flushSaves(): Promise<void> {
  if (!deps || snap.persistence !== 'server') return
  const ids = [...dirty]
  dirty.clear()
  for (const id of ids) {
    const layout = snap.layouts.find((l) => l.id === id)
    if (!layout) continue
    const r = await deps.api.save(layout).catch(() => ({ ok: false as const, reason: 'network' as const, message: 'Layouts are saved on this device — the server could not be reached.' }))
    if (r.ok) { synced.add(id); continue }
    if (r.reason === 'conflict') {
      // another session saved a newer copy: adopt it rather than overwrite it
      if (r.current) replaceLayout(r.current, { adopted: true })
      synced.add(id)
      continue
    }
    if (r.reason === 'invalid') continue
    dirty.add(id)
    set({ persistence: 'local', note: r.message })
  }
  const gone = [...deleted]
  deleted.clear()
  for (const id of gone) {
    const r = await deps.api.remove(id).catch(() => ({ ok: false }))
    if (r.ok) synced.delete(id)
    else deleted.add(id)
  }
  writeLocal()
}

function replaceLayout(next: HomeLayout, opts: { adopted?: boolean } = {}) {
  set({ layouts: snap.layouts.map((l) => (l.id === next.id ? next : l)), adoptedAt: opts.adopted ? (deps?.now() ?? Date.now()) : snap.adoptedAt })
}

/* ── changes ──────────────────────────────────────────────────────────── */

export const activeLayout = (s: BoardSnapshot = snap): HomeLayout | null => s.layouts.find((l) => l.id === s.activeId) ?? null

/** Apply a change to one layout: bumps its revision, saves locally now and to the server soon. */
export function commitLayout(id: string, change: (l: HomeLayout) => HomeLayout): HomeLayout | null {
  const cur = snap.layouts.find((l) => l.id === id)
  if (!cur) return null
  const changed = change(cur)
  if (changed === cur) return cur
  const next: HomeLayout = { ...changed, revision: cur.revision + 1, updatedAt: new Date(deps?.now() ?? Date.now()).toISOString() }
  set({ layouts: snap.layouts.map((l) => (l.id === id ? next : l)) })
  dirty.add(id)
  writeLocal()
  scheduleSave()
  return next
}

export function commitActive(change: (l: HomeLayout) => HomeLayout): HomeLayout | null {
  return snap.activeId ? commitLayout(snap.activeId, change) : null
}

/** Put a whole previous copy back (Undo). */
export function restoreLayout(prev: HomeLayout): void {
  if (!snap.layouts.some((l) => l.id === prev.id)) return
  commitLayout(prev.id, () => ({ ...prev }))
}

export function setActiveLayout(id: string) {
  if (!snap.layouts.some((l) => l.id === id) || snap.activeId === id) return
  set({ activeId: id })
  writeLocal()
}

export function setEditing(on: boolean) { if (snap.editing !== on) set({ editing: on, library: on ? snap.library : false }) }
export function setLibrary(on: boolean) { if (snap.library !== on) set({ library: on, editing: on ? true : snap.editing }) }

function insertLayout(l: HomeLayout, activate = true) {
  set({ layouts: [...snap.layouts, l], activeId: activate ? l.id : snap.activeId })
  dirty.add(l.id)
  writeLocal()
  scheduleSave()
}

export function saveLayoutAs(name: string): HomeLayout | null {
  const cur = activeLayout()
  if (!cur) return null
  const copy = copyLayout(cur, name.trim().slice(0, 80) || 'Untitled layout', new Date(deps?.now() ?? Date.now()))
  insertLayout(copy)
  return copy
}

export function duplicateLayout(id: string): HomeLayout | null {
  const src = snap.layouts.find((l) => l.id === id)
  if (!src) return null
  const copy = copyLayout(src, `${src.name} copy`.slice(0, 80), new Date(deps?.now() ?? Date.now()))
  insertLayout(copy)
  return copy
}

export function renameLayout(id: string, name: string) {
  const n = name.trim().slice(0, 80)
  if (!n) return
  commitLayout(id, (l) => (l.name === n ? l : { ...l, name: n }))
}

/** Delete a saved layout. The last one cannot be deleted (Home is never empty of layouts). */
export function deleteLayout(id: string): boolean {
  if (snap.layouts.length <= 1 || !snap.layouts.some((l) => l.id === id)) return false
  const wasDefault = snap.layouts.find((l) => l.id === id)?.isDefault
  let layouts = snap.layouts.filter((l) => l.id !== id)
  if (wasDefault) layouts = layouts.map((l, i) => (i === 0 ? { ...l, isDefault: true, revision: l.revision + 1 } : l))
  if (wasDefault) dirty.add(layouts[0].id)
  const activeId = snap.activeId === id ? defaultOf(layouts)!.id : snap.activeId
  set({ layouts, activeId })
  dirty.delete(id)
  if (synced.has(id)) deleted.add(id)
  writeLocal()
  scheduleSave()
  return true
}

export function setDefaultLayout(id: string) {
  if (!snap.layouts.some((l) => l.id === id)) return
  for (const l of snap.layouts) {
    const want = l.id === id
    if (l.isDefault !== want) commitLayout(l.id, (x) => ({ ...x, isDefault: want }))
  }
}

/** Start a new layout from a preset (presets are starting points; the current board is untouched). */
export function newLayoutFromPreset(preset: PresetId): HomeLayout {
  const taken = new Set(snap.layouts.map((l) => l.name))
  let name = PRESETS[preset].name
  for (let i = 2; taken.has(name); i += 1) name = `${PRESETS[preset].name} ${i}`
  const l = layoutFromPreset(preset, { name, now: new Date(deps?.now() ?? Date.now()) })
  insertLayout(l)
  return l
}

/** Reset the active layout to the preset it came from (or Command). Keeps its id, name and default flag. */
export function resetActiveLayout(): void {
  const cur = activeLayout()
  if (!cur) return
  const fresh = layoutFromPreset(cur.preset ?? 'command', { now: new Date(deps?.now() ?? Date.now()) })
  commitLayout(cur.id, (l) => ({ ...l, widgets: fresh.widgets, primaryFamily: fresh.primaryFamily, preset: fresh.preset }))
}

export const __boardTest = {
  reset: () => { snap = EMPTY; deps = null; synced = new Set(); dirty.clear(); deleted.clear(); if (saveTimer) clearTimeout(saveTimer); saveTimer = null; bootToken += 1; freshId = null },
  state: () => ({ synced: [...synced], dirty: [...dirty], deleted: [...deleted] }),
}
