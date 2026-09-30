/**
 * TREND — one metric over the period, the comparison window aligned by bucket.
 *
 * SVG with one path per series (≤ 400 points, so no node explosion), a
 * Wilson band for rates, a crosshair that snaps to the nearest bucket and ONE
 * tooltip listing both series. Clicking a bucket opens its exact records.
 * Buckets still "maturing" (recent cohorts that have had less time to reply)
 * are shaded and said to be so, never extrapolated.
 */
import { useMemo, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import type { SeriesPoint } from '../../../../domain/analytics/analytics-lab-api'
import { useElementWidth } from '../lab-state'
import { ROLE, clamp, fmtBucket, labelIndices, niceTicks } from './chart-kit'

type Props = {
  current: SeriesPoint[]
  comparison?: SeriesPoint[] | null
  unit: 'count' | 'rate' | 'ratio' | 'duration_min'
  grain: string
  tz: string
  format: (v: number | null) => string
  label: string
  currentLabel: string
  compareLabel?: string | null
  minSample?: number | null
  maturingFrom?: number | null
  height?: number
  onPick?: (i: number, p: SeriesPoint) => void
}

const M = { l: 48, r: 14, t: 14, b: 28 }

export function TrendChart({ current, comparison, unit, grain, tz, format, label, currentLabel, compareLabel, minSample, maturingFrom, height = 260, onPick }: Props) {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const n = current.length
  const W = Math.max(280, width)
  const H = height
  const iw = W - M.l - M.r
  const ih = H - M.t - M.b
  const isRate = unit === 'rate'

  const { ticks, hi } = useMemo(() => {
    const vals: number[] = []
    for (const p of current) { if (p.value !== null) vals.push(p.value); if (isRate && p.ci && (p.den ?? 0) >= 5) vals.push(p.ci.high) }
    for (const p of comparison || []) if (p.value !== null) vals.push(p.value)
    const max = vals.length ? Math.max(...vals) : 1
    return niceTicks(0, max > 0 ? max * 1.04 : isRate ? 0.1 : 1, 4)
  }, [current, comparison, isRate])

  const x = (i: number) => M.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw)
  const y = (v: number) => M.t + ih - (clamp(v, 0, hi) / (hi || 1)) * ih
  const path = (pts: Array<SeriesPoint | undefined>) => {
    let d = ''
    let pen = false
    pts.forEach((p, i) => {
      if (!p || p.value === null || p.value === undefined) { pen = false; return }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`
      pen = true
    })
    return d
  }
  const band = useMemo(() => {
    if (!isRate) return ''
    const up: string[] = []
    const down: string[] = []
    current.forEach((p, i) => {
      if (p.ci && p.value !== null && (p.den ?? 0) > 0) { up.push(`${x(i).toFixed(1)},${y(p.ci.high).toFixed(1)}`); down.unshift(`${x(i).toFixed(1)},${y(p.ci.low).toFixed(1)}`) }
    })
    return up.length > 1 ? `M${up.join('L')}L${down.join('L')}Z` : ''
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, isRate, W, hi])
  const cmp = comparison && comparison.length ? comparison : null
  const matIdx = maturingFrom ? current.findIndex((p) => p.start >= maturingFrom) : -1
  const labels = labelIndices(n, iw, grain === 'hour' ? 54 : 70)
  const last = [...current].reverse().find((p) => p.value !== null)
  const lastIdx = last ? current.lastIndexOf(last) : -1

  const pick = (clientX: number, rect: DOMRect) => {
    if (!n) return
    const rel = clientX - rect.left - M.l
    setHover(clamp(Math.round((rel / Math.max(1, iw)) * (n - 1)), 0, n - 1))
  }
  const onMove = (e: PointerEvent<SVGSVGElement>) => pick(e.clientX, e.currentTarget.getBoundingClientRect())
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight') { setHover((h) => clamp((h ?? -1) + 1, 0, n - 1)); e.preventDefault() }
    else if (e.key === 'ArrowLeft') { setHover((h) => clamp((h ?? n) - 1, 0, n - 1)); e.preventDefault() }
    else if ((e.key === 'Enter' || e.key === ' ') && hover !== null && onPick) { onPick(hover, current[hover]); e.preventDefault() }
    else if (e.key === 'Escape') setHover(null)
  }
  const hp = hover !== null ? current[hover] : null
  const hc = hover !== null && cmp ? cmp[hover] : null
  const tipLeft = hover !== null ? clamp(x(hover) + 14, 8, W - 232) : 0
  const summary = `${label}: ${n} ${grain} points. Latest ${last ? format(last.value) : 'no data'}.`

  return (
    <div className="lab-trend" ref={ref}>
      {cmp ? (
        <div className="lab-legend" aria-hidden="true">
          <span><i className="lab-key is-primary" />{currentLabel}</span>
          <span><i className="lab-key is-compare" />{compareLabel}</span>
          {isRate ? <span><i className="lab-key is-band" />95% interval</span> : null}
        </div>
      ) : null}
      <svg
        width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} tabIndex={0}
        onPointerMove={onMove} onPointerLeave={() => setHover(null)} onKeyDown={onKey}
        onClick={() => { if (hover !== null && onPick && current[hover]) onPick(hover, current[hover]) }}
        className={onPick ? 'is-pickable' : undefined}
      >
        {matIdx >= 0 ? <rect x={x(Math.max(0, matIdx - 0.5))} y={M.t} width={Math.max(0, W - M.r - x(Math.max(0, matIdx - 0.5)))} height={ih} className="lab-maturing" /> : null}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} stroke={ROLE.grid} strokeWidth={1} shapeRendering="crispEdges" />
            <text x={M.l - 8} y={y(t)} dy="0.32em" textAnchor="end" className="lab-tick">{format(t)}</text>
          </g>
        ))}
        {labels.map((i) => <text key={i} x={x(i)} y={H - 8} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} className="lab-tick">{current[i] ? fmtBucket(current[i].start, grain, tz) : ''}</text>)}
        {band ? <path d={band} className="lab-band" /> : null}
        {cmp ? <path d={path(cmp)} fill="none" stroke={ROLE.compare} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" /> : null}
        <path d={path(current)} fill="none" stroke={ROLE.primary} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className="lab-line" />
        {current.map((p, i) => (p.value !== null && minSample && (p.den ?? p.n ?? 0) > 0 && (p.den ?? p.n ?? 0) < Math.min(10, minSample) && n <= 90
          ? <circle key={i} cx={x(i)} cy={y(p.value)} r={2.5} className="lab-thin" />
          : null))}
        {last && lastIdx >= 0 ? <circle cx={x(lastIdx)} cy={y(last.value as number)} r={4} fill={ROLE.primary} className="lab-enddot" /> : null}
        {hover !== null ? (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={M.t} y2={M.t + ih} className="lab-cross" />
            {hp && hp.value !== null ? <circle cx={x(hover)} cy={y(hp.value)} r={4.5} fill={ROLE.primary} className="lab-enddot" /> : null}
            {hc && hc.value !== null ? <circle cx={x(hover)} cy={y(hc.value)} r={3.5} fill={ROLE.compare} className="lab-enddot" /> : null}
          </g>
        ) : null}
      </svg>
      {hp ? (
        <div className="lab-tip" style={{ left: tipLeft, top: 8 }} role="status">
          <div className="lab-tip__when">{fmtBucket(hp.start, grain, tz, true)}{matIdx >= 0 && hover !== null && hover >= matIdx ? <em> · maturing</em> : null}</div>
          <div className="lab-tip__row"><i className="lab-key is-primary" /><b>{format(hp.value)}</b>{isRate && hp.den !== undefined ? <span>{hp.num}/{hp.den}</span> : hp.n !== undefined && unit !== 'count' ? <span>n={hp.n}</span> : null}</div>
          {hp.ci && isRate && (hp.den ?? 0) > 0 ? <div className="lab-tip__sub">95% {format(hp.ci.low)} – {format(hp.ci.high)}</div> : null}
          {hc ? <div className="lab-tip__row is-compare"><i className="lab-key is-compare" /><b>{format(hc.value)}</b><span>{fmtBucket(hc.start, grain, tz, true)}</span></div> : null}
          {onPick ? <div className="lab-tip__hint">Click for the records</div> : null}
        </div>
      ) : null}
    </div>
  )
}

/** The table twin of a trend (WCAG-clean equivalent). */
export function TrendTable({ current, comparison, grain, tz, format, unit }: Pick<Props, 'current' | 'comparison' | 'grain' | 'tz' | 'format' | 'unit'>) {
  return (
    <div className="lab-tablewrap">
      <table className="lab-table">
        <thead><tr><th>{grain}</th><th>Value</th>{unit === 'rate' ? <><th>Num</th><th>Den</th><th>95% CI</th></> : <th>n</th>}{comparison ? <th>Comparison</th> : null}</tr></thead>
        <tbody>
          {current.map((p, i) => (
            <tr key={p.start}>
              <th>{fmtBucket(p.start, grain, tz, true)}</th>
              <td>{format(p.value)}</td>
              {unit === 'rate' ? <><td>{p.num ?? '—'}</td><td>{p.den ?? '—'}</td><td>{p.ci ? `${format(p.ci.low)} – ${format(p.ci.high)}` : '—'}</td></> : <td>{p.n ?? '—'}</td>}
              {comparison ? <td>{format(comparison[i]?.value ?? null)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
