/**
 * DYNAMIC (SUN) — the real day/night split, drawn so it reads at a glance.
 *
 * "Ambient" daylight (useWorldLight's default bands) only breathes on the
 * map. Dynamic makes the terminator the subject: the night side goes
 * properly dark, the twilight zone falls off smoothly through civil (−6°),
 * nautical (−12°) and astronomical (−18°) dusk, and on dark basemaps the day
 * side lifts so "light where it's day" is visible there too.
 *
 * Pure: an instant + a map theme → one GeoJSON FeatureCollection. The fill
 * layer that draws it is the same one ambient daylight uses (paint is
 * data-driven from each feature's `color` and `o`), so switching modes only
 * swaps data — no layer churn, pins and labels stay above it.
 *
 * Smooth falloff without a raster: the night side is N nested "sun below X°"
 * polygons stacked in order. Each band's opacity is solved so the COMPOSITE
 * darkness after band k equals the target curve at that altitude:
 *   o_k = 1 − (1 − A_k) / (1 − A_{k−1})
 * so the gradient is exact at every stop, whatever N is.
 */
import { darkRegion, litRegion, terminatorLine } from './solar'
import { getMapVisualPreset } from '../map-visual-presets'

export type SunMode = 'ambient' | 'dynamic'

/** Daylight style choices (Layers plate + Appearance popover share them). */
export const SUN_MODE_OPTIONS: ReadonlyArray<{ key: SunMode; label: string }> = [{ key: 'ambient', label: 'Ambient' }, { key: 'dynamic', label: 'Dynamic (sun)' }]

/** Night stops, degrees of solar altitude, bright → deep. −6/−12/−18 = civil/nautical/astronomical. */
// Fine where the eye sees the change (0 → −12°: ≤1.3% darker per quarter
// degree, below the Mach-band threshold at country zoom), coarser through
// astronomical twilight where the curve is flat.
export const DYNAMIC_NIGHT_STOPS: ReadonlyArray<number> = [
  ...Array.from({ length: 49 }, (_, i) => -i * 0.25),
  -13, -14, -15, -16, -17, -18,
]
/**
 * Day-side lift stops (dark basemaps only): the lift reaches full strength by
 * 3° of sun, so on a near-black basemap the visible edge of "day" sits ON the
 * sunset line rather than drifting west of it as the sun gets low.
 */
export const DYNAMIC_DAY_STOPS: ReadonlyArray<number> = Array.from({ length: 13 }, (_, i) => i * 0.25)

export interface DynamicPalette {
  /** Composite darkness at astronomical night (0–1). */
  night: number
  nightColor: string
  /** Composite lift at high sun (0 = none). */
  day: number
  dayColor: string
  /** Warm glow on the sunlit edge of the terminator. */
  golden: number
}

export function dynamicPalette(theme: string): DynamicPalette {
  const p = getMapVisualPreset(theme)
  // [8.4] owner: night must read as night — deep tint; labels keep their halos above it.
  if (p.basemap.isLight) return { night: 0.76, nightColor: '#08112b', day: 0, dayColor: '#ffffff', golden: 0.07 }
  if (p.basemap.family === 'satellite') return { night: 0.8, nightColor: '#01030a', day: 0.06, dayColor: '#fff6e8', golden: 0.06 }
  if (p.basemap.family === 'terrain') return { night: 0.76, nightColor: '#050b1c', day: 0.06, dayColor: '#dfe9f7', golden: 0.06 }
  return { night: 0.82, nightColor: '#000208', day: 0.13, dayColor: '#b8cbe6', golden: 0.05 }
}

/** Target composite (0–1 of the theme's max) at a solar altitude below the horizon. */
export function nightCurve(altitude: number): number {
  const t = Math.min(1, Math.max(0, -altitude / 18))
  return Math.pow(Math.sin((Math.PI / 2) * t), 1.15)
}

/** Per-layer opacities whose stacked composite follows `targets` exactly (targets ascending, 0–1). */
export function stackOpacities(targets: ReadonlyArray<number>): number[] {
  const out: number[] = []
  let prev = 0
  for (const a of targets) {
    const next = Math.max(prev, Math.min(0.999, a))
    out.push(prev >= 1 ? 0 : 1 - (1 - next) / (1 - prev))
    prev = next
  }
  return out
}

/** Composite of stacked opacities (for tests and the legend swatch). */
export const compositeOf = (ops: ReadonlyArray<number>) => 1 - ops.reduce((k, o) => k * (1 - o), 1)

const round = (n: number) => Math.round(n * 1000) / 1000

export function buildDynamicSun(at: Date, theme: string): GeoJSON.FeatureCollection {
  const pal = dynamicPalette(theme)
  const features: GeoJSON.Feature[] = []
  // 1 · a warm edge on the day side of the line (drawn first: night covers it).
  if (pal.golden > 0) {
    features.push({ type: 'Feature', geometry: darkRegion(at, 4), properties: { kind: 'band', role: 'golden', o: pal.golden, color: '#ffa04d' } })
  }
  // 2 · the day-side lift, strongest where the sun is high.
  if (pal.day > 0) {
    const ops = stackOpacities(DYNAMIC_DAY_STOPS.map((_, i) => (pal.day * (i + 1)) / DYNAMIC_DAY_STOPS.length))
    DYNAMIC_DAY_STOPS.forEach((alt, i) => {
      features.push({ type: 'Feature', geometry: litRegion(at, alt), properties: { kind: 'band', role: 'day', o: round(ops[i]), color: pal.dayColor } })
    })
  }
  // 3 · the night side, smooth through civil → nautical → astronomical dusk.
  // The first stop is not 0 of the curve: just past sunset the land is already visibly dimmer.
  const targets = DYNAMIC_NIGHT_STOPS.map((alt, i) => pal.night * Math.max(nightCurve(alt), i === 0 ? 0.06 : 0))
  const ops = stackOpacities(targets)
  DYNAMIC_NIGHT_STOPS.forEach((alt, i) => {
    features.push({ type: 'Feature', geometry: darkRegion(at, alt), properties: { kind: 'band', role: 'night', o: round(ops[i]), color: pal.nightColor } })
  })
  // 4 · the sunset line itself (country zoom only — the line layer has a maxzoom).
  features.push({ type: 'Feature', geometry: terminatorLine(at), properties: { kind: 'line' } })
  return { type: 'FeatureCollection', features }
}

/** "Sunset in 42m" / "Sunrise in 3h 10m" — null when the sun won't cross the horizon in the next day. */
export function sunEventHint(ev: { kind: 'sunrise' | 'sunset'; at: Date } | null, now: Date): string | null {
  if (!ev) return null
  const mins = Math.max(0, Math.round((ev.at.valueOf() - now.valueOf()) / 60000))
  const span = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ''}`
  return `${ev.kind === 'sunset' ? 'Sunset' : 'Sunrise'} in ${span}`
}
