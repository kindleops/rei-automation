import { useMemo, type ReactNode } from 'react'
import { AnimatedCounter } from '../arc/animated-counter/animated-counter'
import { Icon } from '../icons'
import { cx } from './cx'
import { useLcReducedMotion } from './motion'
import './lc-data.css'
import '../arc/lc-arc.css'

/**
 * Metrics — value, label, delta, comparison, sample size and definition,
 * composed in place (never forced into a card). LCMetric renders numbers it
 * is GIVEN: it does not compute conversion or decide what is good.
 */

export interface LCDeltaProps {
  /** pre-formatted change: "+2.9 pts", "−18%" */
  text: string
  tone?: 'good' | 'bad' | 'neutral'
  /** what it's compared with: "vs previous 30D" */
  against?: string
}

export function LCDelta({ text, tone = 'neutral', against }: LCDeltaProps) {
  return (
    <span className={cx('lc-delta', `is-${tone}`)}>
      <span className="lc-num">{text}</span>
      {against ? <small>{against}</small> : null}
    </span>
  )
}

export interface LCMetricProps {
  label: ReactNode
  /** the formatted value; null renders an honest dash */
  value: ReactNode | null
  /** numeric value to animate between (with format) — optional */
  numeric?: { value: number; decimals?: number; prefix?: string; suffix?: string } | null
  unit?: string
  delta?: LCDeltaProps | null
  /** "248 of 2,091 delivered" — the denominator in words */
  basis?: ReactNode
  /** "n = 18 · small sample" */
  sample?: { n: number; min: number } | null
  /** opens the definition (metric inspector / popover) */
  onDefine?: () => void
  /** a tiny trend beside the number */
  spark?: ReadonlyArray<number | null>
  size?: 'xl' | 'lg' | 'md' | 'sm'
  tone?: 'exec' | 'ok' | 'attn' | 'crit' | 'flow' | null
  status?: ReactNode
  onClick?: () => void
  selected?: boolean
  loading?: boolean
  className?: string
}

export function LCMetric({ label, value, numeric, unit, delta, basis, sample, onDefine, spark, size = 'md', tone, status, onClick, selected, loading, className }: LCMetricProps) {
  const thin = sample ? sample.n < sample.min : false
  const body = (
    <>
      <span className="lc-metric__label">
        <span>{label}</span>
        {onDefine ? (
          <span
            role="button"
            tabIndex={0}
            className="lc-metric__def"
            aria-label="Definition"
            onClick={(e) => { e.stopPropagation(); onDefine() }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onDefine() } }}
          >
            <Icon name="hash" size={10} />
          </span>
        ) : null}
      </span>
      <span className="lc-metric__line">
        {loading ? (
          <i className="lc-skel lc-metric__skel" />
        ) : value === null || value === undefined ? (
          <b className="lc-metric__value is-none">—</b>
        ) : (
          <b className={cx('lc-metric__value', thin && 'is-thin')} data-tone={tone || undefined}>
            {numeric ? <LCCounter value={numeric.value} decimals={numeric.decimals} prefix={numeric.prefix} suffix={numeric.suffix} /> : value}
            {unit ? <span className="lc-unit">{unit}</span> : null}
          </b>
        )}
        {spark && spark.length > 1 ? <LCSparkline values={spark} className="lc-metric__spark" label={typeof label === 'string' ? `${label} trend` : 'Trend'} /> : null}
      </span>
      {delta ? <LCDelta {...delta} /> : null}
      {basis || sample ? (
        <span className="lc-metric__basis">
          {basis}
          {sample ? <span className={cx(thin && 'is-thin')}>{basis ? ' · ' : ''}n = {sample.n.toLocaleString('en-US')}{thin ? ' · small sample' : ''}</span> : null}
        </span>
      ) : null}
      {status ? <span className="lc-metric__status">{status}</span> : null}
    </>
  )
  const cls = cx('lc-metric', `is-${size}`, selected && 'is-selected', onClick && 'is-clickable', className)
  return onClick
    ? <button type="button" className={cls} onClick={onClick} aria-pressed={selected}>{body}</button>
    : <div className={cls}>{body}</div>
}

/**
 * LCCounter — numbers move only when they actually change, never on a
 * refresh that returns the same value and never on first paint. Arc's free
 * Animated Counter (MIT) supplies the odometer; reduced motion swaps.
 */
export function LCCounter({ value, decimals = 0, prefix, suffix, label }: { value: number; decimals?: number; prefix?: string; suffix?: string; label?: string }) {
  const reduced = useLcReducedMotion()
  const fmt = useMemo(() => new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }), [decimals])
  if (reduced || !Number.isFinite(value)) return <span className="lc-num">{prefix}{Number.isFinite(value) ? fmt.format(value) : '—'}{suffix}</span>
  return <span className="lc-arc lc-counter"><AnimatedCounter value={value} decimals={decimals} prefix={prefix} suffix={suffix} label={label} /></span>
}

export interface LCSparklineProps {
  values: ReadonlyArray<number | null>
  width?: number
  height?: number
  tone?: 'exec' | 'ok' | 'attn' | 'crit' | 'flow' | 'accent' | 'neutral'
  area?: boolean
  label: string
  className?: string
}

/** A compact trend — only where the trend adds meaning, never beside every number. */
export function LCSparkline({ values, width = 64, height = 20, tone = 'exec', area = true, label, className }: LCSparklineProps) {
  const pts = values.map((v, i) => ({ i, v }))
  const real = pts.filter((p) => typeof p.v === 'number' && Number.isFinite(p.v)) as Array<{ i: number; v: number }>
  if (real.length < 2) return null
  const min = Math.min(...real.map((p) => p.v))
  const max = Math.max(...real.map((p) => p.v))
  const span = max - min || 1
  const x = (i: number) => (i / Math.max(1, values.length - 1)) * (width - 2) + 1
  const y = (v: number) => height - 2 - ((v - min) / span) * (height - 4)
  // gaps stay gaps: a missing bucket breaks the line rather than inventing a value
  let d = ''
  let prev = -2
  for (const p of real) { d += `${p.i === prev + 1 ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`; prev = p.i }
  const lastP = real[real.length - 1]
  const firstP = real[0]
  const areaD = `${d}L${x(lastP.i).toFixed(1)},${height}L${x(firstP.i).toFixed(1)},${height}Z`
  const first = real[0].v
  const last = lastP.v
  return (
    <svg className={cx('lc-spark', className)} data-tone={tone} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}: from ${first.toLocaleString('en-US')} to ${last.toLocaleString('en-US')}`}>
      {area ? <path d={areaD} className="lc-spark__area" /> : null}
      <path d={d} className="lc-spark__line" />
      <circle cx={x(lastP.i)} cy={y(last)} r={1.8} className="lc-spark__dot" />
    </svg>
  )
}
