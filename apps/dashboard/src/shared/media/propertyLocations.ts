/**
 * Property coordinate recovery for media surfaces.
 *
 * WHY THIS EXISTS
 * ---------------
 * `v_universal_inbox_threads` — the view the inbox list reads — carries
 * `property_id` but has **no `latitude`/`longitude` columns at all**, and the
 * inbox mapper defaults missing coordinates to `0`. Every inbox row therefore
 * reached the media layer with no usable location and fell back to geocoding an
 * address string that the data layer had already collapsed to "No Address".
 *
 * The `properties` table does carry `latitude`, `longitude` and
 * `property_address_full` for these same ids. This module batches those lookups
 * so media surfaces can key on real coordinates. It is read-only, request-
 * coalesced, and cached for the session.
 *
 * This is a media-layer recovery, not a substitute for the data layer emitting
 * coordinates. See the Lane C request in the lane report.
 */
import { getSupabaseClient, hasSupabaseEnv } from '../../lib/supabaseClient'

export interface PropertyLocation {
  propertyId: string
  lat: number | null
  lng: number | null
  address: string | null
  streetviewImage: string | null
}

const cache = new Map<string, PropertyLocation | null>()
const subscribers = new Set<() => void>()

let pending = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let inflight = 0

const BATCH_WINDOW_MS = 60
const BATCH_MAX = 100

function notify() {
  for (const fn of subscribers) fn()
}

export function subscribeToPropertyLocations(fn: () => void): () => void {
  subscribers.add(fn)
  return () => {
    subscribers.delete(fn)
  }
}

/** Synchronous read. `undefined` = not looked up yet, `null` = looked up, absent. */
export function peekPropertyLocation(
  propertyId: string | number | null | undefined,
): PropertyLocation | null | undefined {
  if (!propertyId) return null
  return cache.get(String(propertyId))
}

async function flush() {
  flushTimer = null
  if (!pending.size) return
  const ids = [...pending].slice(0, BATCH_MAX)
  pending = new Set([...pending].slice(BATCH_MAX))
  if (pending.size && !flushTimer) flushTimer = setTimeout(flush, BATCH_WINDOW_MS)

  if (!hasSupabaseEnv) {
    for (const id of ids) cache.set(id, null)
    notify()
    return
  }

  inflight += 1
  try {
    const { data, error } = await getSupabaseClient()
      .from('properties')
      .select('property_id, latitude, longitude, property_address_full, streetview_image')
      .in('property_id', ids)

    if (error) {
      // Mark as resolved-absent so we do not hammer a failing endpoint per row.
      for (const id of ids) if (!cache.has(id)) cache.set(id, null)
      notify()
      return
    }

    const seen = new Set<string>()
    for (const row of data ?? []) {
      const id = String((row as Record<string, unknown>).property_id ?? '')
      if (!id) continue
      seen.add(id)
      const latRaw = (row as Record<string, unknown>).latitude
      const lngRaw = (row as Record<string, unknown>).longitude
      cache.set(id, {
        propertyId: id,
        lat: typeof latRaw === 'number' ? latRaw : latRaw == null ? null : Number(latRaw),
        lng: typeof lngRaw === 'number' ? lngRaw : lngRaw == null ? null : Number(lngRaw),
        address: (row as Record<string, unknown>).property_address_full
          ? String((row as Record<string, unknown>).property_address_full)
          : null,
        streetviewImage: (row as Record<string, unknown>).streetview_image
          ? String((row as Record<string, unknown>).streetview_image)
          : null,
      })
    }
    for (const id of ids) if (!seen.has(id)) cache.set(id, null)
    notify()
  } catch {
    for (const id of ids) if (!cache.has(id)) cache.set(id, null)
    notify()
  } finally {
    inflight -= 1
  }
}

/** Queue a property id for the next batch. Safe to call on every render. */
export function requestPropertyLocation(propertyId: string | number | null | undefined) {
  if (!propertyId) return
  const id = String(propertyId).trim()
  if (!id || cache.has(id) || pending.has(id)) return
  pending.add(id)
  if (!flushTimer) flushTimer = setTimeout(flush, BATCH_WINDOW_MS)
}

/** Test/diagnostic hook. */
export function propertyLocationStats() {
  return { cached: cache.size, pending: pending.size, inflight }
}
