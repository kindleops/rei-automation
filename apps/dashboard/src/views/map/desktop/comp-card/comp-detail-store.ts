/**
 * ONE keyed request per comp click.
 *
 *   request(id)  starts get_map_sold_comp(id) unless this id is already
 *                loaded or in flight; any OTHER in-flight read is aborted
 *                (the operator clicked on — a stale answer never paints)
 *   cancel(id)   aborts that id's read if it is still in flight
 *   retain(id)   request + a release that cancels once nothing holds the id
 *                (deferred a tick, so a remount — StrictMode — reuses the read)
 *   peek(id)     the cached record (the hover preview reads it; no I/O)
 *
 * The fetcher is injected so tests run without a network; the app wires
 * loadCompDetail (supabase rpc + abortSignal). Results are kept in a small
 * LRU so re-opening a comp is instant and costs nothing.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { CompRecord } from './comp-card-model'

export type CompDetailFetcher = (compId: string, signal: AbortSignal) => Promise<CompRecord | null>

export type CompDetailEntry =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: CompRecord }
  | { status: 'error' }

const IDLE: CompDetailEntry = { status: 'idle' }
const LOADING: CompDetailEntry = { status: 'loading' }
const ERROR: CompDetailEntry = { status: 'error' }

export interface CompDetailStore {
  request(id: string): void
  cancel(id: string): void
  retain(id: string): () => void
  get(id: string | null): CompDetailEntry
  peek(id: string | null | undefined): CompRecord | null
  subscribe(fn: () => void): () => void
}

export function createCompDetailStore(fetcher: CompDetailFetcher, max = 40): CompDetailStore {
  const entries = new Map<string, CompDetailEntry>()
  const inflight = new Map<string, AbortController>()
  const subs = new Set<() => void>()
  const refs = new Map<string, number>()
  const emit = () => subs.forEach((fn) => fn())
  const put = (id: string, e: CompDetailEntry) => {
    entries.delete(id)
    entries.set(id, e)
    while (entries.size > max) {
      const oldest = entries.keys().next().value as string
      if (inflight.has(oldest)) break
      entries.delete(oldest)
    }
    emit()
  }
  const abort = (id: string) => {
    const ctl = inflight.get(id)
    if (!ctl) return
    inflight.delete(id)
    ctl.abort()
    if (entries.get(id)?.status === 'loading') entries.delete(id)
  }
  const store: CompDetailStore = {
    retain(id) {
      refs.set(id, (refs.get(id) ?? 0) + 1)
      store.request(id)
      let released = false
      return () => {
        if (released) return
        released = true
        refs.set(id, Math.max(0, (refs.get(id) ?? 1) - 1))
        setTimeout(() => { if (!refs.get(id)) store.cancel(id) }, 0)
      }
    },
    request(id) {
      for (const other of [...inflight.keys()]) if (other !== id) abort(other)
      const cur = entries.get(id)
      if (cur && (cur.status === 'ready' || cur.status === 'loading')) return
      const ctl = new AbortController()
      inflight.set(id, ctl)
      put(id, LOADING)
      fetcher(id, ctl.signal).then(
        (data) => {
          if (ctl.signal.aborted || inflight.get(id) !== ctl) return
          inflight.delete(id)
          put(id, data ? { status: 'ready', data } : ERROR)
        },
        () => {
          if (ctl.signal.aborted || inflight.get(id) !== ctl) return
          inflight.delete(id)
          put(id, ERROR)
        },
      )
    },
    cancel(id) {
      if (!inflight.has(id)) return
      abort(id)
      emit()
    },
    get(id) {
      return id ? entries.get(id) ?? IDLE : IDLE
    },
    peek(id) {
      const e = id ? entries.get(id) : undefined
      return e?.status === 'ready' ? e.data : null
    },
    subscribe(fn) {
      subs.add(fn)
      return () => { subs.delete(fn) }
    },
  }
  return store
}

/** The card's hydration: one keyed read per comp id, cancelled when the card moves on. */
export function useCompDetail(store: CompDetailStore, compId: string | null): CompDetailEntry {
  const entry = useSyncExternalStore(store.subscribe, () => store.get(compId), () => IDLE)
  useEffect(() => (compId ? store.retain(compId) : undefined), [store, compId])
  return entry
}
