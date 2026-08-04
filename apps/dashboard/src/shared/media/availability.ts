/**
 * Street View availability probe + session cache (constitution R13.7, R13.9).
 *
 * The Street View Static API cannot tell an `<img>` *why* it failed. The
 * metadata endpoint can, it is free of quota charge, and it answers before we
 * spend a paid image request. Every probe result is cached by the stable media
 * key with an explicit TTL, so it survives remount and route change within a
 * session — which is what stops the virtualised inbox list from re-probing the
 * same property on every scroll.
 */
import type { MediaFailureReason, PropertyMediaIdentity } from './types'
import { buildStreetMetadataUrl, getMapsApiKey } from './urls'

export type AvailabilityStatus =
  | { state: 'available'; panoDate: string | null }
  | { state: 'unavailable'; reason: MediaFailureReason }

const TTL_MS = 12 * 60 * 60 * 1000 // 12h — panorama coverage does not change hourly.
const STORAGE_PREFIX = 'lc.media.sv.v2:'
const MEMORY_LIMIT = 600

type CacheEntry = { at: number; status: AvailabilityStatus }

const memory = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<AvailabilityStatus>>()

function storageKey(key: string) {
  return `${STORAGE_PREFIX}${key}`
}

function readStore(key: string): CacheEntry | null {
  if (typeof sessionStorage === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(storageKey(key))
    if (!raw) return null
    const parsed = JSON.parse(raw) as CacheEntry
    if (!parsed?.status || typeof parsed.at !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

function writeStore(key: string, entry: CacheEntry) {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(storageKey(key), JSON.stringify(entry))
  } catch {
    /* quota — memory cache still holds it for this session */
  }
}

function fresh(entry: CacheEntry | null): AvailabilityStatus | null {
  if (!entry) return null
  if (Date.now() - entry.at > TTL_MS) return null
  return entry.status
}

/** Synchronous cache read — lets a remount paint instantly with no flash. */
export function peekAvailability(key: string): AvailabilityStatus | null {
  const hit = fresh(memory.get(key) ?? null)
  if (hit) return hit
  const stored = fresh(readStore(key))
  if (stored) {
    memory.set(key, { at: Date.now(), status: stored })
    return stored
  }
  return null
}

export function rememberAvailability(key: string, status: AvailabilityStatus) {
  const entry: CacheEntry = { at: Date.now(), status }
  memory.set(key, entry)
  if (memory.size > MEMORY_LIMIT) {
    const oldest = [...memory.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0]
    if (oldest) memory.delete(oldest)
  }
  writeStore(key, entry)
}

/** Google metadata `status` → our typed reason. */
function reasonFromStatus(status: string): MediaFailureReason {
  switch (status) {
    case 'ZERO_RESULTS':
    case 'NOT_FOUND':
      return 'NO_PANORAMA_AT_LOCATION'
    case 'OVER_QUERY_LIMIT':
      return 'PROVIDER_QUOTA'
    case 'REQUEST_DENIED':
    case 'INVALID_REQUEST':
    case 'UNKNOWN_ERROR':
      return 'PROVIDER_ERROR'
    default:
      return 'PROVIDER_ERROR'
  }
}

const PROBE_TIMEOUT_MS = 8000

/**
 * Resolve whether a panorama exists for this identity.
 *
 * Deduped per key: 30 recycled inbox rows pointing at the same property issue
 * one request, not 30.
 */
export function probeStreetAvailability(
  identity: PropertyMediaIdentity,
): Promise<AvailabilityStatus> {
  const cached = peekAvailability(identity.key)
  if (cached) return Promise.resolve(cached)

  const existing = inflight.get(identity.key)
  if (existing) return existing

  const run = (async (): Promise<AvailabilityStatus> => {
    if (!getMapsApiKey()) return { state: 'unavailable', reason: 'KEY_MISSING' }
    const url = buildStreetMetadataUrl(identity)
    if (!url) return { state: 'unavailable', reason: 'NO_COORDINATES' }

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      if (!res.ok) {
        const reason: MediaFailureReason = res.status === 403 ? 'PROVIDER_QUOTA' : 'PROVIDER_ERROR'
        return { state: 'unavailable', reason }
      }
      const body = (await res.json()) as { status?: string; date?: string }
      if (body?.status === 'OK') {
        return { state: 'available', panoDate: body.date ?? null }
      }
      return { state: 'unavailable', reason: reasonFromStatus(String(body?.status ?? '')) }
    } catch {
      // Aborted, offline, DNS, CORS — all indistinguishable from the client.
      return { state: 'unavailable', reason: 'NETWORK' }
    }
  })()
    .then((status) => {
      // A transient network failure must not be cached for 12 hours.
      if (!(status.state === 'unavailable' && status.reason === 'NETWORK')) {
        rememberAvailability(identity.key, status)
      }
      return status
    })
    .finally(() => {
      inflight.delete(identity.key)
    })

  inflight.set(identity.key, run)
  return run
}

/** Drop a cached verdict so a manual retry actually re-asks the provider (R10.6). */
export function forgetAvailability(key: string) {
  memory.delete(key)
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.removeItem(storageKey(key))
  } catch {
    /* ignore */
  }
}
