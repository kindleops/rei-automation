import { useSyncExternalStore } from 'react'
import * as L from './layout'
import { appOfPath, getWorkspace, openApp } from './workspace-store'
import { sound } from '../../../shared/sound'

/**
 * DRAG AN APP INTO THE WORKSPACE.
 *
 * Click = navigate (the app opens where you are). Drag = compose (the app
 * joins what is already open). A drag only begins after the pointer travels a
 * few pixels, so a click never turns into a drop. While dragging, the
 * workspace shows where the app would land — split left / right / above /
 * below, add to the stack, or replace — with the exact resulting geometry.
 * Esc cancels. Nothing is decided here: the drop calls the workspace store.
 */

export interface DragSource {
  kind: 'app' | 'instance'
  /** route + query the app should open with (contextual when there is a selection) */
  path: string
  app: string
  label: string
  instanceId?: string
}

export interface DragSnapshot {
  active: boolean
  source: DragSource | null
  x: number
  y: number
  target: L.DropTarget | null
  /** pane rects in client coordinates, captured when the drag began */
  rects: Record<string, L.Rect>
  /** the "Replace" pill inside the hovered pane's stack zone */
  replaceRect: L.Rect | null
  /** the workspace's own rect, captured when the drag began */
  root: L.Rect | null
}

const IDLE: DragSnapshot = { active: false, source: null, x: 0, y: 0, target: null, rects: {}, replaceRect: null, root: null }
let snap: DragSnapshot = IDLE
const listeners = new Set<() => void>()
const set = (patch: Partial<DragSnapshot>) => { snap = { ...snap, ...patch }; listeners.forEach((l) => l()) }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
export const useDrag = () => useSyncExternalStore(subscribe, () => snap, () => snap)

const THRESHOLD = 5
let suppressClickUntil = 0
/** A rail row's click handler asks this first: a drag just ended, ignore the click. */
export function consumeDragClick(): boolean { return Date.now() < suppressClickUntil }

function measurePanes(): Record<string, L.Rect> {
  const out: Record<string, L.Rect> = {}
  document.querySelectorAll<HTMLElement>('[data-ws-pane]').forEach((el) => {
    const r = el.getBoundingClientRect()
    out[el.dataset.wsPane!] = { x: r.left, y: r.top, w: r.width, h: r.height }
  })
  return out
}

function workspaceRect(): L.Rect | null {
  const el = document.querySelector<HTMLElement>('[data-ws-root]')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, w: r.width, h: r.height }
}

/** Where the "Replace" pill sits inside a pane (client coords). */
export function replacePillRect(pane: L.Rect): L.Rect {
  const w = 118
  const h = 30
  return { x: pane.x + pane.w / 2 - w / 2, y: pane.y + pane.h * 0.72 - h - 8, w, h }
}

function hitTest(x: number, y: number, source: DragSource): { target: L.DropTarget | null; replaceRect: L.Rect | null } {
  const ws = getWorkspace().layout
  const rects = snap.rects
  const paneId = Object.keys(rects).find((id) => { const r = rects[id]; return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h })
  if (!paneId) return { target: null, replaceRect: null }
  const pane = L.findPane(ws.root, paneId)
  if (!pane) return { target: null, replaceRect: null }
  const targetApp = ws.instances[pane.active]?.app ?? ''
  const all = L.panes(ws.root)
  const sourcePane = source.instanceId ? L.paneOf(ws, source.instanceId) : null
  // moving an app out of a pane it has to itself frees that pane
  const visible = all.length - (sourcePane && sourcePane.tabs.length === 1 ? 1 : 0)
  const wsr = workspaceRect()
  const max = wsr ? L.maxVisiblePanes(wsr) : 4
  const rect = rects[paneId]
  const replaceRect = targetApp !== source.app ? replacePillRect(rect) : null
  const target = L.dropTargetAt(rect, { x, y }, { paneId, targetApp, newApp: source.app, visiblePanes: visible, maxPanes: max, replaceRect })
  // dropping an app onto the pane that only holds that same app does nothing
  if (sourcePane && sourcePane.id === paneId && sourcePane.tabs.length === 1) return { target: null, replaceRect: null }
  if (target.zone === 'stack' && pane.tabs.some((t) => ws.instances[t]?.app === source.app) && !sourcePane) return { target: null, replaceRect }
  return { target, replaceRect }
}

/**
 * Begin a potential drag from a pointerdown. Returns immediately; the drag
 * activates only after the threshold.
 */
export function beginDrag(e: { clientX: number; clientY: number; pointerId: number; button: number }, source: DragSource | (() => DragSource)) {
  if (e.button !== 0) return
  const sx = e.clientX
  const sy = e.clientY
  let active = false
  let resolved: DragSource | null = null

  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) return
    if (!active) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < THRESHOLD) return
      active = true
      resolved = typeof source === 'function' ? source() : source
      document.documentElement.classList.add('lc-ws-dragging')
      set({ active: true, source: resolved, x: ev.clientX, y: ev.clientY, rects: measurePanes(), target: null, replaceRect: null, root: workspaceRect() })
      sound.workspace.pickup()
    }
    const hit = hitTest(ev.clientX, ev.clientY, resolved!)
    set({ x: ev.clientX, y: ev.clientY, target: hit.target, replaceRect: hit.replaceRect })
  }

  const end = (commit: boolean) => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('keydown', key, true)
    if (!active) return
    suppressClickUntil = Date.now() + 350
    document.documentElement.classList.remove('lc-ws-dragging')
    const { target } = snap
    const src = resolved!
    set(IDLE)
    if (!commit || !target || target.blocked) { sound.workspace.cancel(); return }
    const path = src.kind === 'instance' ? (getWorkspace().layout.instances[src.instanceId!]?.path ?? src.path) : src.path
    const result = openApp(path, { pane: target.pane, zone: target.zone, share: target.share })
    if (result === 'refused') sound.workspace.cancel()
    else sound.workspace.drop(target.zone === 'stack' || target.zone === 'replace' ? 'stack' : 'split')
  }
  const up = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) end(true) }
  const cancel = () => end(false)
  const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape' && active) { ev.preventDefault(); ev.stopPropagation(); end(false) } }

  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('keydown', key, true)
}

/** The source for a rail app: contextual when the workspace has a live selection. */
export function railDragSource(route: string, label: string, contextualPath: string | null): DragSource {
  const path = contextualPath ?? route
  return { kind: 'app', path, app: appOfPath(path), label }
}
