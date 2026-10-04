/**
 * Multi-Inbox state per Inbox instance: full state in memory for the session
 * (so 4 → 2 → 4 restores everything, conversations and searches included),
 * the sanitised part (count, order, sizes, lenses, filters, sort, labels)
 * persisted per workspace instance.
 *
 * Persistence follows the shell's own pattern for app-owned instance state
 * (Browser keeps its document under an id the instance names): the key is the
 * workspace instance id, so two Inbox instances in two saved workspaces keep
 * their own layouts. Storage unavailable → the layout still applies this session.
 */
import { useCallback, useSyncExternalStore } from 'react'
import { fromPersisted, toPersisted, type MultiInboxState } from './multi-inbox-model'

const PREFIX = 'lc.inbox.multi.v1:'
const memory = new Map<string, MultiInboxState>()
const listeners = new Set<() => void>()

export const storageKeyFor = (instanceId: string | null | undefined) => `${PREFIX}${instanceId || 'main'}`

function read(key: string): MultiInboxState {
  const hit = memory.get(key)
  if (hit) return hit
  let state: MultiInboxState
  try {
    const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(key)
    state = fromPersisted(raw ? JSON.parse(raw) : null)
  } catch {
    state = fromPersisted(null)
  }
  memory.set(key, state)
  return state
}

let writeTimer: ReturnType<typeof setTimeout> | null = null
const pendingWrites = new Map<string, MultiInboxState>()

function write(key: string, next: MultiInboxState) {
  memory.set(key, next)
  pendingWrites.set(key, next)
  // resize drags emit many states; persist the last one
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    writeTimer = null
    for (const [k, v] of pendingWrites) {
      try { window.localStorage.setItem(k, JSON.stringify(toPersisted(v))) } catch { /* storage unavailable */ }
    }
    pendingWrites.clear()
  }, 250)
  listeners.forEach((l) => l())
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useMultiInboxState(instanceId: string | null | undefined): [MultiInboxState, (fn: (s: MultiInboxState) => MultiInboxState) => void] {
  const key = storageKeyFor(instanceId)
  const state = useSyncExternalStore(subscribe, () => read(key), () => read(key))
  const update = useCallback((fn: (s: MultiInboxState) => MultiInboxState) => {
    const current = read(key)
    const next = fn(current)
    if (next !== current) write(key, next)
  }, [key])
  return [state, update]
}

/** Test seam. */
export function __resetMultiInboxStore() {
  memory.clear()
  pendingWrites.clear()
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = null
}
