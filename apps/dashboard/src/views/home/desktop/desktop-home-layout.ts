import { useCallback, useSyncExternalStore } from 'react'

/**
 * The desktop Home dashboard's arrangement: which widgets, in what order, how
 * wide. Per browser. A widget id this build no longer knows is dropped on read;
 * a new widget is not forced onto anyone's board — it waits in the catalog.
 */

export type WidgetId =
  | 'status' | 'today' | 'focus' | 'replies' | 'pipeline' | 'campaigns'
  | 'agenda' | 'closings' | 'markets' | 'activity' | 'windows'

export type WidgetSize = 4 | 6 | 8 | 12

export interface WidgetSlot { id: WidgetId; w: WidgetSize }

export const WIDGETS: Record<WidgetId, { title: string; hint: string; rows: number; w: WidgetSize }> = {
  status: { title: 'System', hint: 'Engine state and today’s sends', rows: 2, w: 4 },
  today: { title: 'Today', hint: 'Sent, delivered, replies, failures', rows: 2, w: 8 },
  focus: { title: 'Needs you', hint: 'Everything waiting on the operator, ranked', rows: 4, w: 6 },
  replies: { title: 'New replies', hint: 'Sellers who answered, newest first', rows: 4, w: 6 },
  pipeline: { title: 'Pipeline', hint: 'Deals in motion by stage', rows: 3, w: 6 },
  campaigns: { title: 'Campaigns', hint: 'Live, paused and needing attention', rows: 3, w: 6 },
  agenda: { title: 'Agenda', hint: 'Today and the next two days', rows: 3, w: 4 },
  closings: { title: 'Closings', hint: 'Under contract and closing this week', rows: 3, w: 4 },
  markets: { title: 'Markets', hint: 'Where replies are coming from', rows: 3, w: 4 },
  activity: { title: 'Activity', hint: 'What just happened, across the system', rows: 4, w: 6 },
  windows: { title: 'Contact windows', hint: 'Local time and seller contact state by zone', rows: 2, w: 6 },
}

export const DEFAULT_LAYOUT: WidgetSlot[] = [
  { id: 'status', w: 4 },
  { id: 'today', w: 8 },
  { id: 'focus', w: 6 },
  { id: 'replies', w: 6 },
  { id: 'pipeline', w: 6 },
  { id: 'campaigns', w: 6 },
  { id: 'agenda', w: 4 },
  { id: 'closings', w: 4 },
  { id: 'markets', w: 4 },
  { id: 'activity', w: 6 },
  { id: 'windows', w: 6 },
]

const KEY = 'nexus.desktop.home.layout'
const SIZES: WidgetSize[] = [4, 6, 8, 12]

function read(): WidgetSlot[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null') as unknown
    if (!Array.isArray(raw)) return DEFAULT_LAYOUT
    const seen = new Set<string>()
    const out: WidgetSlot[] = []
    for (const r of raw) {
      const id = (r as { id?: string })?.id
      const w = Number((r as { w?: number })?.w)
      if (!id || !(id in WIDGETS) || seen.has(id)) continue
      seen.add(id)
      out.push({ id: id as WidgetId, w: (SIZES.includes(w as WidgetSize) ? w : WIDGETS[id as WidgetId].w) as WidgetSize })
    }
    return out
  } catch {
    return DEFAULT_LAYOUT
  }
}

let layout: WidgetSlot[] = typeof window === 'undefined' ? DEFAULT_LAYOUT : read()
const listeners = new Set<() => void>()
function commit(next: WidgetSlot[]) {
  layout = next
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* private mode */ }
  listeners.forEach((l) => l())
}
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
const snapshot = () => layout

export function useDesktopHomeLayout() {
  const slots = useSyncExternalStore(subscribe, snapshot, snapshot)
  const move = useCallback((id: WidgetId, beforeId: WidgetId | null) => {
    const cur = snapshot()
    const item = cur.find((s) => s.id === id)
    if (!item || id === beforeId) return
    const rest = cur.filter((s) => s.id !== id)
    const at = beforeId ? rest.findIndex((s) => s.id === beforeId) : rest.length
    rest.splice(at < 0 ? rest.length : at, 0, item)
    commit(rest)
  }, [])
  const resize = useCallback((id: WidgetId, w: WidgetSize) => commit(snapshot().map((s) => (s.id === id ? { ...s, w } : s))), [])
  const remove = useCallback((id: WidgetId) => commit(snapshot().filter((s) => s.id !== id)), [])
  const add = useCallback((id: WidgetId) => { if (!snapshot().some((s) => s.id === id)) commit([...snapshot(), { id, w: WIDGETS[id].w }]) }, [])
  const reset = useCallback(() => commit(DEFAULT_LAYOUT), [])
  return { slots, move, resize, remove, add, reset }
}
