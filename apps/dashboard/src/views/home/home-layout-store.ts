import { useCallback, useSyncExternalStore } from 'react'

/**
 * THE OPERATOR'S HOME LAYOUT.
 *
 * Order, visibility and density of the Home modules, persisted per device. The
 * greeting is not a module: it is always first and cannot be hidden, because a
 * Home that can be customised into a blank screen is not a Home.
 *
 * The store is deliberately forgiving on read. A module added in a later release
 * is appended to a saved order rather than silently missing, and an id that no
 * longer exists is dropped rather than rendering an empty slot. A corrupt or
 * unreadable payload (private mode, cleared storage) falls back to the default,
 * which is the layout the product is designed around.
 */

export const HOME_MODULE_IDS = [
  'automation',
  'focus',
  'actions',
  'calendar',
  'inbox',
  'campaigns',
  'deals',
  'pipeline',
  'markets',
  'activity',
] as const

export type HomeModuleId = (typeof HOME_MODULE_IDS)[number]

export interface HomeLayout {
  order: HomeModuleId[]
  hidden: HomeModuleId[]
  compact: HomeModuleId[]
}

export const HOME_MODULE_LABELS: Record<HomeModuleId, { title: string; hint: string }> = {
  focus: { title: 'Focus', hint: 'What needs you now, across every app' },
  actions: { title: 'Quick actions', hint: 'One-tap jumps into the system' },
  automation: { title: 'Automation', hint: 'Is the machine running' },
  calendar: { title: 'Calendar', hint: 'Today and the week ahead' },
  inbox: { title: 'Inbox', hint: 'Replies, priority threads and hot sellers' },
  pipeline: { title: 'Pipeline', hint: 'Where every opportunity sits' },
  campaigns: { title: 'Campaigns', hint: 'Live outreach and what needs attention' },
  deals: { title: 'Deals', hint: 'Offers, contracts and closings' },
  markets: { title: 'Market signals', hint: 'Where the activity is' },
  activity: { title: 'Live activity', hint: 'What just happened' },
}

export const DEFAULT_HOME_LAYOUT: HomeLayout = {
  order: [...HOME_MODULE_IDS],
  hidden: [],
  compact: [],
}

const STORAGE_KEY = 'nx.home-layout.v1'
const KNOWN = new Set<string>(HOME_MODULE_IDS)

const isModuleId = (value: unknown): value is HomeModuleId =>
  typeof value === 'string' && KNOWN.has(value)

const uniqueIds = (value: unknown): HomeModuleId[] => {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter(isModuleId))]
}

export function sanitizeHomeLayout(raw: unknown): HomeLayout {
  if (!raw || typeof raw !== 'object') return DEFAULT_HOME_LAYOUT
  const input = raw as Partial<Record<keyof HomeLayout, unknown>>
  const order = uniqueIds(input.order)
  for (const id of HOME_MODULE_IDS) {
    if (!order.includes(id)) order.push(id)
  }
  return {
    order,
    hidden: uniqueIds(input.hidden),
    compact: uniqueIds(input.compact),
  }
}

const listeners = new Set<() => void>()
let cached: HomeLayout | null = null

function read(): HomeLayout {
  if (cached) return cached
  try {
    const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(STORAGE_KEY)
    cached = raw ? sanitizeHomeLayout(JSON.parse(raw)) : DEFAULT_HOME_LAYOUT
  } catch {
    cached = DEFAULT_HOME_LAYOUT
  }
  return cached
}

function write(next: HomeLayout) {
  cached = next
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    /* Storage unavailable: the layout still applies for this session. */
  }
  listeners.forEach((listener) => listener())
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const toggleIn = (list: HomeModuleId[], id: HomeModuleId) =>
  list.includes(id) ? list.filter((item) => item !== id) : [...list, id]

export function moveHomeModule(layout: HomeLayout, id: HomeModuleId, delta: -1 | 1): HomeLayout {
  const index = layout.order.indexOf(id)
  const target = index + delta
  if (index < 0 || target < 0 || target >= layout.order.length) return layout
  const order = [...layout.order]
  ;[order[index], order[target]] = [order[target], order[index]]
  return { ...layout, order }
}

export function useHomeLayout() {
  const layout = useSyncExternalStore(subscribe, read, () => DEFAULT_HOME_LAYOUT)

  const move = useCallback((id: HomeModuleId, delta: -1 | 1) => write(moveHomeModule(read(), id, delta)), [])
  const toggleHidden = useCallback((id: HomeModuleId) => {
    const current = read()
    write({ ...current, hidden: toggleIn(current.hidden, id) })
  }, [])
  const toggleCompact = useCallback((id: HomeModuleId) => {
    const current = read()
    write({ ...current, compact: toggleIn(current.compact, id) })
  }, [])
  const reset = useCallback(() => write(DEFAULT_HOME_LAYOUT), [])

  return { layout, move, toggleHidden, toggleCompact, reset }
}
