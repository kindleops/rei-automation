import { useMemo } from 'react'
import type { LCColumn } from '../../../shared/lc'
import { useMi } from '../mi-context'
import { fmtCount, fmtPct, fmtSample, fmtValue } from '../mi-format'
import type { MiRow } from '../mi-types'

/**
 * Ranking / screener columns. Evidence shares sit BESIDE their evidence coverage
 * ("Investor share" then "Buyer recorded"), and the investor count comes after both, so a
 * count is never read against total sales. The ranked metric gets an inline bar.
 */
const RANK_COLS = ['sales_count', 'median_sale_price', 'median_ppsf', 'investor_purchase_share', 'buyer_evidence_coverage', 'investor_purchase_count',
  'cash_purchase_share', 'cash_evidence_coverage', 'entity_owned_count', 'sales_growth', 'median_price_per_unit', 'company_buyer_count', 'sms_eligible_count', 'property_count']
const SHARE_BASE: Record<string, string> = { investor_purchase_share: 'sales with a recorded buyer', cash_purchase_share: 'sales with cash evidence' }
const WIDTH: Record<string, number> = { sales_count: 96, buyer_evidence_coverage: 112, cash_evidence_coverage: 108, investor_purchase_share: 128, cash_purchase_share: 112 }

export function useRowColumns(primary: string, rows: ReadonlyArray<MiRow> = []): LCColumn<MiRow>[] {
  const { metric } = useMi()
  const max = useMemo(() => Math.max(0, ...rows.map((r) => (r.values[primary]?.status === 'ok' ? Math.abs(r.values[primary].value ?? 0) : 0))), [rows, primary])
  return useMemo(() => {
    const cols = [...new Set([primary, ...RANK_COLS])]
    const metricCol = (id: string): LCColumn<MiRow> => {
      const m = metric(id)
      const isPrimary = id === primary
      return {
        id, header: m?.label ?? id, align: 'right', width: isPrimary ? 168 : WIDTH[id] ?? 116, sortable: Boolean(m?.rankable), hint: m?.description,
        render: (r) => {
          const v = r.values[id]
          const ok = v?.status === 'ok'
          const base = SHARE_BASE[id]
          const title = ok && base ? `${fmtPct(v.value ?? 0)} of ${fmtCount(v.n)} ${base}` : fmtSample(m, v) || undefined
          return (
            <span className={`mi-cell${ok ? '' : ' is-withheld'}${isPrimary ? ' is-primary' : ''}${id.endsWith('_coverage') ? ' is-coverage' : ''}`} title={title}>
              {isPrimary && ok && max > 0 ? <i className="mi-cell__bar" style={{ width: `${(Math.abs(v.value ?? 0) / max) * 100}%` }} aria-hidden="true" /> : null}
              <span className="mi-cell__v">{fmtValue(m, v)}</span>
              {ok && m && (m.aggregation === 'median' || m.aggregation === 'ratio') && !id.endsWith('_coverage') ? <small>n {fmtCount(v.n)}</small> : null}
            </span>
          )
        },
      }
    }
    return [
      { id: 'rank', header: '#', width: 52, align: 'right', render: (r) => <span className="mi-cell is-rank">{r.rank ?? '–'}</span> },
      { id: 'label', header: 'Geography', minWidth: 230, render: (r) => <span className="mi-cell is-geo"><b>{r.label.split(' · ')[0]}</b>{r.label.includes(' · ') ? <small>{r.label.split(' · ').slice(1).join(' · ')}</small> : null}</span> },
      ...cols.map(metricCol),
    ]
  }, [primary, metric, max])
}
