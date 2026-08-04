/**
 * The single Google Maps URL builder for property media (constitution R13.12).
 *
 * There is no hardcoded API key here or anywhere downstream. When the key is
 * absent every builder returns `null` and callers surface `KEY_MISSING` — a
 * truthful state — instead of silently falling back to a literal.
 */
import type { PropertyMediaIdentity } from './types'

function readEnvKey(): string | null {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    const key = env?.VITE_GOOGLE_MAPS_API_KEY?.trim()
    return key ? key : null
  } catch {
    return null
  }
}

let cachedKey: string | null | undefined

/** `null` means the build has no Maps key — callers must report KEY_MISSING. */
export function getMapsApiKey(): string | null {
  if (cachedKey === undefined) cachedKey = readEnvKey()
  return cachedKey
}

export function hasMapsApiKey(): boolean {
  return getMapsApiKey() != null
}

/** Pixel sizes we actually request, per surface. Google caps free tier at 640. */
export type MediaSizeName = 'thumb' | 'card' | 'hero' | 'full'

const SIZE_PX: Record<MediaSizeName, { w: number; h: number; scale: 1 | 2 }> = {
  // 54px-tall inbox row slot. Requesting 1280x800 for this (the old behaviour,
  // caused by a `.replace('600x300', …)` that never matched `size=640x400`)
  // downloaded ~24x more bytes than the slot can display.
  thumb: { w: 240, h: 176, scale: 1 },
  card: { w: 400, h: 260, scale: 2 },
  hero: { w: 640, h: 400, scale: 2 },
  full: { w: 640, h: 480, scale: 2 },
}

function locationParam(identity: PropertyMediaIdentity): string | null {
  if (identity.lat != null && identity.lng != null) return `${identity.lat},${identity.lng}`
  if (identity.address) return identity.address
  return null
}

/**
 * Static Street View image URL.
 *
 * `return_error_code=true` is mandatory. Without it the Street View Static API
 * answers "no imagery at this location" with **HTTP 200 and a plain grey
 * tile** — the `<img>` fires `onLoad`, no error handler runs, and the grey tile
 * gets cached as a success. That single missing parameter is why every inbox
 * row rendered a blank grey rectangle.
 */
export function buildStreetImageUrl(
  identity: PropertyMediaIdentity,
  size: MediaSizeName = 'card',
): string | null {
  const key = getMapsApiKey()
  if (!key) return null
  const location = locationParam(identity)
  if (!location) return null
  const dims = SIZE_PX[size]
  const params = new URLSearchParams({
    size: `${dims.w}x${dims.h}`,
    location,
    fov: '80',
    heading: '210',
    pitch: '2',
    scale: String(dims.scale),
    return_error_code: 'true',
    key,
  })
  return `https://maps.googleapis.com/maps/api/streetview?${params.toString()}`
}

/** Static aerial (satellite) image URL. */
export function buildAerialImageUrl(
  identity: PropertyMediaIdentity,
  size: MediaSizeName = 'card',
): string | null {
  const key = getMapsApiKey()
  if (!key) return null
  const location = locationParam(identity)
  if (!location) return null
  const dims = SIZE_PX[size]
  const params = new URLSearchParams({
    size: `${dims.w}x${dims.h}`,
    maptype: 'satellite',
    scale: String(dims.scale),
    zoom: '19',
    center: location,
    key,
  })
  return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`
}

/** Free metadata probe — tells us *why* imagery is missing before we request it. */
export function buildStreetMetadataUrl(identity: PropertyMediaIdentity): string | null {
  const key = getMapsApiKey()
  if (!key) return null
  const location = locationParam(identity)
  if (!location) return null
  const params = new URLSearchParams({ location, key })
  return `https://maps.googleapis.com/maps/api/streetview/metadata?${params.toString()}`
}

/** Interactive Street View embed — the fallback when the JS SDK cannot mount. */
export function buildStreetEmbedUrl(identity: PropertyMediaIdentity): string | null {
  const key = getMapsApiKey()
  if (!key) return null
  const location = locationParam(identity)
  if (!location) return null
  const params = new URLSearchParams({
    key,
    location,
    heading: '210',
    pitch: '2',
    fov: '85',
  })
  return `https://www.google.com/maps/embed/v1/streetview?${params.toString()}`
}

/** Deep links an operator can open in a new tab. */
export function buildExternalMapsLink(identity: PropertyMediaIdentity): string | null {
  const location = locationParam(identity)
  if (!location) return null
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`
}
