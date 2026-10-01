import { useMemo, useState } from 'react'
import { count, dur, pct } from '../lib/format'
import type { AnalyticsBucket, AnalyticsDay, Distribution } from '../lib/types'

/**
 * Native charts for Workflow Studio analytics (no third-party chart seam).
 * Marks follow the LeadCommand data-viz rules: columns ≤ 24px with a 4px
 * rounded data-end anchored to one baseline, a 2px surface gap between
 * touching marks, hairline solid grids, single-hue sequential ramps, a legend
 * whenever two or more series share a plot, values in text ink (never in the
 * series colour) and a hover/focus readout on every mark.
 */

const histLabel = (lo: number, hi: number | null) => (hi === null ? `≥ ${dur(lo)}` : lo === 0 ? `< ${dur(hi)}` : `${dur(lo)} – ${dur(hi)}`)

/** A latency / dwell distribution: log-bucket histogram + p50 · p75 · p95. */
export function DistributionBars({ d, tone = 'exec', unit = 'runs' }: { d: Distribution; tone?: 'exec' | 'attn' | 'flow' | 'gold'; unit?: string }) {
  const [hover, setHover] = useState<number | null>(null)
  if (!d.samples) return <p className="ws4-quiet">No measured samples.</p>
  const max = Math.max(1, ...d.histogram.map((b) => b.count))
  const h = d.histogram
  const at = hover !== null ? h[hover] : null
  const markFor = (v: number | null) => {
    if (v === null) return null
    const i = h.findIndex((b) => v >= b.lo && (b.hi === null || v < b.hi))
    return i < 0 ? null : (i + 0.5) / h.length
  }
  const marks = ([['p50', d.p50], ['p75', d.p75], ['p95', d.p95]] as const).map(([k, v]) => ({ k, v, x: markFor(v) })).filter((m) => m.x !== null)
  return (
    <figure className="ws4-dist" data-tone={tone}>
      <div className="ws4-dist__readout" aria-live="polite">
        {at ? <><b className="lc-num">{count(at.count)}</b><span>{unit} · {histLabel(at.lo, at.hi)}</span></> : <><b className="lc-num">{dur(d.p50)}</b><span>median · p75 {dur(d.p75)} · p95 {dur(d.p95)} · {count(d.samples)} samples</span></>}
      </div>
      <div className="ws4-dist__plot" onMouseLeave={() => setHover(null)}>
        <div className="ws4-dist__bars" style={{ gridTemplateColumns: `repeat(${h.length}, minmax(0, 1fr))` }}>
          {h.map((b, i) => (
            <button
              key={i}
              type="button"
              className={`ws4-dist__col${hover === i ? ' is-on' : ''}`}
              style={{ ['--h' as string]: `${(b.count / max) * 100}%` }}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              aria-label={`${histLabel(b.lo, b.hi)}: ${b.count} ${unit}`}
            ><i /></button>
          ))}
        </div>
        {marks.map((m) => <span key={m.k} className="ws4-dist__mark" style={{ left: `${m.x! * 100}%` }}><em>{m.k}</em></span>)}
      </div>
      <figcaption className="ws4-dist__axis"><span>{dur(h[0]?.lo ?? 0)}</span><span>{h[h.length - 1]?.hi === null ? `${dur(h[h.length - 1]?.lo)}+` : dur(h[h.length - 1]?.hi ?? null)}</span></figcaption>
    </figure>
  )
}

export type DayMetric = 'runs' | 'human' | 'failed' | 'held'
const METRIC: Record<DayMetric, { label: string; tone: string }> = {
  runs: { label: 'runs', tone: 'exec' },
  human: { label: 'human interventions', tone: 'gold' },
  failed: { label: 'failures', tone: 'crit' },
  held: { label: 'holds', tone: 'attn' },
}

/** Quartile levels of the non-zero values (zero is its own level, never a tint). */
function levels(values: number[]): (v: number) => number {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b)
  if (!nz.length) return () => 0
  const q = (p: number) => nz[Math.min(nz.length - 1, Math.floor(p * (nz.length - 1)))]
  const t = [q(0.25), q(0.5), q(0.75)]
  return (v) => (v <= 0 ? 0 : v <= t[0] ? 1 : v <= t[1] ? 2 : v <= t[2] ? 3 : 4)
}

/** Daily rhythm as a calendar: weeks are columns, weekdays rows. */
export function DayHeatmap({ days, metric, onDay }: { days: AnalyticsDay[]; metric: DayMetric; onDay?: (date: string) => void }) {
  const [hover, setHover] = useState<AnalyticsDay | null>(null)
  const lv = useMemo(() => levels(days.map((d) => d[metric])), [days, metric])
  const cells = useMemo(() => {
    if (!days.length) return []
    const first = new Date(`${days[0].date}T12:00:00`)
    const lead = (first.getDay() + 6) % 7 // Monday-first
    return [...Array.from({ length: lead }, () => null), ...days]
  }, [days])
  const weeks = Math.ceil(cells.length / 7)
  const total = days.reduce((a, d) => a + d[metric], 0)
  return (
    <figure className="ws4-heat" data-tone={METRIC[metric].tone}>
      <div className="ws4-heat__readout" aria-live="polite">
        {hover ? <><b className="lc-num">{count(hover[metric])}</b><span>{METRIC[metric].label} · {new Date(`${hover.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}{metric !== 'runs' && hover.runs ? ` · of ${count(hover.runs)} runs` : ''}</span></> : <><b className="lc-num">{count(total)}</b><span>{METRIC[metric].label} in {days.length} days</span></>}
      </div>
      <div className="ws4-heat__grid" style={{ gridTemplateColumns: `repeat(${weeks}, 14px)` }} role="grid" aria-label={`${METRIC[metric].label} per day`} onMouseLeave={() => setHover(null)}>
        {cells.map((d, i) => d ? (
          <button key={d.date} type="button" className="ws4-heat__cell" data-l={lv(d[metric])} style={{ gridColumn: Math.floor(i / 7) + 1, gridRow: (i % 7) + 1 }} onMouseEnter={() => setHover(d)} onFocus={() => setHover(d)} onClick={() => onDay?.(d.date)} aria-label={`${d.date}: ${d[metric]} ${METRIC[metric].label}`} />
        ) : <span key={`pad-${i}`} className="ws4-heat__pad" style={{ gridColumn: Math.floor(i / 7) + 1, gridRow: (i % 7) + 1 }} />)}
      </div>
      <figcaption className="ws4-scale"><span>Less</span>{[0, 1, 2, 3, 4].map((l) => <i key={l} data-l={l} />)}<span>More</span></figcaption>
    </figure>
  )
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const ORDER = [1, 2, 3, 4, 5, 6, 0]

/** Machine rhythm: weekday × hour (operator time zone). */
export function RhythmGrid({ cells, metric, tz }: { cells: Array<{ dow: number; hour: number; runs: number; human: number; failed: number }>; metric: 'runs' | 'human' | 'failed'; tz: string }) {
  const [hover, setHover] = useState<{ dow: number; hour: number; v: number } | null>(null)
  const map = useMemo(() => new Map(cells.map((c) => [`${c.dow}:${c.hour}`, c[metric]])), [cells, metric])
  const lv = useMemo(() => levels(cells.map((c) => c[metric])), [cells, metric])
  const hourLabel = (h: number) => (h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`)
  return (
    <figure className="ws4-rhythm" data-tone={METRIC[metric].tone}>
      <div className="ws4-heat__readout" aria-live="polite">
        {hover ? <><b className="lc-num">{count(hover.v)}</b><span>{METRIC[metric].label} · {DOW[hover.dow]} {hourLabel(hover.hour)}–{hourLabel((hover.hour + 1) % 24)}</span></> : <span>{METRIC[metric].label} by weekday and hour · {tz.replace('_', ' ')}</span>}
      </div>
      <div className="ws4-rhythm__grid" onMouseLeave={() => setHover(null)} role="grid" aria-label={`${METRIC[metric].label} by weekday and hour`}>
        {ORDER.map((dow) => (
          <div key={dow} className="ws4-rhythm__row" role="row">
            <span className="ws4-rhythm__dow">{DOW[dow]}</span>
            {Array.from({ length: 24 }, (_, hour) => {
              const v = map.get(`${dow}:${hour}`) || 0
              return <button key={hour} type="button" className="ws4-heat__cell" data-l={lv(v)} onMouseEnter={() => setHover({ dow, hour, v })} onFocus={() => setHover({ dow, hour, v })} aria-label={`${DOW[dow]} ${hourLabel(hour)}: ${v}`} />
            })}
          </div>
        ))}
        <div className="ws4-rhythm__hours" aria-hidden><span />{Array.from({ length: 24 }, (_, h) => <span key={h}>{h % 3 === 0 ? hourLabel(h) : ''}</span>)}</div>
      </div>
    </figure>
  )
}

const STATUS_SERIES: Array<{ k: keyof AnalyticsBucket; label: string; tone: string }> = [
  { k: 'completed', label: 'Completed', tone: 'ok' },
  { k: 'waiting', label: 'Waiting', tone: 'exec' },
  { k: 'running', label: 'Running', tone: 'exec2' },
  { k: 'needs_you', label: 'Needs you', tone: 'gold' },
  { k: 'held', label: 'Held', tone: 'attn' },
  { k: 'failed', label: 'Failed', tone: 'crit' },
  { k: 'cancelled', label: 'Withdrawn', tone: 'neutral' },
]

/** Runs over time, stacked by outcome; a column drills into its exact runs. */
export function StatusColumns({ series, label, onBucket }: { series: AnalyticsBucket[]; label: (b: AnalyticsBucket) => string; onBucket?: (b: AnalyticsBucket) => void }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...series.map((b) => b.total))
  const at = hover !== null ? series[hover] : null
  const present = STATUS_SERIES.filter((s) => series.some((b) => Number(b[s.k]) > 0))
  return (
    <figure className="ws4-cols">
      <div className="ws4-dist__readout" aria-live="polite">
        {at ? <><b className="lc-num">{count(at.total)}</b><span>runs · {label(at)}{present.filter((s) => Number(at[s.k]) > 0).map((s) => ` · ${count(Number(at[s.k]))} ${s.label.toLowerCase()}`).join('')}</span></> : <><b className="lc-num">{count(series.reduce((a, b) => a + b.total, 0))}</b><span>runs in the window — hover a column, click it for its runs</span></>}
      </div>
      <div className="ws4-cols__plot" onMouseLeave={() => setHover(null)} style={{ gridTemplateColumns: `repeat(${series.length}, minmax(0, 1fr))` }}>
        {series.map((b, i) => (
          <button key={b.at} type="button" className={`ws4-cols__col${hover === i ? ' is-on' : ''}`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onClick={() => onBucket?.(b)} aria-label={`${label(b)}: ${b.total} runs`} disabled={!b.total}>
            <span className="ws4-cols__stack" style={{ ['--h' as string]: `${(b.total / max) * 100}%` }}>
              {STATUS_SERIES.map((s) => (Number(b[s.k]) > 0 ? <i key={s.k} data-tone={s.tone} style={{ flexGrow: Number(b[s.k]) }} /> : null))}
            </span>
          </button>
        ))}
      </div>
      <figcaption className="ws4-legend-inline">{present.map((s) => <span key={s.k}><i data-tone={s.tone} />{s.label}</span>)}</figcaption>
    </figure>
  )
}

/** A rate as a thin meter with its population named. */
export function RateMeter({ value, of, tone = 'ok', label }: { value: number | null; of: string; tone?: string; label: string }) {
  return (
    <div className="ws4-meter" data-tone={tone} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.round(value * 100)} aria-label={label}>
      <i style={{ ['--w' as string]: `${value === null ? 0 : value * 100}%` }} />
      <span className="lc-t-meta">{value === null ? 'Not enough finished runs' : `${pct(value)} · ${of}`}</span>
    </div>
  )
}
