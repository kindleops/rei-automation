import { useState, type PointerEvent, type ReactNode } from 'react'
import type { FocusStore } from '../focus-store'
import { useFocus } from '../focus-store'
import { ChartTip } from './chart-kit'
import { linear, nearest, niceTicks, useElementWidth } from './chart-math'

export interface ScatterPoint { key: string; distance: number; score: number; weight: number | null; tier: 'set' | 'added' | 'removed' | 'candidate'; tip: ReactNode }

const M = { l: 34, r: 12, t: 10, b: 26 }

/**
 * Distance × the engine's comparability score (§37). The score is the
 * engine's own feature-match score (scoreComparable, 0–100), shown as that —
 * not a "similarity %". Marker area follows the engine weight, so the
 * evidence that moves the value is the evidence that looks heavy.
 */
export function DistanceScoreScatter({ points, radius, minScore, store, height = 196 }: { points: ScatterPoint[]; radius: number; minScore: number; store: FocusStore; height?: number }) {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const focus = useFocus(store)
  const [tipKey, setTipKey] = useState<string | null>(null)
  const maxD = Math.max(radius, ...points.map((p) => p.distance), 0.5)
  const x = linear(0, maxD * 1.04, M.l, Math.max(M.l + 60, width - M.r))
  const y = linear(Math.min(minScore, ...points.map((p) => p.score)) - 2, 100, height - M.b, M.t)
  const maxW = Math.max(0.0001, ...points.map((p) => p.weight ?? 0))
  const rOf = (p: ScatterPoint) => (p.tier === 'candidate' ? 2.4 : 3.2 + 3.4 * Math.sqrt((p.weight ?? 0) / maxW))
  const pts = points.map((p) => ({ ...p, px: x(p.distance), py: y(p.score), r: rOf(p) }))
  // draw candidates first, the shown set on top
  pts.sort((a, b) => (a.tier === 'candidate' ? -1 : 0) - (b.tier === 'candidate' ? -1 : 0))
  const xt = niceTicks(0, maxD, width < 420 ? 3 : 5)
  const yt = [40, 60, 80, 100].filter((v) => v >= y.invert(height - M.b))
  const tip = tipKey ? pts.find((p) => p.key === tipKey) : null

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const hit = nearest(pts.map((p) => ({ x: p.px, y: p.py, item: p.key })), e.clientX - box.left, e.clientY - box.top, 16)
    setTipKey(hit)
    store.hover(hit, hit ? 'chart' : null)
  }

  return (
    <div ref={ref} className="ciw-scatter" style={{ height }}>
      {width > 0 ? (
        <svg width={width} height={height} role="img" aria-label={`Distance against the engine's comparability score for ${points.length} sales`}
          onPointerMove={onMove} onPointerLeave={() => { setTipKey(null); store.hover(null, null) }} onClick={() => { if (tipKey) store.select(tipKey) }}>
          {yt.map((v) => (
            <g key={`y${v}`}>
              <line x1={M.l} x2={width - M.r} y1={y(v)} y2={y(v)} className="ciw-grid" />
              <text x={M.l - 6} y={y(v) + 3.5} textAnchor="end" className="ciw-axis">{v}</text>
            </g>
          ))}
          {xt.map((v) => (
            <g key={`x${v}`}>
              <line x1={x(v)} x2={x(v)} y1={M.t} y2={height - M.b} className="ciw-grid" />
              <text x={x(v)} y={height - 8} textAnchor="middle" className="ciw-axis">{v === 0 ? '0' : `${v} mi`}</text>
            </g>
          ))}
          {radius < maxD ? <line x1={x(radius)} x2={x(radius)} y1={M.t} y2={height - M.b} className="ciw-scatter__radius" /> : null}
          {pts.map((p) => {
            const hot = focus.hover === p.key || focus.selected === p.key
            return <g key={p.key} className={`ciw-dot is-${p.tier}${hot ? ' is-hot' : ''}`}><circle cx={p.px} cy={p.py} r={hot ? p.r + 2 : p.r} className="ciw-dot__mark" /></g>
          })}
        </svg>
      ) : null}
      {tip ? <ChartTip x={tip.px} y={tip.py} width={width}>{tip.tip}</ChartTip> : null}
    </div>
  )
}
