import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Chart geometry shared by every workstation chart: measured width, linear
 * scales, round ticks, padded domains and nearest-point hit testing.
 */

/** Width of an element, measured by ResizeObserver (its first callback is the initial size). */
export function useElementWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0)
      setWidth((cur) => (Math.abs(cur - w) >= 1 ? w : cur))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}

export function linear(d0: number, d1: number, r0: number, r1: number) {
  const span = d1 - d0 || 1
  const f = (v: number) => r0 + ((v - d0) / span) * (r1 - r0)
  f.invert = (px: number) => d0 + ((px - r0) / (r1 - r0 || 1)) * span
  return f
}

/** Round tick values (1 / 2 / 2.5 / 5 × 10ⁿ) across a domain. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return []
  if (min === max) return [min]
  const raw = (max - min) / Math.max(1, count)
  const pow = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw
  const start = Math.ceil(min / step) * step
  const out: number[] = []
  for (let v = start; v <= max + step * 1e-9; v += step) out.push(Number(v.toFixed(10)))
  return out
}

/** Pad a domain so marks never sit on the frame. */
export function padDomain(values: number[], pad = 0.06): [number, number] {
  const v = values.filter((x) => Number.isFinite(x))
  if (!v.length) return [0, 1]
  let lo = Math.min(...v)
  let hi = Math.max(...v)
  if (lo === hi) { lo -= Math.abs(lo) * 0.1 || 1; hi += Math.abs(hi) * 0.1 || 1 }
  const span = hi - lo
  return [lo - span * pad, hi + span * pad]
}

/** The nearest point to the pointer, within a hit radius (≥24px targets, §interaction). */
export function nearest<T>(points: ReadonlyArray<{ x: number; y: number; item: T }>, px: number, py: number, radius = 18): T | null {
  let best: T | null = null
  let bestD = radius * radius
  for (const p of points) {
    const d = (p.x - px) ** 2 + (p.y - py) ** 2
    if (d <= bestD) { bestD = d; best = p.item }
  }
  return best
}
