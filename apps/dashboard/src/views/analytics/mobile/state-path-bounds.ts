import { USA_STATE_PATHS } from '../../../lib/data/usaStatePaths'

/**
 * The bounding box of a state's path, so the map can ZOOM to it on drill-down.
 *
 * usaStatePaths is deliberately simple — every path is M/L/Z with absolute
 * coordinates and no curves (its own header says 8–16 vertices per state) — which
 * makes a numeric scan an exact answer rather than an approximation. A curve command
 * would need a real path parser; if one is ever added here, this returns a box around
 * the control points, which is still a superset of the shape and therefore safe for
 * framing.
 *
 * Framing the drill is what makes the geography legible: a state highlighted inside
 * the whole-country viewBox is a 40px blob on a 390px screen.
 */

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const COORD = /-?\d+(?:\.\d+)?/g

function round(value: number): number {
  return Math.round(value * 100) / 100
}

const boundsCache = new Map<string, Bounds | null>()

export function stateBounds(abbr: string): Bounds | null {
  return rawBounds(abbr)
}

function rawBounds(abbr: string): Bounds | null {
  if (boundsCache.has(abbr)) return boundsCache.get(abbr) ?? null

  const path = USA_STATE_PATHS[abbr]?.path
  if (!path) {
    boundsCache.set(abbr, null)
    return null
  }

  const numbers = path.match(COORD)?.map(Number) ?? []
  if (numbers.length < 4) {
    boundsCache.set(abbr, null)
    return null
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    const x = numbers[i]
    const y = numbers[i + 1]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }

  const result: Bounds = { minX, minY, maxX, maxY }
  boundsCache.set(abbr, result)
  return result
}

/**
 * The national frame, computed from the paths themselves rather than the declared
 * "0 0 960 600" canvas.
 *
 * That canvas has substantial empty margin, and at 390x270 the letterboxed result
 * put the continental US in the middle 60% of an already short box — §7 asks for a
 * map that is a meaningful part of the screen, and half of it was padding.
 */
const nationalFrame = (() => {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const abbr of Object.keys(USA_STATE_PATHS)) {
    const box = rawBounds(abbr)
    if (!box) continue
    minX = Math.min(minX, box.minX)
    minY = Math.min(minY, box.minY)
    maxX = Math.max(maxX, box.maxX)
    maxY = Math.max(maxY, box.maxY)
  }
  if (!Number.isFinite(minX)) return '0 0 960 600'
  const pad = 12
  return `${round(minX - pad)} ${round(minY - pad)} ${round(maxX - minX + pad * 2)} ${round(maxY - minY + pad * 2)}`
})()

export const NATIONAL_VIEWBOX = nationalFrame

/**
 * An SVG viewBox framing `abbr` with padding, letter-boxed to the national aspect
 * ratio so the zoom is a camera move rather than a distortion.
 */
export function stateViewBox(abbr: string | null, padding = 0.42): string {
  if (!abbr) return NATIONAL_VIEWBOX
  const box = stateBounds(abbr)
  if (!box) return NATIONAL_VIEWBOX

  const width = Math.max(1, box.maxX - box.minX)
  const height = Math.max(1, box.maxY - box.minY)
  const padX = width * padding
  const padY = height * padding

  let x = box.minX - padX
  let y = box.minY - padY
  let w = width + padX * 2
  let h = height + padY * 2

  // Match 960:600 (1.6) so states do not stretch when the camera moves.
  const targetAspect = 960 / 600
  const aspect = w / h
  if (aspect < targetAspect) {
    const nextWidth = h * targetAspect
    x -= (nextWidth - w) / 2
    w = nextWidth
  } else if (aspect > targetAspect) {
    const nextHeight = w / targetAspect
    y -= (nextHeight - h) / 2
    h = nextHeight
  }

  return `${round(x)} ${round(y)} ${round(w)} ${round(h)}`
}

