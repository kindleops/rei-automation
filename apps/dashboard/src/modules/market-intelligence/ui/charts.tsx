import { useCallback, useRef, useState, type ReactNode } from 'react'
import type { MiMonthStatus } from '../mi-types'
import { fmtMonth } from '../mi-format'
import { seriesColor } from './ui-model'

/**
 * Charts (dataviz rules): one y-axis, 2px lines, gaps stay gaps, recessive
 * grid, a crosshair + tooltip on hover, a legend for ≥ 2 series with direct
 * end labels, series colours from the themed --lc-chart-N tokens in fixed
 * order. Coverage is drawn, not hidden: pre-coverage months are hatched,
 * incomplete (recording-lag) months are a dashed band, and no line runs
 * through them as if they were market fact.
 */
export interface TrendSeries { id: string; label: string; points: Array<{ month: string; y: number | null; status: MiMonthStatus; n?: number }> }


function useWidth(): [(el: HTMLDivElement | null) => void, number] {
  const [w, setW] = useState(0)
  const ro = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect()
    if (!el) return
    ro.current = new ResizeObserver((entries) => setW(Math.round(entries[0]?.contentRect.width ?? 0)))
    ro.current.observe(el)
  }, [])
  return [ref, w]
}

export function TrendChart({ series, format, height = 180, label, showCoverage = true, emptyText = 'No data in this range' }: {
  series: TrendSeries[]; format: (v: number) => string; height?: number; label: string; showCoverage?: boolean; emptyText?: string
}) {
  const [ref, width] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const months = series[0]?.points.map((p) => p.month) ?? []
  const status = series[0]?.points.map((p) => p.status) ?? []
  const vals = series.flatMap((s) => s.points.map((p) => p.y)).filter((v): v is number => v !== null && Number.isFinite(v))
  const padL = 52, padR = series.length > 1 ? 86 : 14, padT = 10, padB = 22
  const W = Math.max(0, width), H = height
  const plotW = Math.max(10, W - padL - padR), plotH = H - padT - padB
  const lo = vals.length ? Math.min(0, ...vals) : 0
  const hi = vals.length ? Math.max(...vals) : 1
  const span = hi - lo || 1
  const x = (i: number) => padL + (months.length <= 1 ? plotW / 2 : (i * plotW) / (months.length - 1))
  const y = (v: number) => padT + plotH - ((v - lo) / span) * plotH
  const ticks = [lo, lo + span / 2, hi]
  const xEvery = Math.max(1, Math.ceil(months.length / Math.max(2, Math.floor(plotW / 70))))
  const paths = series.map((s) => {
    let d = ''
    let pen = false
    s.points.forEach((p, i) => {
      if (p.y === null || !Number.isFinite(p.y) || p.status === 'pre_coverage') { pen = false; return }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`
      pen = true
    })
    return d
  })
  const bands: ReactNode[] = []
  if (showCoverage) {
    let i = 0
    while (i < status.length) {
      const st = status[i]
      if (st === 'covered') { i += 1; continue }
      let j = i
      while (j + 1 < status.length && status[j + 1] === st) j += 1
      const x0 = i === 0 ? padL : (x(i - 1) + x(i)) / 2
      const x1 = j === status.length - 1 ? padL + plotW : (x(j) + x(j + 1)) / 2
      bands.push(<rect key={`b${i}`} className={`mi-chart__band is-${st}`} x={x0} y={padT} width={Math.max(1, x1 - x0)} height={plotH}><title>{st === 'pre_coverage' ? 'Before sales coverage: sparse legacy records, not the market' : st === 'partial' ? 'Current month, partial' : 'Below 75% of the trailing median: may be incomplete (recording lag)'}</title></rect>)
      i = j + 1
    }
  }
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - r.left
    if (!months.length) return
    const i = Math.round(((px - padL) / plotW) * (months.length - 1))
    setHover(Math.max(0, Math.min(months.length - 1, i)))
  }
  if (!vals.length) return <div className="mi-chart is-empty" ref={ref}><span>{emptyText}</span></div>
  return (
    <div className="mi-chart" ref={ref}>
      {W > 0 ? (
        <svg width={W} height={H} role="img" aria-label={label} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <defs>
            <pattern id="mi-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" className="mi-chart__hatch" /></pattern>
          </defs>
          {bands}
          {ticks.map((t, k) => (
            <g key={k}>
              <line className="mi-chart__grid" x1={padL} x2={padL + plotW} y1={y(t)} y2={y(t)} />
              <text className="mi-chart__tick" x={padL - 8} y={y(t) + 4} textAnchor="end">{format(t)}</text>
            </g>
          ))}
          {months.map((m, i) => (i % xEvery === 0 || i === months.length - 1 ? <text key={m} className="mi-chart__tick" x={x(i)} y={H - 6} textAnchor="middle">{fmtMonth(m)}</text> : null))}
          {paths.map((d, k) => <path key={series[k].id} d={d} className="mi-chart__line" style={{ stroke: seriesColor(k) }} />)}
          {series.length === 1 ? series[0].points.map((p, i) => (p.y !== null && p.status !== 'pre_coverage' ? <circle key={i} cx={x(i)} cy={y(p.y)} r={p.status === 'covered' ? 2.5 : 3} className={p.status === 'covered' ? 'mi-chart__dot' : 'mi-chart__dot is-hollow'} style={{ stroke: seriesColor(0), fill: p.status === 'covered' ? seriesColor(0) : 'var(--lc-mat-float-bg)' }} /> : null)) : null}
          {series.length > 1 ? series.map((s, k) => {
            const last = [...s.points].reverse().find((p) => p.y !== null && p.status !== 'pre_coverage')
            const li = last ? s.points.lastIndexOf(last) : -1
            return last && li >= 0 ? <text key={s.id} className="mi-chart__end" x={x(li) + 6} y={y(last.y as number) + 4} style={{ fill: 'var(--lc-ink-2)' }}><tspan style={{ fill: seriesColor(k) }}>●</tspan> {s.label.length > 12 ? `${s.label.slice(0, 11)}…` : s.label}</text> : null
          }) : null}
          {hover !== null ? <line className="mi-chart__cross" x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + plotH} /> : null}
        </svg>
      ) : null}
      {hover !== null && W > 0 ? (
        <div className="mi-chart__tip" style={{ left: Math.min(W - 200, Math.max(0, x(hover) + 10)) }}>
          <strong>{fmtMonth(months[hover])}{status[hover] !== 'covered' ? <em> · {status[hover] === 'pre_coverage' ? 'pre-coverage' : status[hover] === 'partial' ? 'partial month' : 'may be incomplete'}</em> : null}</strong>
          {series.map((s, k) => {
            const p = s.points[hover]
            return <span key={s.id}><i style={{ background: seriesColor(k) }} />{s.label}<b>{p?.y === null || p?.y === undefined ? '—' : format(p.y)}</b>{p?.n !== undefined ? <small>n {p.n}</small> : null}</span>
          })}
        </div>
      ) : null}
      {series.length > 1 ? (
        <div className="mi-chart__legend" aria-label="Legend">{series.map((s, k) => <span key={s.id}><i style={{ background: seriesColor(k) }} />{s.label}</span>)}</div>
      ) : null}
    </div>
  )
}

/** Horizontal distribution bars: label · bar · count (and share). */
export function DistBars({ rows, total, label }: { rows: Array<{ label: string; n: number; muted?: boolean }>; total?: number; label: string }) {
  const sum = total ?? rows.reduce((t, r) => t + r.n, 0)
  const max = Math.max(1, ...rows.map((r) => r.n))
  if (!sum) return <p className="mi-quiet">None in this period.</p>
  return (
    <ul className="mi-bars" aria-label={label}>
      {rows.map((r) => (
        <li key={r.label} className={r.muted ? 'is-muted' : undefined}>
          <span className="mi-bars__l">{r.label}</span>
          <span className="mi-bars__track"><i style={{ width: `${(r.n / max) * 100}%` }} /></span>
          <span className="mi-bars__v">{r.n.toLocaleString('en-US')}<small>{sum ? ` ${Math.round((r.n / sum) * 100)}%` : ''}</small></span>
        </li>
      ))}
    </ul>
  )
}
