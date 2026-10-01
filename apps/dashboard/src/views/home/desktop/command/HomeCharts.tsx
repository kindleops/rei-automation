import { useId, useMemo } from 'react'
import type { AnalyticsPerformance, RateCompare } from '../../../../domain/analytics/analytics-performance-api'
import { fmtPct } from '../../../../domain/analytics/analytics-performance-api'
import { formatCount } from '../../home-signals'

/**
 * Home's charts: drawn by hand in SVG so they sit in the glass like the rest
 * of the surface (no chart-library chrome), and only from the analytics read
 * model's own series, rates, funnel and automation counts.
 */

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

type Series = AnalyticsPerformance['series']

function bucketLabel(at: string, bucket: AnalyticsPerformance['period']['bucket']): string {
  const d = new Date(at)
  if (!Number.isFinite(d.getTime())) return ''
  if (bucket === 'hour') return d.toLocaleTimeString([], { hour: 'numeric' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Smooth path through points (monotone-ish cardinal), in a W×H box. */
function smoothPath(pts: Array<[number, number]>): string {
  if (!pts.length) return ''
  if (pts.length === 1) return `M${pts[0][0]},${pts[0][1]}`
  let d = `M${pts[0][0]},${pts[0][1]}`
  for (let i = 0; i < pts.length - 1; i += 1) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[i + 1]
    const cx = (x0 + x1) / 2
    d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`
  }
  return d
}

/**
 * Messaging flow: deliveries as a filled field, seller replies as a line on
 * their own scale (they run ~1–5% of deliveries, so one axis would flatten
 * them), failures as hairline ticks along the floor.
 */
export function FlowChart({ series, bucket, still }: { series: Series; bucket: AnalyticsPerformance['period']['bucket']; still: boolean }) {
  const gid = useId().replace(/:/g, '')
  const W = 640
  const H = 168
  const PAD = { t: 14, r: 10, b: 22, l: 10 }
  const model = useMemo(() => {
    const n = series.length
    const maxD = Math.max(1, ...series.map((s) => s.delivered))
    const maxR = Math.max(1, ...series.map((s) => s.replied))
    const maxF = Math.max(1, ...series.map((s) => s.failed))
    const x = (i: number) => PAD.l + (n <= 1 ? (W - PAD.l - PAD.r) / 2 : (i / (n - 1)) * (W - PAD.l - PAD.r))
    const yD = (v: number) => PAD.t + (1 - v / maxD) * (H - PAD.t - PAD.b)
    const yR = (v: number) => PAD.t + (1 - v / maxR) * (H - PAD.t - PAD.b) * 0.92
    const dPts = series.map((s, i) => [x(i), yD(s.delivered)] as [number, number])
    const rPts = series.map((s, i) => [x(i), yR(s.replied)] as [number, number])
    const area = dPts.length ? `${smoothPath(dPts)} L${dPts[dPts.length - 1][0]},${H - PAD.b} L${dPts[0][0]},${H - PAD.b} Z` : ''
    const ticks = series.map((s, i) => ({ x: x(i), h: s.failed ? 3 + (s.failed / maxF) * 18 : 0 }))
    const labelEvery = Math.max(1, Math.ceil(n / 7))
    const labels = series.map((s, i) => ({ x: x(i), text: i % labelEvery === 0 || i === n - 1 ? bucketLabel(s.at, bucket) : '' }))
    const totals = series.reduce((t, s) => ({ delivered: t.delivered + s.delivered, replied: t.replied + s.replied, failed: t.failed + s.failed }), { delivered: 0, replied: 0, failed: 0 })
    return { area, line: smoothPath(dPts), reply: smoothPath(rPts), last: rPts[rPts.length - 1] ?? null, ticks, labels, totals }
  }, [series, bucket])

  if (!series.length) return <p className="ch-muted ch-chart__empty">No messaging in this period.</p>

  return (
    <div className="ch-flow">
      <div className="ch-flow__legend">
        <span className="is-delivered"><i />Delivered <b>{formatCount(model.totals.delivered)}</b></span>
        <span className="is-replied"><i />Replies <b>{formatCount(model.totals.replied)}</b></span>
        <span className="is-failed"><i />Failed <b>{formatCount(model.totals.failed)}</b></span>
      </div>
      <svg className={cls('ch-flow__svg', !still && 'is-drawn')} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Delivered ${model.totals.delivered}, replies ${model.totals.replied}, failed ${model.totals.failed}`}>
        <defs>
          <linearGradient id={`d${gid}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--ch-delivered)" stopOpacity="0.42" />
            <stop offset="1" stopColor="var(--ch-delivered)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => <line key={f} x1={PAD.l} x2={W - PAD.r} y1={PAD.t + f * (H - PAD.t - PAD.b)} y2={PAD.t + f * (H - PAD.t - PAD.b)} className="ch-gridline" />)}
        <path d={model.area} fill={`url(#d${gid})`} />
        <path d={model.line} className="ch-flow__delivered" vectorEffect="non-scaling-stroke" pathLength={1} />
        <path d={model.reply} className="ch-flow__replied" vectorEffect="non-scaling-stroke" pathLength={1} />
        {model.last ? <circle cx={model.last[0]} cy={model.last[1]} r="3.2" className="ch-flow__now" /> : null}
        {model.ticks.map((t, i) => (t.h ? <line key={i} x1={t.x} x2={t.x} y1={H - PAD.b} y2={H - PAD.b - t.h} className="ch-flow__failed" vectorEffect="non-scaling-stroke" /> : null))}
        {model.labels.map((l, i) => (l.text ? <text key={i} x={l.x} y={H - 6} className="ch-axis" textAnchor={i === 0 ? 'start' : i === model.labels.length - 1 ? 'end' : 'middle'}>{l.text}</text> : null))}
      </svg>
    </div>
  )
}

/** A rate against the prior period, honest about thin samples. */
export function RateDial({ label, rate, invert = false }: { label: string; rate: RateCompare; invert?: boolean }) {
  const cur = rate.cur
  const pct = cur == null ? 0 : Math.max(0, Math.min(1, cur))
  const R = 30
  const C = 2 * Math.PI * R
  const good = rate.pp == null ? null : invert ? rate.pp < 0 : rate.pp > 0
  return (
    <div className="ch-dial">
      <svg viewBox="0 0 80 80" aria-hidden="true">
        <circle cx="40" cy="40" r={R} className="ch-dial__track" />
        <circle cx="40" cy="40" r={R} className="ch-dial__value" strokeDasharray={`${C * pct} ${C}`} transform="rotate(-90 40 40)" />
      </svg>
      <div className="ch-dial__copy">
        <b>{fmtPct(cur)}</b>
        <span>{label}</span>
        {rate.pp != null ? (
          <small className={cls(good === true && 'is-good', good === false && 'is-bad')}>
            {rate.pp > 0 ? '▲' : rate.pp < 0 ? '▼' : '•'} {Math.abs(rate.pp).toFixed(1)} pts vs prior
          </small>
        ) : (
          <small title={`${rate.sample.cur} in the denominator`}>{rate.reliable ? 'no prior period to compare' : 'small sample'}</small>
        )}
      </div>
    </div>
  )
}

/** Where deals are in the lifecycle right now, widest first. */
export function StageFlow({ flow }: { flow: AnalyticsPerformance['flow'] }) {
  const groups = flow.groups.filter((g) => g.active > 0)
  const max = Math.max(1, ...groups.map((g) => g.active))
  if (!groups.length) return <p className="ch-muted ch-chart__empty">No live deals in the lifecycle.</p>
  return (
    <div className="ch-stageflow">
      {groups.map((g, i) => (
        <div key={g.key} className="ch-stageflow__row" style={{ ['--i' as string]: i }}>
          <span>{g.label}</span>
          <i style={{ width: `${Math.max(4, (g.active / max) * 100)}%` }} aria-hidden="true" />
          <b>{formatCount(g.active)}</b>
        </div>
      ))}
      <p className="ch-stageflow__foot">
        <b>{formatCount(flow.advancements)}</b> stage advancements in the period
        {flow.bottleneck ? <> · slowest at <b>{flow.bottleneck.label}</b> ({formatCount(flow.bottleneck.stalled)} stalled)</> : null}
      </p>
    </div>
  )
}

/** What the automation did, as one ribbon: succeeded, held by a gate, sent for review, failed. */
export function AutomationRibbon({ automation }: { automation: AnalyticsPerformance['automation'] }) {
  const parts = [
    { key: 'ok', label: 'Succeeded', value: automation.succeeded, tone: 'good' },
    { key: 'held', label: 'Held by a gate', value: automation.heldByGate, tone: 'warn' },
    { key: 'review', label: 'Sent for review', value: automation.needsReview, tone: 'info' },
    { key: 'failed', label: 'Failed', value: automation.failed, tone: 'bad' },
  ].filter((p) => p.value > 0)
  const total = parts.reduce((n, p) => n + p.value, 0)
  if (!automation.runs) return <p className="ch-muted ch-chart__empty">No automation runs in this period.</p>
  return (
    <div className="ch-auto">
      <div className="ch-auto__head"><b>{formatCount(automation.runs)}</b><span>automation runs</span></div>
      <div className="ch-auto__bar" role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(', ')}>
        {parts.map((p) => <i key={p.key} className={`is-${p.tone}`} style={{ flexGrow: p.value / Math.max(1, total) }} />)}
      </div>
      <ul className="ch-auto__legend">
        {parts.map((p) => <li key={p.key} className={`is-${p.tone}`}><i />{p.label} <b>{formatCount(p.value)}</b></li>)}
      </ul>
      {automation.decisions ? <p className="ch-muted">{formatCount(automation.decisions)} decisions · {formatCount(automation.escalated)} escalated to you</p> : null}
    </div>
  )
}

/**
 * The machine's heartbeat behind the header: deliveries per bucket over the
 * selected period, drawn large and quiet. Captioned, because a curve with no
 * name would read as decoration — it is the real series.
 */
export function HeroWave({ series, label, still }: { series: Series; label: string; still: boolean }) {
  const gid = useId().replace(/:/g, '')
  const W = 600
  const H = 150
  const pts = useMemo(() => {
    const vals = series.map((s) => s.delivered + s.replied)
    const max = Math.max(1, ...vals)
    const n = vals.length
    return vals.map((v, i) => [n <= 1 ? W / 2 : (i / (n - 1)) * W, 12 + (1 - v / max) * (H - 24)] as [number, number])
  }, [series])
  const total = series.reduce((n, s) => n + s.delivered, 0)
  if (pts.length < 2 || total === 0) return null
  const line = smoothPath(pts)
  const area = `${line} L${W},${H} L0,${H} Z`
  return (
    <div className="ch-wave" aria-hidden="true">
      <span className="ch-wave__label">Deliveries · {label}</span>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={cls(!still && 'is-drawn')}>
        <defs>
          <linearGradient id={`wf${gid}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--ch-accent)" stopOpacity="0.28" />
            <stop offset="1" stopColor="var(--ch-accent)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`ws${gid}`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="var(--ch-accent)" stopOpacity="0.15" />
            <stop offset="0.6" stopColor="var(--ch-accent)" stopOpacity="0.9" />
            <stop offset="1" stopColor="var(--ch-violet)" stopOpacity="1" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#wf${gid})`} />
        <path d={line} fill="none" stroke={`url(#ws${gid})`} strokeWidth="2" vectorEffect="non-scaling-stroke" pathLength={1} className="ch-wave__line" />
        <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="3.5" className="ch-wave__now" />
      </svg>
    </div>
  )
}
