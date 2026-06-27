/**
 * Comp Intelligence V4 — property media resolution.
 *
 * Priority (per spec):
 *   1. Approved server-provided media (candidate `raw.streetview_image`)
 *   2. Env-keyed Google Street View (same format as the approved
 *      `buildStreetViewUrl` helper) — key comes from VITE_GOOGLE_MAPS_API_KEY,
 *      never hardcoded.
 *   3. Designed fallback (handled by the <PropertyMedia> component)
 *
 * Implemented self-contained (safe `import.meta.env` access) so the pure adapter
 * can be unit-tested under node:test without a Vite runtime. Legally required
 * provider attribution is rendered by the media component, never stripped.
 */

type Raw = Record<string, unknown>

function envKey(): string | null {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    return env?.VITE_GOOGLE_MAPS_API_KEY ?? null
  } catch {
    return null
  }
}

function str(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s.length ? s : null
}

function buildStreetView(address: string | null, lat: number | null, lng: number | null): string | null {
  const key = envKey()
  if (!key) return null
  const hasCoords =
    Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(Number(lat)) > 0.001 && Math.abs(Number(lng)) > 0.001
  const location = hasCoords ? `${lat},${lng}` : address ? encodeURIComponent(address) : null
  if (!location) return null
  return `https://maps.googleapis.com/maps/api/streetview?size=600x400&location=${location}&fov=80&key=${key}`
}

/** Resolve the best media URL for a discovery candidate raw record. */
export function resolveCompMediaUrl(
  raw: Raw | null | undefined,
  address: string | null,
  lat: number | null,
  lng: number | null,
): string | null {
  const server = str(raw?.streetview_image)
  if (server) return server
  return buildStreetView(address, lat, lng)
}

/** Resolve the best media URL for the subject property. */
export function resolveSubjectMediaUrl(
  address: string | null,
  lat: number | null,
  lng: number | null,
): string | null {
  return buildStreetView(address, lat, lng)
}
