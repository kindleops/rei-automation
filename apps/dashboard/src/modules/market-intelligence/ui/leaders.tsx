import { LCSelect, LCSparkline, LCTooltip } from '../../../shared/lc'
import { miUrl, useMiQuery } from '../mi-api'
import { useMi } from '../mi-context'
import { fmtCount, fmtPct, fmtUsd } from '../mi-format'
import type { MiGeoSummary, MiLeaderRow, MiLeadersResult, MiValue } from '../mi-types'
import { QueryState } from './parts'

/**
 * ZIP LEADERBOARD ("where investors are buying"). Ordered by ONE registry metric the
 * operator picks; no composite score. Each row reads: recorded investor purchases and
 * their share, buyer depth (distinct company buyers), velocity (sales / month), median
 * price, and a 12-month sales line from the summary. Thin-sample cells are quiet dashes
 * with the reason on hover, never shouted. Click = the ZIP's panel (Inspector).
 */
const LEADER_SORTS = [
  { value: 'investor_purchase_count', label: 'Recorded investor purchases' },
  { value: 'investor_purchase_share', label: 'Investor share' },
  { value: 'company_buyer_count', label: 'Buyer depth (company buyers)' },
  { value: 'monthly_sales_rate', label: 'Velocity (sales / month)' },
  { value: 'sales_count', label: 'Sales volume' },
  { value: 'cash_purchase_share', label: 'Cash share' },
] as const

const ok = (v: MiValue | undefined): v is MiValue & { value: number } => v?.status === 'ok' && v.value !== null && v.value !== undefined

function Cell({ v, fmt }: { v: MiValue | undefined; fmt: (n: number) => string }) {
  if (ok(v)) return <span className="mi-board__num">{fmt(v.value)}</span>
  return (
    <LCTooltip content={v?.reason ?? 'No value'} side="top">
      <span className="mi-board__num is-thin" tabIndex={0} aria-label={v?.reason ?? 'No value'}>—</span>
    </LCTooltip>
  )
}

export function Leaders({ geo, height }: { geo: MiGeoSummary; height?: number }) {
  const { state, set, setInspect, inspect } = useMi()
  const sort = LEADER_SORTS.some((s) => s.value === state.lb) ? state.lb : 'investor_purchase_count'
  const q = useMiQuery<MiLeadersResult>(miUrl('leaders', { within: geo.id, sort, period: state.period, asset: state.asset, limit: 15 }))
  return (
    <section className="mi-board" aria-label="ZIP leaderboard" style={height ? { height } : undefined}>
      <header className="mi-board__head">
        <div>
          <h2>Where investors are buying</h2>
          <QueryState q={q} skeleton={<p className="mi-board__sub">ZIPs ranked…</p>}>{(r) => (
            <p className="mi-board__sub">Top {r.rows.length} of {fmtCount(r.total)} ZIPs in {r.parent.label}{r.parent.id !== geo.id ? ` (around ${geo.label})` : ''}</p>
          )}</QueryState>
        </div>
        <LCSelect label="Rank ZIPs by" prefix="By" variant="chip" size="sm" value={sort} onChange={(v) => set({ lb: v })} options={LEADER_SORTS.map((s) => ({ value: s.value, label: s.label }))} />
      </header>
      <div className="mi-board__cols" aria-hidden="true">
        <span>#</span><span>ZIP</span><span>Investor buys</span><span>Share</span><span>Buyers</span><span>Median</span><span>12 mo</span>
      </div>
      <div className="mi-board__list">
        <QueryState q={q} skeleton={<div className="mi-board__skel" aria-busy="true">{Array.from({ length: 8 }, (_, i) => <i key={i} />)}</div>}>{(r) => (
          r.rows.length ? (
            <ol>
              {r.rows.map((row: MiLeaderRow) => {
                const v = row.values
                const [zip, place] = row.label.split(' · ')
                const here = row.id === geo.id || row.id === inspect
                return (
                  <li key={row.id}>
                    <button type="button" className={`mi-board__row${here ? ' is-on' : ''}`} onClick={() => setInspect(row.id)} aria-label={`${row.label}: open its panel`}>
                      <span className="mi-board__rank">{row.rank}</span>
                      <span className="mi-board__name"><b>{zip}</b><small>{(place ?? '').replace(/, [A-Z]{2}$/, '')}{ok(v.monthly_sales_rate) ? ` · ${v.monthly_sales_rate.value >= 10 ? Math.round(v.monthly_sales_rate.value) : v.monthly_sales_rate.value.toFixed(1)}/mo` : ''}</small></span>
                      <Cell v={v.investor_purchase_count} fmt={fmtCount} />
                      <Cell v={v.investor_purchase_share} fmt={(n) => fmtPct(n)} />
                      <Cell v={v.company_buyer_count} fmt={fmtCount} />
                      <Cell v={v.median_sale_price} fmt={fmtUsd} />
                      <span className="mi-board__spark">
                        <LCSparkline values={row.spark.map((n, i) => (r.months[i]?.status === 'covered' ? n : null))} width={64} height={20} tone="exec" label={`${row.label} monthly sales, last 12 months`} />
                      </span>
                    </button>
                  </li>
                )
              })}
            </ol>
          ) : <p className="mi-quiet">No ZIP has a value for this ranking in the period.</p>
        )}</QueryState>
      </div>
      <p className="mi-board__foot">Share = recorded investor purchases ÷ sales that record a buyer (20 or more). The line shows complete months only.</p>
    </section>
  )
}
