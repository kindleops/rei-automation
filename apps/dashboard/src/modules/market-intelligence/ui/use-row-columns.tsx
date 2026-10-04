import { useMemo } from 'react'
import type { LCColumn } from '../../../shared/lc'
import { useMi } from '../mi-context'
import { fmtCount, fmtSample, fmtValue } from '../mi-format'
import type { MiRow } from '../mi-types'

const RANK_COLS = ['sales_count', 'median_sale_price', 'median_ppsf', 'investor_purchase_count', 'investor_purchase_share', 'cash_purchase_share', 'entity_owned_count', 'sales_growth', 'median_price_per_unit', 'company_buyer_count', 'sms_eligible_count', 'property_count']

export function useRowColumns(primary: string): LCColumn<MiRow>[] {
  const { metric } = useMi()
  return useMemo(() => {
    const cols = [...new Set([primary, ...RANK_COLS])]
    const metricCol = (id: string): LCColumn<MiRow> => {
      const m = metric(id)
      return {
        id, header: m?.label ?? id, align: 'right', width: id === primary ? 150 : 118, sortable: Boolean(m?.rankable), hint: m?.description,
        render: (r) => {
          const v = r.values[id]
          const ok = v?.status === 'ok'
          return <span className={`mi-cell${ok ? '' : ' is-withheld'}${id === primary ? ' is-primary' : ''}`} title={fmtSample(m, v) || undefined}>{fmtValue(m, v)}{ok && m && (m.aggregation === 'median' || m.aggregation === 'ratio') ? <small>n {fmtCount(v.n)}</small> : null}</span>
        },
      }
    }
    return [
      { id: 'rank', header: '#', width: 56, align: 'right', render: (r) => <span className="mi-cell is-rank">{r.rank ?? '–'}</span> },
      { id: 'label', header: 'Geography', minWidth: 220, render: (r) => <span className="mi-cell is-geo">{r.label}</span> },
      ...cols.map(metricCol),
    ]
  }, [primary, metric])
}

