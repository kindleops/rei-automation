import { useCallback, useMemo, useRef, useState } from 'react'
import type { TimeSeriesPoint } from '../../../lib/data/kpiDashboardData'
import type { GeoMetric } from './geo-metric'

/**
 * A TOUCH-NATIVE trend chart.
 *
 * §7's rule is that no core chart interpretation may depend on hover, so this reads
 * the opposite way round from a desktop chart: the exact value is ALWAYS displayed
 * (the latest point by default), and dragging a finger across the plot moves the
 * readout. There is no tooltip, because a tooltip under a fingertip is under a
 * fingertip.
 *
 * Deliberately hand-drawn rather than pulled from a charting library: the whole
 * requirement is one series, one scrub and a readout, and a library would cost a
 * bundle for a component whose entire job is 40 lines of path maths.
 */

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

const W = 320
const H = 96
const PAD_X = 6
const PAD_Y = 10

export interface TouchTrendChartProps {
  points: TimeSeriesPoint[]
  metric: GeoMetric
  loading: boolean
}

export const TouchTrendChart = ({ points, metric, loading }: TouchTrendChartProps) => {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  const series = useMemo(
    () => points.map((point) => ({
      date: point.date,
      value: Number(point[metric.countKey] ?? 0),
    })),
    [points, metric.countKey],
  )

  const max = useMemo(() => series.reduce((best, p) => Math.max(best, p.value), 0), [series])

  const geometry = useMemo(() => {
    if (series.length === 0) return null
    const span = Math.max(1, series.length - 1)
    const scaleX = (index: number) => PAD_X + (index / span) * (W - PAD_X * 2)
    const scaleY = (value: number) => {
      if (max <= 0) return H - PAD_Y
      return H - PAD_Y - (value / max) * (H - PAD_Y * 2)
    }
    const line = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${scaleX(i).toFixed(1)},${scaleY(p.value).toFixed(1)}`).join(' ')
    const area = `${line} L${scaleX(series.length - 1).toFixed(1)},${H} L${scaleX(0).toFixed(1)},${H} Z`
    return { scaleX, scaleY, line, area }
  }, [series, max])

  const readoutIndex = activeIndex ?? (series.length > 0 ? series.length - 1 : null)
  const readout = readoutIndex != null ? series[readoutIndex] : null

  const handleScrub = useCallback((clientX: number) => {
    const svg = svgRef.current
    if (!svg || series.length === 0) return
    const rect = svg.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    setActiveIndex(Math.round(ratio * (series.length - 1)))
  }, [series.length])

  if (loading) {
    return <div className="geo-chart is-loading" role="status">Reading trend…</div>
  }

  if (series.length === 0 || !geometry) {
    return (
      <div className="geo-chart is-empty">
        <span>No daily series for this window.</span>
      </div>
    )
  }

  return (
    <div className="geo-chart">
      <div className="geo-chart__readout">
        <div>
          <span>{metric.label}</span>
          <b>{readout ? readout.value.toLocaleString() : '—'}</b>
        </div>
        <time dateTime={readout?.date}>{readout ? formatDay(readout.date) : ''}</time>
      </div>

      <svg
        ref={svgRef}
        className="geo-chart__svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${metric.label} per day. Latest ${readout?.value ?? 0} on ${readout?.date ?? 'unknown'}.`}
        /* Pointer events rather than touch events: one code path covers a finger, a
           stylus and a trackpad, and `setPointerCapture` keeps the scrub alive when
           the finger leaves the plot vertically — which it does constantly on a
           96px-tall chart. */
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          handleScrub(event.clientX)
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
          handleScrub(event.clientX)
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
          setActiveIndex(null)
        }}
        onPointerCancel={() => setActiveIndex(null)}
      >
        <path className={cls('geo-chart__area', metric.inverse && 'is-inverse')} d={geometry.area} />
        <path className={cls('geo-chart__line', metric.inverse && 'is-inverse')} d={geometry.line} />
        {readoutIndex != null ? (
          <>
            <line
              className="geo-chart__cursor"
              x1={geometry.scaleX(readoutIndex)}
              x2={geometry.scaleX(readoutIndex)}
              y1={0}
              y2={H}
            />
            <circle
              className="geo-chart__dot"
              cx={geometry.scaleX(readoutIndex)}
              cy={geometry.scaleY(series[readoutIndex].value)}
              r={3.5}
            />
          </>
        ) : null}
      </svg>

      <div className="geo-chart__axis">
        <span>{formatDay(series[0].date)}</span>
        <span>{formatDay(series[series.length - 1].date)}</span>
      </div>
    </div>
  )
}

const formatDay = (value: string): string => {
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
