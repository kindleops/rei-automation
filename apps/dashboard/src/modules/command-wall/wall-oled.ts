/**
 * Command Wall OLED / burn-in protection (§32). Nearly imperceptible by design.
 *
 *   surface drift  a slow Lissajous path, |x|,|y| ≤ amplitude (Low 3 px, High 6 px),
 *                  periods of 11 and 17 minutes so it never visibly "moves".
 *   rail shift     the metric rail steps ±(Low 4 / High 8) px every 20 minutes.
 *   map drift      the map surface translates by ≤ (Low 6 / High 12) px over 37 min.
 *   dimming        after 45 min with nothing operational happening (Low 0.88,
 *                  High 0.78) and, if enabled, overnight 23:00–06:00 (0.62).
 *   Off            all zero / 1.
 *
 * All pure functions of time so the soak can assert the bounds over hours.
 */
import type { WallOledLevel } from './wall-types'

export const OLED_AMPLITUDE_PX: Record<WallOledLevel, number> = { off: 0, low: 3, high: 6 }
export const RAIL_SHIFT_PX: Record<WallOledLevel, number> = { off: 0, low: 4, high: 8 }
export const MAP_DRIFT_PX: Record<WallOledLevel, number> = { off: 0, low: 6, high: 12 }
export const IDLE_DIM_AFTER_MS = 45 * 60_000
export const IDLE_DIM: Record<WallOledLevel, number> = { off: 1, low: 0.88, high: 0.78 }
export const OVERNIGHT_DIM = 0.62
const P1 = 11 * 60_000
const P2 = 17 * 60_000
const RAIL_STEP_MS = 20 * 60_000
const MAP_PERIOD = 37 * 60_000

const round = (v: number) => Math.round(v * 100) / 100

export function surfaceDrift(t: number, level: WallOledLevel, seed = 0): { x: number; y: number } {
  const a = OLED_AMPLITUDE_PX[level] ?? 0
  if (!a) return { x: 0, y: 0 }
  return { x: round(a * Math.sin((2 * Math.PI * (t + seed)) / P1)), y: round(a * Math.sin((2 * Math.PI * (t + seed * 1.7)) / P2 + Math.PI / 3)) }
}

/** Discrete rail step: -1, 0 or +1 × the level's shift, changing every 20 minutes. */
export function railShift(t: number, level: WallOledLevel): number {
  const px = RAIL_SHIFT_PX[level] ?? 0
  if (!px) return 0
  const step = Math.floor(t / RAIL_STEP_MS) % 4
  return [0, px, 0, -px][step]
}

export function mapDrift(t: number, level: WallOledLevel): { x: number; y: number } {
  const a = MAP_DRIFT_PX[level] ?? 0
  if (!a) return { x: 0, y: 0 }
  const ph = (2 * Math.PI * t) / MAP_PERIOD
  return { x: round(a * Math.cos(ph)), y: round(a * 0.6 * Math.sin(ph)) }
}

export function dimLevel({ idleMs, hour, level, overnight }: { idleMs: number; hour: number; level: WallOledLevel; overnight: boolean }): number {
  let v = 1
  if (level !== 'off' && idleMs >= IDLE_DIM_AFTER_MS) v = Math.min(v, IDLE_DIM[level])
  if (overnight && (hour >= 23 || hour < 6)) v = Math.min(v, OVERNIGHT_DIM)
  return v
}

/** Layout rotation (§32 "rotating layouts"): the feed side alternates every 2 h when OLED protection is on. */
export function feedSide(t: number, level: WallOledLevel): 'right' | 'left' {
  if (level === 'off') return 'right'
  return Math.floor(t / (2 * 3600_000)) % 2 === 0 ? 'right' : 'left'
}
