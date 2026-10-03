import type { ReactNode } from 'react'
import { LCStatus, cx } from '../../../shared/lc'
import { barGeometry, catalogueEntry, formatValue, goalState, type CatalogueEntry, type GoalProgress } from './goals-model'

/**
 * GOAL INSTRUMENTS — the bar, the progress line and the readout, shared by the
 * Analytics Goals lens and the Home Goals widget. They draw only what the
 * server returned: no value is estimated here.
 */

/** Period-to-date against the target, with the linear-pace tick (additive counts only). */
export function GoalBar({ p, label }: { p: GoalProgress | null | undefined; label: string }) {
  const g = barGeometry(p)
  const tone = goalState(p).tone
  return (
    <div className={cx('gl-bar', `is-${tone}`, g.over && 'is-over')} role="img" aria-label={label}>
      <i className="gl-bar__fill" style={{ width: `${g.fill * 100}%` }} />
      {g.pace !== null ? <i className="gl-bar__pace" style={{ left: `${g.pace * 100}%` }} title="Linear pace: where the target would be if it accrued evenly over the period" /> : null}
    </div>
  )
}

/**
 * The running total across the period (the Lab's daily series), the straight
 * pace line to the target, and the period end. Drawn only when the series exists.
 */
export function GoalLine({ p, height = 46 }: { p: GoalProgress | null | undefined; height?: number }) {
  if (!p || p.status !== 'ok' || !p.cumulative?.length || !(p.target > 0)) return null
  const start = Date.parse(p.period.start)
  const end = Date.parse(p.period.end)
  const span = end - start
  if (!(span > 0)) return null
  const top = Math.max(p.target, p.projection ?? 0, p.cumulative[p.cumulative.length - 1].total) * 1.06
  const W = 240
  const x = (t: number) => ((t - start) / span) * W
  const y = (v: number) => height - (v / top) * (height - 4) - 2
  // "now" as the server measured it (render stays pure)
  const at = start + (p.period.elapsed ?? 0) * span
  const pts = p.cumulative.map((c, i) => {
    // each point is the running total at the END of its day bucket
    const t = i + 1 < p.cumulative!.length ? Date.parse(p.cumulative![i + 1].start) : Math.min(end, at)
    return `${x(t).toFixed(1)},${y(c.total).toFixed(1)}`
  })
  const path = `M${x(start).toFixed(1)},${y(0).toFixed(1)} L${pts.join(' L')}`
  const last = pts[pts.length - 1].split(',')
  return (
    <svg className="gl-line" viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" role="img" aria-label="Running total this period against the pace to target">
      <line className="gl-line__target" x1="0" x2={W} y1={y(p.target)} y2={y(p.target)} />
      <line className="gl-line__pace" x1={x(start)} y1={y(0)} x2={x(end)} y2={y(p.target)} />
      {p.projection !== null ? <line className="gl-line__proj" x1={last[0]} y1={last[1]} x2={x(end)} y2={y(p.projection)} /> : null}
      <path className="gl-line__actual" d={path} />
      <circle className="gl-line__now" cx={last[0]} cy={last[1]} r="2.6" />
    </svg>
  )
}

/** "312 of 600 · On pace" — or the Lab's own status, verbatim. */
export function GoalReadout({ p, catalogue, metricId, compact }: { p: GoalProgress | null | undefined; catalogue: ReadonlyArray<CatalogueEntry>; metricId: string; compact?: boolean }) {
  const unit = catalogueEntry(catalogue, metricId)?.unit
  const s = goalState(p)
  const known = p && (p.status === 'ok' || p.status === 'insufficient_sample') && p.current !== null
  return (
    <div className={cx('gl-read', compact && 'is-compact')}>
      <span className="gl-read__v">
        <b>{known ? formatValue(p!.current, unit) : '—'}</b>
        {p ? <small>of {formatValue(p.target, unit)}</small> : null}
      </span>
      <LCStatus label={s.label} tone={s.tone} quiet hollow={s.tone === 'neutral'} title={s.detail ?? undefined} />
    </div>
  )
}

/** Small labelled facts — null reads "—", never 0. */
export function GoalFacts({ items }: { items: Array<{ k: string; v: ReactNode; title?: string; modeled?: boolean }> }) {
  return (
    <dl className="gl-facts">
      {items.map((f) => (
        <div key={f.k} title={f.title}>
          <dt>{f.k}{f.modeled ? <em> modeled</em> : null}</dt>
          <dd>{f.v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  )
}
