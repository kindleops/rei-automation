/**
 * Stable media identity (constitution R13.1).
 *
 * Media is keyed ONLY by normalized coordinates or a stable property id — never
 * by array index, thread id, pane width, or any unrelated state. This file is
 * the single place that decides whether a coordinate pair is real.
 */
import type { PropertyMediaIdentity } from './types'

/**
 * Address sentinels that the data layer emits when it could not resolve an
 * address. They are truthy strings, so without this list they get geocoded
 * literally — which is exactly how "No Address" ended up being sent to Google.
 * (Root-cause register RC-1c / RC-2.)
 */
const ADDRESS_SENTINELS = new Set([
  'no address',
  'unknown',
  'unknown address',
  'n/a',
  'na',
  '--',
  '—',
  'null',
  'undefined',
])

/** Minimum absolute magnitude for a coordinate to be considered real data. */
const COORD_EPSILON = 1e-6

export function normalizeAddress(value: unknown): string | null {
  if (value == null) return null
  const trimmed = String(value).trim()
  if (trimmed.length < 5) return null
  if (ADDRESS_SENTINELS.has(trimmed.toLowerCase())) return null
  return trimmed
}

/**
 * Accepts a coordinate pair only when both values are real.
 *
 * Rejects the `0` sentinel that the inbox data layer emits as its default
 * (`asNumber(row.lat ?? row.latitude, 0)`), which is finite and therefore
 * passed every previous `Number.isFinite` guard. Null island (0, 0) is not a
 * property location; treating it as one is what routed every inbox row to
 * fuzzy address geocoding.
 */
export function normalizeCoords(
  lat: unknown,
  lng: unknown,
): { lat: number; lng: number } | null {
  const nLat = typeof lat === 'string' ? Number(lat) : (lat as number)
  const nLng = typeof lng === 'string' ? Number(lng) : (lng as number)
  if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) return null
  if (Math.abs(nLat) > 90 || Math.abs(nLng) > 180) return null
  // Null island / unset sentinel.
  if (Math.abs(nLat) < COORD_EPSILON && Math.abs(nLng) < COORD_EPSILON) return null
  // A lone zeroed axis is a partially-populated row, not a location.
  if (Math.abs(nLat) < COORD_EPSILON || Math.abs(nLng) < COORD_EPSILON) return null
  return { lat: nLat, lng: nLng }
}

/** 5 decimals ≈ 1.1 m — precise enough to identify a parcel, coarse enough to dedupe. */
function coordKey(lat: number, lng: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`
}

export interface IdentityInput {
  propertyId?: string | number | null
  address?: string | null
  lat?: number | string | null
  lng?: number | string | null
  storedStreetUrl?: string | null
  storedAerialUrl?: string | null
}

/**
 * Build the stable identity for a media surface.
 *
 * Key preference order: normalized coordinates → property id → normalized
 * address. All three are stable across theme changes, pane resizes, scrolls and
 * list recycling, which is what R13.2 requires.
 */
export function buildMediaIdentity(input: IdentityInput): PropertyMediaIdentity {
  const coords = normalizeCoords(input.lat, input.lng)
  const address = normalizeAddress(input.address)
  const propertyId = input.propertyId == null ? null : String(input.propertyId).trim() || null

  // Key on what we will actually ask the provider for, so the key changes the
  // moment the resolvable location changes.
  //
  // `pid:` deliberately ranks BELOW `addr:`. Ranking it above meant a record
  // whose address arrived a tick after its id kept the same key forever: the
  // per-key state never re-synced, so the "nothing to ask about yet" verdict
  // stuck permanently — and got cached for the full TTL. A bare `pid:` key now
  // means exactly one thing: we hold an identity but no location for it yet.
  let key: string
  if (coords) key = `geo:${coordKey(coords.lat, coords.lng)}`
  else if (address) key = `addr:${address.toLowerCase()}`
  else if (propertyId) key = `pid:${propertyId}`
  else key = 'none'

  return {
    key,
    lat: coords?.lat ?? null,
    lng: coords?.lng ?? null,
    address,
    storedStreetUrl: normalizeStoredUrl(input.storedStreetUrl),
    storedAerialUrl: normalizeStoredUrl(input.storedAerialUrl),
  }
}

function normalizeStoredUrl(value: unknown): string | null {
  if (value == null) return null
  const trimmed = String(value).trim()
  if (!trimmed) return null
  if (!/^https?:\/\//i.test(trimmed)) return null
  return trimmed
}

/** True when the identity carries something Google can actually resolve. */
export function hasResolvableLocation(identity: PropertyMediaIdentity): boolean {
  return identity.lat != null || Boolean(identity.address)
}

/**
 * True when we hold an identity but no location for it — i.e. a lookup is
 * still possible and "no coordinates" is not yet a settled answer.
 */
export function isAwaitingLocation(identity: PropertyMediaIdentity): boolean {
  return identity.key.startsWith('pid:')
}
