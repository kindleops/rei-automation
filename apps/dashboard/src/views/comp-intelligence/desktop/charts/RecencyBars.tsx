import { useState } from 'react'
import type { RecencyStep } from '../../../../domain/comp-intelligence/comps-workstation-model'
import { ChartTip } from './chart-kit'
import { linear, useElementWidth } from './chart-math'

export interface RecencyColumn { step: RecencyStep; set: number; candidates: number }

const M = { l: 6, r: 6, t: 14, b: 36 }

/**
 * Sale age by the engine's own recency steps (§38). The steps ARE the
 * engine's weighting (recencyScore: ≤3 mo 100%, 4–6 mo 94% …), so the factor
 * under each column is the factor the engine applies — not an illustration.
 * The shown set stacks under the remaining admissible sales.
 */
export function RecencyBars({ columns, height = 150 }: { columns: RecencyColumn[]; height?: number }) {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...columns.map((c) => c.set + c.candidates))
  const slot = (Math.max(60, width) - M.l - M.r) / Math.max(1, columns.length)
  const barW = Math.min(24, slot * 0.56)
  const y = linear(0, max, height - M.b, M.t + 10)
  const h = (v: number) => Math.max(0, height - M.b - y(v))

  return (
    <div ref={ref} className="ciw-recency" style={{ height }} onPointerLeave={() => setHover(null)}>
      {width > 0 ? (
        <svg width={width} height={height} role="img" aria-label={`Sale age by the engine's recency steps: ${columns.map((c) => `${c.step.label} ${c.set} in set, ${c.candidates} candidates`).join('; ')}`}>
          <line x1={M.l} x2={width - M.r} y1={height - M.b} y2={height - M.b} className="ciw-axis-line" />
          {columns.map((c, i) => {
            const cx = M.l + slot * i + slot / 2
            const hs = h(c.set)
            const hc = h(c.set + c.candidates) - hs
            const base = height - M.b
            return (
              <g key={c.step.id} onPointerEnter={() => setHover(i)} className={hover === i ? 'is-hot' : undefined}>
                <rect x={M.l + slot * i} y={M.t} width={slot} height={height - M.t - 4} fill="transparent" />
                {hc > 0 ? <path d={roundTop(cx - barW / 2, base - hs - hc - (hs > 0 ? 2 : 0), barW, hc)} className="ciw-bar is-candidate" /> : null}
                {hs > 0 ? <path d={roundTop(cx - barW / 2, base - hs, barW, hs, hc > 0 ? 0 : 4)} className="ciw-bar is-set" /> : null}
                {c.set + c.candidates > 0 ? <text x={cx} y={base - hs - hc - (hs > 0 && hc > 0 ? 2 : 0) - 5} textAnchor="middle" className="ciw-axis is-value">{c.set + c.candidates}</text> : null}
                <text x={cx} y={height - M.b + 14} textAnchor="middle" className="ciw-axis">{c.step.label}</text>
                <text x={cx} y={height - M.b + 27} textAnchor="middle" className="ciw-axis is-quiet">{c.step.factor}%</text>
              </g>
            )
          })}
        </svg>
      ) : null}
      {hover !== null && columns[hover] ? (
        <ChartTip x={M.l + slot * hover + slot / 2} y={M.t} width={width}>
          <b className="ciw-num-strong">{columns[hover].set} in the shown set · {columns[hover].candidates} other admissible</b>
          <span>sold {columns[hover].step.label} ago · the engine weighs recency at {columns[hover].step.factor}%</span>
        </ChartTip>
      ) : null}
    </div>
  )
}

/** A column with a 4px rounded data end and a square baseline. */
function roundTop(x: number, y: number, w: number, h: number, r = 4): string {
  const rr = Math.min(r, h, w / 2)
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`
}
