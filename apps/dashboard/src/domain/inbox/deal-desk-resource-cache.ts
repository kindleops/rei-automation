/**
 * Deal Desk resource caches — one cache per resource, keyed by that resource's own
 * stable identity.
 *
 * Audit background (docs/audits/DEAL_DESK_FRONTEND_RUNTIME_AUDIT.md §C.1 / §I.1):
 *   "`selected` memo depends on `threads` and `filtered` … new `selected` object on every
 *   15s poll and every realtime event ⇒ `canonicalSelectedContext` → `workspaceThread` →
 *   `IntelligencePanel` full re-render (6,099-line component, unmemoised)."
 *
 * Replacing one giant workspace object with per-resource caches means:
 *   - switching threads on the same property is a property-cache hit (no refetch, no
 *     media remount),
 *   - a Deal Intelligence failure cannot evict the conversation,
 *   - a conversation refresh cannot remount the property hero.
 *
 * Each entry is a `HydrationState<T>`, so the "never erase valid data" invariant is
 * inherited rather than reimplemented per resource.
 *
 * Pure and dependency-free — testable under `node --test`.
 */

import {
  beginHydration,
  commitHydration,
  failHydration,
  idleHydration,
  seedHydration,
  type HydrationState,
} from './hydration-state'

export interface ResourceCache<T> {
  get(key: string): HydrationState<T>
  /** Data only, or null. Convenience for render paths. */
  peek(key: string): T | null
  has(key: string): boolean
  begin(key: string): HydrationState<T>
  commit(key: string, data: T): HydrationState<T>
  fail(key: string, error: Error): HydrationState<T>
  seed(key: string, data: T): HydrationState<T>
  /** Explicit removal. Never called by a refresh or a failure. */
  drop(key: string): void
  clear(): void
  size(): number
  keys(): string[]
  /** LRU-ish trim so long sessions do not grow unbounded. Keeps `retain` keys. */
  trim(maxEntries: number, retain?: readonly string[]): number
}

const normalizeKey = (key: string): string => String(key ?? '').trim()

export function createResourceCache<T>(): ResourceCache<T> {
  // Map preserves insertion order; re-inserting on access gives us recency ordering.
  const entries = new Map<string, HydrationState<T>>()

  const read = (key: string): HydrationState<T> => entries.get(normalizeKey(key)) ?? idleHydration<T>()

  const write = (key: string, state: HydrationState<T>): HydrationState<T> => {
    const normalized = normalizeKey(key)
    if (!normalized) return state
    entries.delete(normalized)
    entries.set(normalized, state)
    return state
  }

  return {
    get: read,
    peek: (key) => read(key).data,
    has: (key) => entries.has(normalizeKey(key)),
    begin: (key) => write(key, beginHydration(read(key))),
    commit: (key, data) => write(key, commitHydration(data)),
    fail: (key, error) => write(key, failHydration(read(key), error)),
    seed: (key, data) => write(key, seedHydration(data)),
    drop: (key) => {
      entries.delete(normalizeKey(key))
    },
    clear: () => entries.clear(),
    size: () => entries.size,
    keys: () => Array.from(entries.keys()),
    trim: (maxEntries, retain = []) => {
      if (entries.size <= maxEntries) return 0
      const retained = new Set(retain.map(normalizeKey).filter(Boolean))
      let removed = 0
      for (const key of Array.from(entries.keys())) {
        if (entries.size <= maxEntries) break
        if (retained.has(key)) continue
        entries.delete(key)
        removed += 1
      }
      return removed
    },
  }
}

// ── Cache key builders ───────────────────────────────────────────────────────
// Each resource is keyed by its OWN identity, never by the selected thread, so the caches
// are independent. Property, prospect, intelligence and media identifiers are never
// substituted for one another: a null identity yields a null key and the caller must
// treat that as "not loadable", not as a cache miss on an empty-string key.

/** Conversation/messages — keyed by the canonical selection key. */
export const conversationCacheKey = (selectionKey: string | null | undefined): string | null => {
  const key = normalizeKey(String(selectionKey ?? ''))
  return key || null
}

/** Property facts — keyed by property id only. Shared across every thread on it. */
export const propertyCacheKey = (propertyId: string | null | undefined): string | null => {
  const key = normalizeKey(String(propertyId ?? ''))
  return key ? `property:${key}` : null
}

/**
 * Prospect/contact — keyed by prospect id when known, otherwise by the canonical phone.
 * The two are kept distinct in the key so a phone is never mistaken for a prospect id.
 */
export const prospectCacheKey = (
  prospectId: string | null | undefined,
  canonicalPhone: string | null | undefined,
): string | null => {
  const id = normalizeKey(String(prospectId ?? ''))
  if (id) return `prospect:${id}`
  const phone = normalizeKey(String(canonicalPhone ?? ''))
  return phone ? `prospect_phone:${phone}` : null
}

/** Deal Intelligence — keyed by property plus the analysis version it was computed for. */
export const intelligenceCacheKey = (
  propertyId: string | null | undefined,
  analysisVersion: string | null | undefined,
): string | null => {
  const key = normalizeKey(String(propertyId ?? ''))
  if (!key) return null
  const version = normalizeKey(String(analysisVersion ?? '')) || 'default'
  return `intel:${key}:${version}`
}

/** Property media — keyed by stable property/media identity, never by thread or row. */
export const propertyMediaCacheKey = (
  propertyId: string | null | undefined,
  mediaRef: string | null | undefined,
): string | null => {
  const key = normalizeKey(String(propertyId ?? ''))
  if (!key) return null
  const ref = normalizeKey(String(mediaRef ?? '')) || 'default'
  return `media:${key}:${ref}`
}

/** Participants graph — keyed by property id (the route's own parameter). */
export const participantsCacheKey = (propertyId: string | null | undefined): string | null => {
  const key = normalizeKey(String(propertyId ?? ''))
  return key ? `participants:${key}` : null
}
