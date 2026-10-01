import { useMemo, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { LC_SPRING, lcTransition, useLcReducedMotion } from '../../../../shared/lc'
import { fmtMoney } from '../../../../domain/comp-intelligence/comps-workstation-model'
import type { FocusStore } from '../focus-store'
import { useFocus } from '../focus-store'
import { ChartTip } from './chart-kit'
import { linear, niceTicks, padDomain, useElementWidth } from './chart-math'

export interface SpectrumBand { id: 'engine' | 'operator'; label: string; low: number; mid: number; high: number; provenance: ReactNode }
export interface SpectrumMarker { id: string; label: string; value: number; tone: 'context' | 'attn'; provenance: ReactNode }
export interface SpectrumTick { key: string; value: number; label: string }

const GUTTER = 74
const PAD_R = 14

/**
 * THE VALUATION SPECTRUM (§32–34, §139). Every source on one axis, each in
 * its own labelled row so nothing is told apart by colour alone: the
 * engine's value range, the operator set's replay of the same formula, and
 * context that is NOT valuation (record estimate, seller ask, engine offer,
 * last sale) as hairlines across both. Beneath, the adjusted value of every
 * comp in the shown set — the evidence the range is made of.
 */
export function ValuationSpectrum({ bands, markers, ticks, store, height: minHeight = 0 }: { bands: SpectrumBand[]; markers: SpectrumMarker[]; ticks: SpectrumTick[]; store: FocusStore; height?: number }) {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const reduced = useLcReducedMotion()
  const focus = useFocus(store)
  const [tip, setTip] = useState<{ x: number; y: number; body: ReactNode } | null>(null)

  // The axis is fitted to the evidence; context within reach stays on it,
  // context far outside is pinned at the edge with its value (never dropped).
  const domain = useMemo(() => {
    const core = [...bands.flatMap((b) => [b.low, b.high]), ...ticks.map((t) => t.value)]
    if (!core.length) return padDomain(markers.map((m) => m.value), 0.06)
    const [c0, c1] = padDomain(core, 0.04)
    const reach = (c1 - c0) * 0.55
    return padDomain([...core, ...markers.map((m) => m.value).filter((v) => v >= c0 - reach && v <= c1 + reach)], 0.05)
  }, [bands, markers, ticks])
  const x = linear(domain[0], domain[1], GUTTER, Math.max(GUTTER + 40, width - PAD_R))
  const axisTicks = niceTicks(domain[0], domain[1], width < 520 ? 3 : 5)

  // markers: greedy rows so labels never collide
  const rowEnds: number[] = []
  const lo = x(domain[0])
  const hi = x(domain[1])
  const placed = [...markers].sort((a, b) => a.value - b.value).map((m) => {
    const off = m.value < domain[0] ? -1 : m.value > domain[1] ? 1 : 0
    const px = off < 0 ? lo : off > 0 ? hi : x(m.value)
    const w = m.label.length * 6.2 + 54 + (off ? 52 : 0)
    const start = off > 0 ? px - w : px
    let row = rowEnds.findIndex((end) => end < start - 6)
    if (row < 0) { row = rowEnds.length; rowEnds.push(0) }
    rowEnds[row] = off > 0 ? px : px + w
    return { ...m, px, row, off }
  })
  const markerRows = placed.reduce((n, m) => Math.max(n, m.row + 1), 0)

  const TOP = 20
  const markerBlock = markerRows * 16
  const bandTop = TOP + markerBlock + 10
  const BAND_H = 16
  const BAND_GAP = 12
  const rugTop = bandTop + bands.length * (BAND_H + BAND_GAP) + 4
  const height = Math.max(minHeight, rugTop + (ticks.length ? 22 : 4))

  const show = (px: number, py: number, body: ReactNode) => setTip({ x: px, y: py, body })

  return (
    <div ref={ref} className="ciw-spectrum" style={{ height }} onPointerLeave={() => { setTip(null); store.hover(null, null) }}>
      {width > 0 ? (
        <svg width={width} height={height} role="img" aria-label={bands.map((b) => `${b.label}: ${fmtMoney(b.low)} to ${fmtMoney(b.high)}, central ${fmtMoney(b.mid)}`).join('; ')}>
          {axisTicks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={TOP - 4} y2={height - 2} className="ciw-grid" />
              <text x={x(t)} y={11} className="ciw-axis" textAnchor="middle">{fmtMoney(t)}</text>
            </g>
          ))}

          {placed.map((m) => (
            <g
              key={m.id}
              className={`ciw-spec-marker is-${m.tone}`}
              tabIndex={0}
              role="img"
              aria-label={`${m.label} ${fmtMoney(m.value, { exact: true })}`}
              onPointerEnter={() => show(m.px, TOP + m.row * 16, m.provenance)}
              onFocus={() => show(m.px, TOP + m.row * 16, m.provenance)}
              onBlur={() => setTip(null)}
            >
              {m.off === 0 ? <line x1={m.px} x2={m.px} y1={TOP + m.row * 16 + 6} y2={rugTop - 2} className="ciw-spec-marker__rule" /> : null}
              {m.off === 0
                ? <path d={`M${m.px} ${TOP + m.row * 16 - 1} l4 4 l-4 4 l-4 -4 z`} className="ciw-spec-marker__mark" />
                : <path d={m.off < 0 ? `M${m.px} ${TOP + m.row * 16 + 3} l6 -4 v8 z` : `M${m.px} ${TOP + m.row * 16 + 3} l-6 -4 v8 z`} className="ciw-spec-marker__mark" />}
              <text x={m.off > 0 ? m.px - 9 : m.px + 8} y={TOP + m.row * 16 + 6.5} textAnchor={m.off > 0 ? 'end' : 'start'} className="ciw-spec-marker__label">{m.off ? 'off scale · ' : ''}{m.label} <tspan className="ciw-num-strong">{fmtMoney(m.value)}</tspan></text>
              <rect x={m.px - 10} y={TOP + m.row * 16 - 4} width={Math.max(24, m.label.length * 6.2 + 54)} height={16} fill="transparent" />
            </g>
          ))}

          {bands.map((b, i) => {
            const y = bandTop + i * (BAND_H + BAND_GAP)
            const x0 = x(b.low)
            const x1 = x(b.high)
            const xm = x(b.mid)
            return (
              <g key={b.id} className={`ciw-spec-band is-${b.id}`} onPointerEnter={() => show(xm, y, b.provenance)} tabIndex={0} role="img" aria-label={`${b.label} ${fmtMoney(b.low, { exact: true })} to ${fmtMoney(b.high, { exact: true })}`} onFocus={() => show(xm, y, b.provenance)} onBlur={() => setTip(null)}>
                <text x={0} y={y + BAND_H / 2 + 4} className="ciw-spec-band__label">{b.label}</text>
                <motion.rect
                  initial={false}
                  animate={{ x: x0, width: Math.max(2, x1 - x0) }}
                  transition={lcTransition(reduced, LC_SPRING.morph)}
                  y={y}
                  height={BAND_H}
                  rx={5}
                  className="ciw-spec-band__range"
                />
                <motion.line
                  initial={false}
                  animate={{ x1: xm, x2: xm }}
                  transition={lcTransition(reduced, LC_SPRING.morph)}
                  y1={y - 4}
                  y2={y + BAND_H + 4}
                  className="ciw-spec-band__mid"
                />
                <rect x={x0 - 6} y={y - 6} width={Math.max(14, x1 - x0 + 12)} height={BAND_H + 12} fill="transparent" />
              </g>
            )
          })}

          {ticks.length ? (
            <g className="ciw-spec-rug">
              <text x={0} y={rugTop + 10} className="ciw-spec-band__label is-quiet">Comps</text>
              {ticks.map((t) => {
                const px = x(t.value)
                const hot = focus.hover === t.key || focus.selected === t.key
                return (
                  <g key={t.key}
                    onPointerEnter={() => { store.hover(t.key, 'chart'); show(px, rugTop, <><b className="ciw-num-strong">{fmtMoney(t.value, { exact: true })}</b><span>adjusted to the subject · {t.label}</span></>) }}
                    onClick={() => store.select(t.key)}
                  >
                    <line x1={px} x2={px} y1={rugTop} y2={rugTop + 12} className={`ciw-spec-rug__tick${hot ? ' is-hot' : ''}`} />
                    <rect x={px - 5} y={rugTop - 2} width={10} height={16} fill="transparent" />
                  </g>
                )
              })}
            </g>
          ) : null}
        </svg>
      ) : null}
      {tip ? <ChartTip x={tip.x} y={tip.y} width={width}>{tip.body}</ChartTip> : null}
    </div>
  )
}
