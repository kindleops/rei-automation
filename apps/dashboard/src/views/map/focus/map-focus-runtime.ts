import type maplibregl from 'maplibre-gl'
import { isUsableLngLat, type MapFocusOutcome, type MapPropertyFocus } from '../../../domain/map/map-property-focus'
import { readInspector } from '../../../modules/desktop/inspector/inspector-read'
import type { LngLat } from './focus-camera'

/**
 * How a Show on Map request becomes a canonical selection — with the honest
 * fallback chain (§3 "Missing location"):
 *
 *   1. the Map's own pin index for that property_id (what a tap would select)
 *   2. coordinates the CALLER read from a canonical source (comps carry them)
 *   3. the canonical property subject (GET /api/cockpit/properties/:id/subject
 *      → latitude/longitude, the same contract Comps and the Inspector read)
 *   4. otherwise: "Show on Map unavailable" with the reason — never a guess,
 *      never a geocode of an address string.
 *
 * Pure orchestration over injected functions, so it is tested without a map.
 */

export interface FocusResolverDeps {
  /** select from the Map's own indexes; true when it found and selected it */
  selectFromPins: (propertyId: string) => boolean
  /** select the property at canonical coordinates the Map's index does not hold */
  selectAt: (propertyId: string, at: LngLat, label: string | null) => void
  /** read canonical coordinates (null when the record has none) */
  fetchCanonical: (propertyId: string, signal: AbortSignal) => Promise<LngLat | null>
  /** wait between pin-index attempts (pins load in two stages) */
  wait: (ms: number) => Promise<void>
  /** how many times to ask the pin index before falling back */
  attempts?: number
}

export async function resolveFocusRequest(req: MapPropertyFocus, deps: FocusResolverDeps, signal: AbortSignal): Promise<MapFocusOutcome> {
  const attempts = deps.attempts ?? 8
  for (let i = 0; i < attempts; i += 1) {
    if (signal.aborted) return { seq: req.seq, status: 'unavailable', propertyId: req.propertyId, reason: 'Superseded by a newer focus' }
    if (deps.selectFromPins(req.propertyId)) return { seq: req.seq, status: 'focused', propertyId: req.propertyId, via: 'pin' }
    // the caller's canonical coordinates are as good as ours: do not make the operator wait for pins
    if (req.lat !== null && req.lng !== null) break
    if (i < attempts - 1) await deps.wait(250)
  }
  if (req.lat !== null && req.lng !== null && isUsableLngLat(req.lat, req.lng)) {
    deps.selectAt(req.propertyId, [req.lng, req.lat], req.label)
    return { seq: req.seq, status: 'focused', propertyId: req.propertyId, via: 'caller' }
  }
  let at: LngLat | null = null
  try { at = await deps.fetchCanonical(req.propertyId, signal) } catch { at = null }
  if (signal.aborted) return { seq: req.seq, status: 'unavailable', propertyId: req.propertyId, reason: 'Superseded by a newer focus' }
  if (at) {
    deps.selectAt(req.propertyId, at, req.label)
    return { seq: req.seq, status: 'focused', propertyId: req.propertyId, via: 'canonical' }
  }
  return { seq: req.seq, status: 'unavailable', propertyId: req.propertyId, reason: 'No coordinates are on record for this property' }
}

type Field = unknown
const val = (f: Field): unknown => (f && typeof f === 'object' && 'value' in (f as Record<string, unknown>) ? (f as { value: unknown }).value : f)

/** Canonical coordinates for a property (the Comps subject contract). Read-only GET. */
export async function fetchCanonicalCoordinates(propertyId: string, signal: AbortSignal): Promise<LngLat | null> {
  const body = await readInspector<{ data?: { latitude?: Field; longitude?: Field } }>(`/api/cockpit/properties/${encodeURIComponent(propertyId)}/subject`, signal)
  const lat = Number(val(body?.data?.latitude))
  const lng = Number(val(body?.data?.longitude))
  return isUsableLngLat(lat, lng) ? [lng, lat] : null
}

/* ── focus treatment: soft underlight + a small expanding halo ────────── */

const UNDERLIGHT = 'lc-focus-underlight'
const HALO = 'lc-focus-halo'
const GOLD = '#f5b02e'

/**
 * Two quiet circle layers under the selected-property star, on the star's own
 * source (so they exist exactly when the selection does and cost no extra
 * data): a blurred gold underlight, and a thin ring that expands once and
 * fades when the camera lands — the pin "resolving". No beacon, no loop.
 * Paint transitions run on the GPU; nothing re-renders.
 */
export function ensureFocusTreatment(map: maplibregl.Map, starSourceId: string, starLayerId: string): boolean {
  try {
    if (!map.getSource(starSourceId) || !map.getLayer(starLayerId)) return false
    if (!map.getLayer(UNDERLIGHT)) {
      map.addLayer({
        id: UNDERLIGHT,
        type: 'circle',
        source: starSourceId,
        paint: {
          'circle-color': GOLD,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 10, 14, 26, 17, 40],
          'circle-blur': 1,
          'circle-opacity': 0.26,
          'circle-pitch-alignment': 'map',
        },
      }, starLayerId)
    }
    if (!map.getLayer(HALO)) {
      map.addLayer({
        id: HALO,
        type: 'circle',
        source: starSourceId,
        paint: {
          'circle-color': 'rgba(0,0,0,0)',
          'circle-radius': 6,
          'circle-stroke-color': GOLD,
          'circle-stroke-width': 1.4,
          'circle-stroke-opacity': 0,
          'circle-pitch-alignment': 'map',
        },
      }, starLayerId)
    }
    return true
  } catch {
    return false
  }
}

/** The landing beat: the ring expands from the pin and fades (instant under reduced motion). */
export function pulseFocusTreatment(map: maplibregl.Map, reducedMotion: boolean): void {
  try {
    if (!map.getLayer(HALO)) return
    if (reducedMotion) {
      map.setPaintProperty(UNDERLIGHT, 'circle-opacity', 0.26)
      return
    }
    map.setPaintProperty(HALO, 'circle-radius-transition', { duration: 0, delay: 0 })
    map.setPaintProperty(HALO, 'circle-stroke-opacity-transition', { duration: 0, delay: 0 })
    map.setPaintProperty(UNDERLIGHT, 'circle-opacity-transition', { duration: 0, delay: 0 })
    map.setPaintProperty(HALO, 'circle-radius', 6)
    map.setPaintProperty(HALO, 'circle-stroke-opacity', 0.85)
    map.setPaintProperty(UNDERLIGHT, 'circle-opacity', 0)
    requestAnimationFrame(() => {
      try {
        map.setPaintProperty(HALO, 'circle-radius-transition', { duration: 720, delay: 0 })
        map.setPaintProperty(HALO, 'circle-stroke-opacity-transition', { duration: 720, delay: 0 })
        map.setPaintProperty(UNDERLIGHT, 'circle-opacity-transition', { duration: 420, delay: 80 })
        map.setPaintProperty(HALO, 'circle-radius', 30)
        map.setPaintProperty(HALO, 'circle-stroke-opacity', 0)
        map.setPaintProperty(UNDERLIGHT, 'circle-opacity', 0.26)
      } catch { /* style swapped mid-beat */ }
    })
  } catch { /* style mid-swap */ }
}

/** Mark the overlay host while an automatic flight is in the air (the card fades; nothing re-renders per frame). */
export function setFlyingMark(host: HTMLElement | null, flying: boolean) {
  if (!host) return
  if (flying) host.setAttribute('data-auto-flying', '')
  else host.removeAttribute('data-auto-flying')
}
