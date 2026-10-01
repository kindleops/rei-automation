import type { FocusStore } from '../focus-store'
import { useFocus } from '../focus-store'
import { linear, useElementWidth } from './chart-math'

export interface DeviationRow { key: string; label: string; value: number | null; text: string | null; emphasis?: boolean; note?: string | null }

const LABEL_W = 132
const VALUE_W = 72

/**
 * Signed deviations around zero, one row per comp, in the list's order:
 * size against the subject (§39) or the valuation move when a comp is left
 * out (§42–43). One hue; the row that matters is emphasised, the rest stay
 * quiet. An optional band shows what the engine allows. Rows are the table
 * view — every number is printed, the bars only make magnitude visible.
 */
export function DeviationRows({ rows, store, bound, band, ariaLabel }: { rows: DeviationRow[]; store: FocusStore; bound?: number; band?: { min: number; max: number; label: string } | null; ariaLabel: string }) {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const focus = useFocus(store)
  const vals = rows.map((r) => Math.abs(r.value ?? 0))
  const lim = bound ?? Math.max(1e-9, ...vals, band ? Math.max(Math.abs(band.min), Math.abs(band.max)) : 0)
  const plotW = Math.max(60, width - LABEL_W - VALUE_W)
  const x = linear(-lim, lim, 0, plotW)
  return (
    <div ref={ref} className="ciw-devrows" role="table" aria-label={ariaLabel}>
      {width > 0 ? rows.map((r) => {
        const hot = focus.hover === r.key || focus.selected === r.key
        const v = r.value
        const x0 = x(0)
        const xv = v === null ? x0 : x(Math.max(-lim, Math.min(lim, v)))
        return (
          <div key={r.key} role="row" className={`ciw-devrow${hot ? ' is-hot' : ''}${r.emphasis ? ' is-emphasis' : ''}`}
            onPointerEnter={() => store.hover(r.key, 'chart')} onPointerLeave={() => store.hover(null, null)} onClick={() => store.select(r.key)}>
            <span role="cell" className="ciw-devrow__label" title={r.label}>{r.label}</span>
            <span role="cell" className="ciw-devrow__plot" style={{ width: plotW }} aria-hidden="true">
              {band ? <i className="ciw-devrow__band" style={{ left: x(Math.max(-lim, band.min)), width: Math.max(0, x(Math.min(lim, band.max)) - x(Math.max(-lim, band.min))) }} /> : null}
              <i className="ciw-devrow__zero" style={{ left: Math.round(x0) }} />
              {v !== null ? <i className="ciw-devrow__bar" style={{ left: Math.min(x0, xv), width: Math.max(1.5, Math.abs(xv - x0)) }} /> : null}
            </span>
            <span role="cell" className="ciw-devrow__value">{r.text ?? '—'}{r.note ? <em>{r.note}</em> : null}</span>
          </div>
        )
      }) : <div style={{ height: rows.length * 26 }} />}
    </div>
  )
}
