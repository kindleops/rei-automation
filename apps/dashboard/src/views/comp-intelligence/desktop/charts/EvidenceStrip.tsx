import { useState, type PointerEvent, type ReactNode } from 'react'
import type { FocusStore } from '../focus-store'
import { useFocus } from '../focus-store'
import { ChartTip } from './chart-kit'
import { linear, nearest, niceTicks, padDomain, useElementWidth } from './chart-math'

export type StripTier = 'set' | 'added' | 'removed' | 'candidate'
export interface StripPoint { key: string; value: number; tier: StripTier; tip: ReactNode; weight?: number | null; flagged?: boolean }
export interface StripRef { id: string; label: string; value: number; tone: 'engine' | 'operator' | 'subject' | 'context' }
export interface StripBand { id: string; label: string; low: number; high: number; tone: 'engine' | 'operator' | 'attn' }

const R = { set: 4.5, added: 4.5, removed: 4, candidate: 2.6 }
const PAD_X = 12

/**
 * One value per sale on one axis, dodged into lanes so no dot hides another
 * (a beeswarm). The shown set is filled in the evidence colour, candidates
 * are small and grey, removed system comps are hollow — size and fill carry
 * the state as well as colour. References (the engine's central value, the
 * subject's implied value) are hairlines; ranges (the engine range, the
 * outlier band) are washes behind the dots.
 */
export function EvidenceStrip({ points, refs, bands, store, format, ariaLabel }: { points: StripPoint[]; refs: StripRef[]; bands: StripBand[]; store: FocusStore; format: (v: number) => string; ariaLabel: string }) {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const focus = useFocus(store)
  const [tipKey, setTipKey] = useState<string | null>(null)

  // Robust axis: the 2nd–98th percentile of the sales plus every reference.
  // A sale outside it (a deed with a tiny recorded size, say) is pinned to
  // the edge and drawn hollow — its true value stays in the tooltip.
  const sorted = points.map((p) => p.value).filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  const pct = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]
  const core = sorted.length >= 12 ? [pct(0.02), pct(0.98)] : sorted
  const domain = padDomain([...core, ...refs.map((r) => r.value), ...bands.flatMap((b) => [b.low, b.high])], 0.04)
  const x = linear(domain[0], domain[1], PAD_X, Math.max(PAD_X + 40, width - PAD_X))
  const clampV = (v: number) => Math.min(domain[1], Math.max(domain[0], v))
  const ticks = niceTicks(domain[0], domain[1], width < 460 ? 3 : 5)

  // dodge into lanes: set first so the evidence sits on the centre lane
  const order = [...points].sort((a, b) => (a.tier === 'candidate' ? 1 : 0) - (b.tier === 'candidate' ? 1 : 0) || a.value - b.value)
  const lanes: Array<Array<{ px: number; r: number }>> = []
  const placed = order.map((p) => {
    const clamped = p.value !== clampV(p.value)
    const px = x(clampV(p.value))
    const r = R[p.tier]
    let lane = 0
    for (;; lane += 1) {
      if (!lanes[lane]) lanes[lane] = []
      if (!lanes[lane].some((o) => Math.abs(o.px - px) < o.r + r + 1.5)) break
      if (lane > 9) break
    }
    lanes[lane].push({ px, r })
    return { ...p, px, lane, clamped }
  })
  const laneCount = Math.max(1, lanes.length)
  const LANE = 9
  const LABEL_LINE = 12
  const TOP = 14 + LABEL_LINE * Math.max(0, refs.length - 1)
  const mid = TOP + Math.ceil(laneCount / 2) * LANE + 4
  const yOf = (lane: number) => mid + (lane % 2 === 0 ? 1 : -1) * Math.ceil(lane / 2) * LANE
  const height = mid + Math.ceil(laneCount / 2) * LANE + 26
  const pts = placed.map((p) => ({ ...p, py: yOf(p.lane) }))
  const tip = tipKey ? pts.find((p) => p.key === tipKey) : null

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const hit = nearest(pts.map((p) => ({ x: p.px, y: p.py, item: p.key })), e.clientX - box.left, e.clientY - box.top, 16)
    setTipKey(hit)
    store.hover(hit, hit ? 'chart' : null)
  }

  return (
    <div ref={ref} className="ciw-beeswarm" style={{ height }}>
      {width > 0 ? (
        <svg width={width} height={height} role="img" aria-label={ariaLabel}
          onPointerMove={onMove}
          onPointerLeave={() => { setTipKey(null); store.hover(null, null) }}
          onClick={() => { if (tipKey) store.select(tipKey) }}
        >
          {bands.map((b) => (
            <g key={b.id} className={`ciw-strip-band is-${b.tone}`}>
              <rect x={x(b.low)} y={TOP - 4} width={Math.max(1, x(b.high) - x(b.low))} height={height - TOP - 18} rx={4} />
              {b.tone === 'attn'
                ? <text x={x(b.low) + 4} y={height - 22} className="ciw-strip-band__label">{b.label}</text>
                : <text x={x(b.high) - 4} y={TOP + 7} textAnchor="end" className="ciw-strip-band__label">{b.label}</text>}
            </g>
          ))}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={TOP - 4} y2={height - 16} className="ciw-grid" />
              <text x={x(t)} y={height - 4} className="ciw-axis" textAnchor="middle">{format(t)}</text>
            </g>
          ))}
          {refs.map((r, i) => (
            <g key={r.id} className={`ciw-strip-ref is-${r.tone}`}>
              <line x1={x(r.value)} x2={x(r.value)} y1={TOP - 6} y2={height - 18} />
              <text x={x(r.value) + (x(r.value) > width * 0.62 ? -4 : 4)} y={TOP - 4 - LABEL_LINE * (refs.length - 1 - i)} textAnchor={x(r.value) > width * 0.62 ? 'end' : 'start'} className="ciw-strip-ref__label">{r.label} {format(r.value)}</text>
            </g>
          ))}
          {pts.map((p) => {
            const hot = focus.hover === p.key || focus.selected === p.key
            return (
              <g key={p.key} className={`ciw-dot is-${p.tier}${hot ? ' is-hot' : ''}${p.flagged ? ' is-flagged' : ''}${p.clamped ? ' is-clamped' : ''}`}>
                {p.flagged ? <circle cx={p.px} cy={p.py} r={R[p.tier] + 3} className="ciw-dot__flag" /> : null}
                <circle cx={p.px} cy={p.py} r={hot ? R[p.tier] + 2 : R[p.tier]} className="ciw-dot__mark" />
              </g>
            )
          })}
        </svg>
      ) : null}
      {tip ? <ChartTip x={tip.px} y={tip.py} width={width}>{tip.tip}</ChartTip> : null}
    </div>
  )
}
