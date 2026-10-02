import { staticStreetViewUrl } from '../../../modules/entity-graph/mobile/EntityGraphPropertyVisual'

/**
 * The comp Street View load queue + source rule (see CompStreetView): every
 * comp image load takes one of MAX_IN_FLIGHT slots, so a list never fires one
 * request per comp at once; a load cancelled before its turn never fires.
 */

const MAX_IN_FLIGHT = 3
let inFlight = 0
const waiting: Array<() => void> = []

function pump() {
  while (inFlight < MAX_IN_FLIGHT && waiting.length) {
    const next = waiting.shift()
    if (!next) break
    inFlight += 1
    queueMicrotask(next)
  }
}

/** Ask for a load slot; returns a cancel that is safe to call at any point. */
export function acquireSlot(onGranted: () => void): () => void {
  let state: 'waiting' | 'granted' | 'done' = 'waiting'
  const grant = () => {
    if (state !== 'waiting') { inFlight = Math.max(0, inFlight - 1); pump(); return }
    state = 'granted'
    onGranted()
  }
  waiting.push(grant)
  pump()
  return () => {
    if (state === 'waiting') {
      const i = waiting.indexOf(grant)
      if (i >= 0) waiting.splice(i, 1)
      state = 'done'
    } else if (state === 'granted') {
      state = 'done'
      inFlight = Math.max(0, inFlight - 1)
      pump()
    }
  }
}

/** Test seam: how many loads are queued / running. */
export function streetViewQueueDepth() { return { inFlight, waiting: waiting.length } }

const hasCoords = (lat?: number | null, lng?: number | null) =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(Number(lat)) > 0.0001 && Math.abs(Number(lng)) > 0.0001

/** The one URL a comp's imagery comes from — null means there is honestly nothing to look at. */
export function compStreetViewUrl(c: { photo?: string | null; lat?: number | null; lng?: number | null }): string | null {
  if (c.photo && /^https:\/\//.test(c.photo)) return c.photo
  if (!hasCoords(c.lat, c.lng)) return null
  return staticStreetViewUrl(null, c.lat, c.lng)
}
