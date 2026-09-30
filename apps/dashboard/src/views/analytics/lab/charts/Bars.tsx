/**
 * RANKED BARS / FOREST — one row per group, on one shared scale.
 *
 * Counts draw a bar; rates draw a dot with its Wilson 95% interval (a forest
 * plot), so a 2/3 "67%" never outshouts a 78/660 "11.8%". The prior-period
 * value is a tick on the same scale. Rows under the metric's minimum sample
 * are faded and say n. Test / proof campaigns sort last and are labelled; they
 * never rank. Every row is a button: drill (breadcrumb) or open its records.
 */
import type { CSSProperties } from 'react'
import type { BreakdownRow } from '../../../../domain/analytics/analytics-lab-api'
import { clamp, niceTicks } from './chart-kit'

type Props = {
  rows: BreakdownRow[]
  unit: 'count' | 'rate' | 'ratio' | 'duration_min'
  format: (v: number | null) => string
  showPrev?: boolean
  onPick?: (row: BreakdownRow) => void
  onRecords?: (row: BreakdownRow) => void
  maxRows?: number
  pickLabel?: string
}

export function RankedBars({ rows, unit, format, showPrev = true, onPick, onRecords, maxRows = 12, pickLabel = 'Drill into' }: Props) {
  const shown = rows.slice(0, maxRows)
  const isRate = unit === 'rate'
  const vals = shown.flatMap((r) => [r.value ?? 0, isRate && r.ci ? r.ci.high : 0, showPrev && r.prev?.value ? r.prev.value : 0])
  const { hi, ticks } = niceTicks(0, Math.max(isRate ? 0.05 : 1, ...vals), 4)
  const pct = (v: number | null | undefined) => `${(clamp((v ?? 0) / (hi || 1), 0, 1) * 100).toFixed(2)}%`
  return (
    <div className={`lab-bars ${isRate ? 'is-forest' : ''}`} role="table" aria-label="Breakdown">
      <div className="lab-bars__axis" role="row" aria-hidden="true">
        <span />
        <span className="lab-bars__scale">{ticks.map((t) => <i key={t} style={{ left: pct(t) } as CSSProperties}>{format(t)}</i>)}</span>
        <span />
      </div>
      {shown.map((r) => {
        const small = Boolean(r.insufficient)
        return (
          <div key={r.key} role="row" className={['lab-bars__row', small && 'is-small', r.test && 'is-test', r.key === '__unresolved' && 'is-unresolved'].filter(Boolean).join(' ')}>
            <button type="button" role="rowheader" className="lab-bars__label" onClick={() => onPick?.(r)} disabled={!onPick || r.test} title={onPick ? `${pickLabel} ${r.label}` : r.label}>
              <b>{r.label}</b>
              {r.test ? <em className="lab-tag">test · not ranked</em> : null}
            </button>
            <span className="lab-bars__track" role="cell">
              {ticks.map((t) => <i key={t} className="lab-bars__grid" style={{ left: pct(t) } as CSSProperties} />)}
              {isRate ? (
                <>
                  {r.ci && r.n > 0 ? <i className="lab-bars__ci" style={{ left: pct(r.ci.low), width: `calc(${pct(r.ci.high)} - ${pct(r.ci.low)})` } as CSSProperties} /> : null}
                  {r.value !== null ? <i className="lab-bars__dot" style={{ left: pct(r.value) } as CSSProperties} /> : null}
                </>
              ) : (
                <i className="lab-bars__bar" style={{ width: pct(r.value) } as CSSProperties} />
              )}
              {showPrev && r.prev && r.prev.value !== null ? <i className="lab-bars__prev" style={{ left: pct(r.prev.value) } as CSSProperties} title={`Comparison: ${format(r.prev.value)}`} /> : null}
            </span>
            <button type="button" role="cell" className="lab-bars__val" onClick={() => onRecords?.(r)} disabled={!onRecords} title={onRecords ? 'View the records' : undefined}>
              <b>{format(r.value)}</b>
              <span>{isRate ? `${r.num}/${r.den}` : unit === 'count' ? '' : `n=${r.n}`}{small ? ' · small n' : ''}</span>
            </button>
          </div>
        )
      })}
      {rows.length > shown.length ? <p className="lab-note">{rows.length - shown.length} more rows — open the table for all.</p> : null}
    </div>
  )
}

/** Table twin for ranked bars. */
export function BreakdownTable({ rows, unit, format, dimLabel }: { rows: BreakdownRow[]; unit: Props['unit']; format: Props['format']; dimLabel: string }) {
  return (
    <div className="lab-tablewrap">
      <table className="lab-table">
        <thead><tr><th>{dimLabel}</th><th>Value</th>{unit === 'rate' ? <><th>Num</th><th>Den</th><th>95% CI</th></> : <th>n</th>}<th>Comparison</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={r.test ? 'is-test' : undefined}>
              <th>{r.label}{r.test ? ' (test)' : ''}</th>
              <td>{format(r.value)}</td>
              {unit === 'rate' ? <><td>{r.num}</td><td>{r.den}</td><td>{r.ci ? `${format(r.ci.low)} – ${format(r.ci.high)}` : '—'}</td></> : <td>{r.n}</td>}
              <td>{r.prev ? format(r.prev.value) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
