import { useEffect, useSyncExternalStore } from 'react'
import { readWatchlist, toggleWatch as apiToggle, unwatchEntity, watchEntity, type WatchEntityType, type WatchlistEntry, type WatchlistTogglePayload } from './watchlistData'

/**
 * ONE watchlist in the browser — the Inbox WatchBell, the Universal Inspector
 * "Watch" action and the Signals panel read the same store, so watching in one
 * place shows everywhere. Keys are canonical: a thread is a seller, and a legacy
 * 'phone:' prefix is dropped (`seller:+15550001111`).
 */

export type WatchStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface WatchState {
  status: WatchStatus
  items: WatchlistEntry[]
  keys: ReadonlySet<string>
  supportedTypes: ReadonlyArray<WatchEntityType>
  /** keys with a write in flight */
  pending: ReadonlySet<string>
  error: string | null
  updatedAt: number | null
}

export const canonicalWatchKey = (type: string, id: string) => {
  const t = type === 'thread' ? 'seller' : type
  const v = String(id ?? '').trim()
  return `${t}:${t === 'seller' ? v.replace(/^phone:/i, '') : v}`
}

const keysOf = (items: WatchlistEntry[]) => new Set(items.map((w) => canonicalWatchKey(w.entity_type || w.watch_type, w.entity_id || w.watch_key)))

let state: WatchState = { status: 'idle', items: [], keys: new Set(), supportedTypes: [], pending: new Set(), error: null, updatedAt: null }
const listeners = new Set<() => void>()
const set = (patch: Partial<WatchState>) => { state = { ...state, ...patch }; for (const l of listeners) l() }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

let inflight: Promise<void> | null = null

export function loadWatches(force = false): Promise<void> {
  if (inflight) return inflight
  if (!force && state.status === 'ready') return Promise.resolve()
  set({ status: state.status === 'ready' ? 'ready' : 'loading', error: null })
  inflight = readWatchlist().then(
    (r) => set({ status: 'ready', items: r.items, keys: keysOf(r.items), supportedTypes: r.supportedTypes, updatedAt: Date.now() }),
    (e: unknown) => set({ status: 'error', error: e instanceof Error ? e.message : 'Watches could not be read.' }),
  ).finally(() => { inflight = null })
  return inflight
}

function withPending(key: string, on: boolean) {
  const next = new Set(state.pending)
  if (on) next.add(key)
  else next.delete(key)
  set({ pending: next })
}

/** Watch / unwatch one subject. Optimistic; the server answer wins; failures roll back and rethrow. */
export async function setWatched(type: WatchEntityType, id: string, watched: boolean, extra: { label?: string | null; address?: string | null } = {}) {
  const key = canonicalWatchKey(type, id)
  const before = state.keys
  const optimistic = new Set(before)
  if (watched) optimistic.add(key)
  else optimistic.delete(key)
  set({ keys: optimistic })
  withPending(key, true)
  try {
    if (watched) await watchEntity(type, id, extra)
    else await unwatchEntity(type, id)
    await loadWatches(true)
  } catch (e) {
    set({ keys: before })
    throw e
  } finally {
    withPending(key, false)
  }
}

/** Legacy toggle payload (Inbox WatchBell). */
export async function toggleLegacyWatch(payload: WatchlistTogglePayload) {
  const key = canonicalWatchKey(payload.watch_type, payload.watch_key)
  const before = state.keys
  const optimistic = new Set(before)
  if (optimistic.has(key)) optimistic.delete(key)
  else optimistic.add(key)
  set({ keys: optimistic })
  try {
    await apiToggle(payload)
    await loadWatches(true)
  } catch {
    set({ keys: before })
  }
}

export const getWatchState = () => state

export function useWatches(): WatchState {
  const s = useSyncExternalStore(subscribe, () => state, () => state)
  useEffect(() => { void loadWatches() }, [])
  return s
}

/** test seam */
export function __resetWatchStore() { state = { status: 'idle', items: [], keys: new Set(), supportedTypes: [], pending: new Set(), error: null, updatedAt: null }; inflight = null }
