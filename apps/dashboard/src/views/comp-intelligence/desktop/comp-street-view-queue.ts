import { resolveMapsImage } from '../../../domain/inbox/inbox-normalization'

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

/**
 * The one URL a comp's imagery comes from — null means there is honestly
 * nothing to look at. Every comp source (engine-pool MLS / public-record /
 * investor sales, transaction-corpus deeds, canonical recent sales) passes
 * the same fields — its own coordinates, address and stored image — through
 * THE shared stored-imagery rule (resolveMapsImage): our key at the
 * coordinates, then at the address, the stored image last.
 *
 * Why it matters (prod RC 8.3.2, 2026-10-04): every engine-pool comp carries a
 * stored vendor-signed Street View URL (buyer_comp_raw_v2.streetview_image)
 * whose key is referrer-restricted and errors from ops.leadcommand.ai. MLS
 * comps exist only in the engine pool, so with the stored URL first every MLS
 * comp — and every pool-sourced investor comp — showed no image, while
 * corpus deeds (no stored URL) built from our key and showed one.
 */
export function compStreetViewUrl(c: { photo?: string | null; lat?: number | null; lng?: number | null; address?: string | null }): string | null {
  return resolveMapsImage({ kind: 'street', stored: c.photo ?? null, address: c.address ?? null, lat: c.lat ?? null, lng: c.lng ?? null })
}
