/**
 * THE MOBILE BOTTOM-LAYOUT CONTRACT.
 *
 * Three surfaces compete for the bottom of a phone screen — the app dock, a bottom
 * sheet (the Map's seller card, the composer), and Live Activity — and until now each
 * one positioned itself with no idea the others existed. Measured on the Map at
 * 390x844 with a property selected: Live Activity occupied 713–823 while the seller
 * sheet occupied 356–844, so the activity rail's own Hide and Settings buttons were
 * painted over by the sheet body. Seven actionable controls were unreachable.
 *
 * The previous fix for that class of collision was `opacity: 0` on whichever surface
 * lost. That hides a symptom: the element still occupies its space, still holds focus
 * order, and nothing else can claim the room it gave up.
 *
 * So: ONE publisher of what the bottom is doing, as CSS custom properties on
 * <html>, and every bottom surface reserves against them instead of guessing.
 *
 *   --nx-bottom-dock-height    what the dock occupies right now, including safe area
 *   --nx-bottom-sheet-height   what an open bottom sheet occupies, 0px when none
 *   --nx-bottom-floor          the highest point a free-floating surface may occupy:
 *                              max(dock, sheet). This is the one most callers want.
 *
 * `--nx-bottom-floor` is deliberately a MAX rather than a sum: the dock and the sheet
 * both anchor to the bottom edge and overlap rather than stack, so adding them would
 * reserve room that does not exist.
 */

export type BottomSurfaceId = 'dock' | 'sheet'

const VAR = {
  dock: '--nx-bottom-dock-height',
  sheet: '--nx-bottom-sheet-height',
  floor: '--nx-bottom-floor',
} as const

/** Live heights in px, keyed by surface. A surface that is closed reports 0. */
const heights: Record<BottomSurfaceId, number> = { dock: 0, sheet: 0 }

/**
 * Past this share of the viewport a bottom sheet is not sharing the screen, it IS the
 * screen, and free-floating surfaces should stand down rather than be pushed past the
 * top edge. Measured: a 92dvh sheet drove Live Activity to y=-30.
 */
const SHEET_DOMINANT_RATIO = 0.7

const apply = () => {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.style.setProperty(VAR.dock, `${Math.round(heights.dock)}px`)
  root.style.setProperty(VAR.sheet, `${Math.round(heights.sheet)}px`)
  root.style.setProperty(VAR.floor, `${Math.round(Math.max(heights.dock, heights.sheet))}px`)

  /**
   * A boolean is expressed as a CLASS, not as a custom property, because CSS cannot
   * branch on a property's value — and a surface that must DISAPPEAR cannot be
   * expressed by arithmetic on a height.
   */
  const viewport = window.innerHeight || 0
  const dominant = viewport > 0 && heights.sheet / viewport >= SHEET_DOMINANT_RATIO
  root.classList.toggle('nx-bottom-sheet-dominant', dominant)
}

/**
 * Publish what a bottom surface currently occupies.
 *
 * Called from a layout effect with a measured height, so the value is what is really
 * painted rather than what a stylesheet intended — snap heights are expressed in dvh
 * and a `52dvh` sheet is a different number on every device.
 */
export function publishBottomSurface(id: BottomSurfaceId, height: number) {
  const next = Number.isFinite(height) ? Math.max(0, height) : 0
  if (heights[id] === next) return
  heights[id] = next
  apply()
}

/** A surface that closes must give its room back, or the floor stays high forever. */
export function releaseBottomSurface(id: BottomSurfaceId) {
  publishBottomSurface(id, 0)
}

export function readBottomFloor(): number {
  return Math.max(heights.dock, heights.sheet)
}
