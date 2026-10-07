/**
 * The map ↔ plane splitter's arithmetic and memory (pure; no DOM).
 *
 * The operator's width is remembered per plane KIND: Compare is a wide matrix
 * and wants room the narrow modes (Evidence, Valuation, Market, Model) do not,
 * so dragging Compare wide never leaves Evidence stretched across the screen.
 * `null` means "the layout's own default" (container-query driven CSS).
 */
export type PlaneKind = 'compare' | 'default'
export type PlaneWidths = Record<PlaneKind, number | null>

export const PLANE_MIN = 340
export const MAP_MIN = 300
export const SPLIT_TRACK = 10
export const PLANE_WIDTH_KEY = 'lc.comps.planeWidth.v1'
export const NO_PLANE_WIDTHS: PlaneWidths = { compare: null, default: null }

export const planeKindOf = (plane: string): PlaneKind => (plane === 'compare' ? 'compare' : 'default')

/** Widest the plane may be inside a body this wide (the map keeps MAP_MIN, the insights column keeps its own). */
export function maxPlaneWidth(bodyWidth: number, insightsWidth = 0): number {
  const reserve = insightsWidth > 0 ? insightsWidth + SPLIT_TRACK : 0
  return Math.max(PLANE_MIN, Math.floor(bodyWidth - MAP_MIN - SPLIT_TRACK - reserve))
}

export function clampPlaneWidth(w: number, bodyWidth: number, insightsWidth = 0): number {
  return Math.round(Math.min(maxPlaneWidth(bodyWidth, insightsWidth), Math.max(PLANE_MIN, w)))
}

const valid = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= PLANE_MIN && v <= 8000 ? Math.round(v) : null)

export function parsePlaneWidths(raw: string | null): PlaneWidths {
  if (!raw) return NO_PLANE_WIDTHS
  try {
    const o = JSON.parse(raw) as Partial<Record<PlaneKind, unknown>>
    return { compare: valid(o?.compare), default: valid(o?.default) }
  } catch {
    return NO_PLANE_WIDTHS
  }
}

export function readPlaneWidths(): PlaneWidths {
  try { return parsePlaneWidths(localStorage.getItem(PLANE_WIDTH_KEY)) } catch { return NO_PLANE_WIDTHS }
}

export function writePlaneWidths(w: PlaneWidths): void {
  try {
    if (w.compare === null && w.default === null) localStorage.removeItem(PLANE_WIDTH_KEY)
    else localStorage.setItem(PLANE_WIDTH_KEY, JSON.stringify(w))
  } catch { /* storage unavailable: the width lives for this session only */ }
}
