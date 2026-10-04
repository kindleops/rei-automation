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

/**
 * The one URL a comp's imagery comes from — null means there is honestly
 * nothing to look at.
 *
 * ORDER (fixed 2026-10-04): LeadCommand's own configured Street View key at
 * the comp's coordinates, else at its address; the record's stored
 * `streetview_image` only when no own-key URL can be built. The stored URLs
 * (buyer_comp_raw_v2, every engine-pool comp) are a data vendor's signed
 * links whose key is referrer-restricted: from ops.leadcommand.ai the browser
 * gets an error for every one of them, so preferring them blanked every comp
 * frame in production. They load from curl / no-referrer only — we do not
 * strip the referrer to get around another party's key restriction.
 */
export function compStreetViewUrl(c: { photo?: string | null; lat?: number | null; lng?: number | null; address?: string | null }): string | null {
  if (hasCoords(c.lat, c.lng)) {
    const built = staticStreetViewUrl(null, c.lat, c.lng)
    if (built) return built
  }
  const address = (c.address ?? '').trim()
  if (address) {
    const built = staticStreetViewUrl(address, null, null)
    if (built) return built
  }
  if (c.photo && /^https:\/\//.test(c.photo)) return c.photo
  return null
}
