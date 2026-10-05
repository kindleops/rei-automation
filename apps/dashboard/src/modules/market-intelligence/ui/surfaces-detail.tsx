import { useState } from 'react'
import { LCButton, LCEmpty, LCSegmented } from '../../../shared/lc'
import { miUrl, useMiQuery } from '../mi-api'
import { useMi } from '../mi-context'
import { fmtCount, fmtDate, fmtPct, fmtUsd, fmtValue } from '../mi-format'
import { openBeside } from '../mi-handoffs'
import { childLevelOf } from '../mi-route-state'
import type { MiCompareResult, MiDossier, MiGeoSummary, MiRankResult, MiRecentSale, MiTrendPoint } from '../mi-types'
import { DistBars, TrendChart, type TrendSeries } from './charts'
import { Leaderboard } from './surfaces-core'
import { MetricTile, QueryState } from './parts'
import { EvidenceShare, InferredInvestorSlot } from './evidence'

const RANGE_MONTHS: Record<string, number | null> = { '30d': 2, '90d': 3, '6m': 6, '1y': 12, '3y': 36, all: null }
const LEVEL_PLURAL: Record<string, string> = { state: 'states', market: 'markets', county: 'counties', city: 'cities', zip: 'ZIPs' }

type TrendKey = 'sales' | 'median_price' | 'median_ppsf' | 'investor_purchases' | 'investor_share' | 'cash_share' | 'company_acquisitions'
const TREND_METRICS: Array<{ key: TrendKey; label: string; fmt: (v: number) => string; note?: string }> = [
  { key: 'sales', label: 'Sales', fmt: fmtCount },
  { key: 'median_price', label: 'Median price', fmt: fmtUsd, note: 'qualified sales, months with ≥ 5' },
  { key: 'median_ppsf', label: 'Median $/sq ft', fmt: (v) => `$${Math.round(v)}`, note: 'months with ≥ 5' },
  { key: 'investor_purchases', label: 'Investor purchases', fmt: fmtCount },
  { key: 'investor_share', label: 'Investor share', fmt: (v) => fmtPct(v), note: 'of sales with a recorded buyer; months with ≥ 10' },
  { key: 'cash_share', label: 'Cash share', fmt: (v) => fmtPct(v), note: 'of sales with cash evidence; months with ≥ 10' },
  { key: 'company_acquisitions', label: 'Named company acquisitions', fmt: fmtCount },
]

const slice = (pts: MiTrendPoint[], period: string) => {
  const n = RANGE_MONTHS[period]
  return n === null || n === undefined ? pts : pts.slice(-n)
}
const toSeries = (id: string, label: string, pts: MiTrendPoint[], key: TrendKey): TrendSeries => ({ id, label, points: pts.map((p) => ({ month: p.month, y: (p[key] as number | null) ?? null, status: p.status, n: key === 'investor_share' ? p.buyer_known : key === 'cash_share' ? p.cash_known : key === 'median_price' ? p.price_n : undefined })) })

// ── Trends (brief §14) ─────────────────────────────────────────────────────
export function TrendsSurface({ d }: { d: MiDossier }) {
  const { state, set } = useMi()
  const [overlay, setOverlay] = useState(false)
  const cmpKey = overlay && state.cmp.length >= 2 ? miUrl('compare', { ids: state.cmp.join(','), period: state.period, asset: state.asset }) : null
  const cq = useMiQuery<MiCompareResult>(cmpKey)
  const range = state.period
  return (
    <div className="mi-trends">
      <div className="mi-toolbar" role="toolbar" aria-label="Trend range">
        <LCSegmented label="Range" size="sm" value={range} onChange={(v) => set({ period: v })} options={Object.keys(RANGE_MONTHS).map((p) => ({ value: p, label: p === 'all' ? 'All' : p.toUpperCase() }))} />
        {state.cmp.length >= 2 ? <LCSegmented label="Overlay" size="sm" value={overlay ? 'cmp' : 'one'} onChange={(v) => setOverlay(v === 'cmp')} options={[{ value: 'one', label: d.geography.label }, { value: 'cmp', label: `Compare set (${state.cmp.length})` }]} /> : null}
        <span className="mi-toolbar__meta">Monthly. Hatched = before sales coverage; dashed = may be incomplete (recording lag). No change figure without a complete baseline.</span>
      </div>
      <div className="mi-multiples">
        {TREND_METRICS.map((t) => {
          const series = overlay && cq.kind === 'ready' ? cq.data.series.map((s) => toSeries(s.id, s.label, slice(s.months, range), t.key)) : [toSeries(d.geography.id, d.geography.label, slice(d.trends, range), t.key)]
          return (
            <section key={t.key} className="mi-card">
              <h2>{t.label}{t.note ? <small>{t.note}</small> : null}</h2>
              <TrendChart series={series} format={t.fmt} label={`${t.label} by month`} height={160} />
            </section>
          )
        })}
      </div>
    </div>
  )
}

// ── Investors (brief §16, §17, §22) ────────────────────────────────────────
export function InvestorsSurface({ d }: { d: MiDossier }) {
  const { state, setInspect } = useMi()
  const v = d.values
  const child = childLevelOf(d.geography.level)
  const rq = useMiQuery<MiRankResult>(child ? miUrl('rank', { level: child, within: d.geography.id, metric: 'investor_purchase_share', period: state.period, asset: state.asset, limit: 15 }) : null)
  const cov = d.trends.map((p) => ({ month: p.month, y: p.sales ? p.buyer_known / p.sales : null, status: p.status }))
  return (
    <div className="mi-investors">
      <section className="mi-trio" aria-label="Distinct investor signals, never merged">
        <div className="mi-card">
          <h2>Investor purchases <small>deed evidence · transactions in the period</small></h2>
          <EvidenceShare kind="investor" values={v} size="lg" />
        </div>
        <div className="mi-card">
          <h2>Cash purchases <small>deed evidence · transactions in the period</small></h2>
          <EvidenceShare kind="cash" values={v} size="lg" />
        </div>
        <div className="mi-card">
          <h2>Entity-owned now <small>current ownership state</small></h2>
          <div className="mi-rail is-tight"><MetricTile id="entity_owned_count" value={v.entity_owned_count} size="lg" /></div>
          <p className="mi-quiet">Properties whose current owner is a company and whose latest sale names no buyer. Never added to investor purchases: an LLC owner does not make a purchase an investor purchase.</p>
        </div>
        <div className="mi-card">
          <h2>Inferred investors <small>owner-based · not deed evidence</small></h2>
          <InferredInvestorSlot data={d.inferred_investors} />
        </div>
      </section>
      <div className="mi-overview__grid">
        <section className="mi-card">
          <h2>Buyer depth</h2>
          <div className="mi-rail is-tight">
            {['company_buyer_count', 'repeat_buyer_count', 'top5_buyer_share', 'median_investor_price'].map((id) => <MetricTile key={id} id={id} value={v[id]} size="sm" />)}
          </div>
          <p className="mi-quiet">{fmtCount(d.investors.buyer_kinds.lender_or_agency)} title transfers to lenders, servicers, GSEs or agencies are excluded from buyer lists. Individuals are counted, never named.</p>
        </section>
        <section className="mi-card">
          <h2>Investor share by month <small>of sales with a recorded buyer; months with ≥ 10</small></h2>
          <TrendChart series={[{ id: 'inv', label: 'Investor share', points: d.trends.map((p) => ({ month: p.month, y: p.investor_share, status: p.status, n: p.buyer_known })) }]} format={(x) => fmtPct(x)} label="Investor share by month" height={150} />
          <h3 className="mi-sub">Buyer recorded on sales, by month <small>the evidence behind the share</small></h3>
          <TrendChart series={[{ id: 'cov', label: 'Buyer recorded', points: cov }]} format={(x) => fmtPct(x)} label="Buyer evidence coverage by month" height={110} />
        </section>
      </div>
      <section className="mi-card">
        <h2>Top company buyers <small>{d.window.from} → {d.window.to} · named companies only</small></h2>
        {d.investors.top_buyers.length ? (
          <table className="mi-table">
            <thead><tr><th>Buyer</th><th className="r">Purchases</th><th className="r">Priced volume</th><th className="r">Last purchase</th><th>Asset mix</th></tr></thead>
            <tbody>{d.investors.top_buyers.map((b) => (
              <tr key={b.name}><td>{b.name}</td><td className="r">{fmtCount(b.purchases)}</td><td className="r">{b.priced_n ? `${fmtUsd(b.priced_volume)} · ${b.priced_n}` : '—'}</td><td className="r">{fmtDate(b.last_purchase)}</td><td>{b.assets.slice(0, 3).map((a) => `${a.asset} ${a.n}`).join(' · ')}</td></tr>
            ))}</tbody>
          </table>
        ) : <p className="mi-quiet">No named company buyer recorded here in the period.</p>}
      </section>
      {child ? (
        <section className="mi-card">
          <h2>Highest investor share: {LEVEL_PLURAL[child]} <small>of sales with a recorded buyer, n ≥ 20</small></h2>
          <QueryState q={rq}>{(r) => <Leaderboard rows={r.rows} metric="investor_purchase_share" onPick={(id) => setInspect(id)} />}</QueryState>
        </section>
      ) : null}
    </div>
  )
}

// ── Multifamily (brief §18, §49) ───────────────────────────────────────────
export function MultifamilySurface({ geo }: { geo: MiGeoSummary }) {
  const { state, setInspect, status } = useMi()
  const asset = ['mf', 'mf_2_4', 'mf_5_plus'].includes(state.asset) ? state.asset : 'mf'
  const [mf, setMf] = useState(asset)
  const dq = useMiQuery<MiDossier>(miUrl('dossier', { id: geo.id, period: state.period, asset: mf }))
  const child = childLevelOf(geo.level)
  const rq = useMiQuery<MiRankResult>(child ? miUrl('rank', { level: child, within: geo.id, metric: 'sales_count', period: state.period, asset: mf, limit: 12 }) : null)
  const sq = useMiQuery<{ rows: MiRecentSale[]; note: string }>(miUrl('recent_sales', { id: geo.id, asset: mf, limit: 25 }))
  const commercial = status?.asset_filters.find((a) => a.id === 'commercial')
  return (
    <div className="mi-mf">
      <div className="mi-toolbar" role="toolbar" aria-label="Multifamily class">
        <LCSegmented label="Class" size="sm" value={mf} onChange={setMf} options={[{ value: 'mf', label: 'All MF' }, { value: 'mf_2_4', label: '2–4 units' }, { value: 'mf_5_plus', label: '5+ units' }]} />
        <span className="mi-toolbar__meta">Unit count decides 2–4 vs 5+. "Multi-Family" with no usable unit count is counted under All MF only.{commercial && !commercial.available ? ' No sale in the corpus is typed commercial, so a commercial view is not offered.' : ''} No NOI, cap rate, rent roll or DSCR: none is recorded.</span>
      </div>
      <QueryState q={dq}>{(d) => (
        <>
          <section className="mi-rail">
            {['sales_count', 'median_sale_price', 'median_price_per_unit', 'median_ppsf', 'repeat_buyer_count'].map((id) => <MetricTile key={id} id={id} value={d.values[id]} />)}
          </section>
          <section className="mi-rail2__cells is-ev mi-ev-row" aria-label="Buyer evidence">
            <EvidenceShare kind="investor" values={d.values} />
            <EvidenceShare kind="cash" values={d.values} />
          </section>
          <div className="mi-overview__grid">
            <section className="mi-card"><h2>Units per building <small>recorded unit count</small></h2><DistBars label="Units per building" rows={d.multifamily.unit_distribution.map((r) => ({ ...r, muted: r.label === 'not recorded' }))} /></section>
            <section className="mi-card"><h2>Building size <small>sq ft</small></h2><DistBars label="Building size" rows={d.multifamily.size_distribution.map((r) => ({ ...r, muted: r.label === 'not recorded' }))} /></section>
            <section className="mi-card"><h2>MF sales by month</h2><TrendChart series={[{ id: 'mfs', label: 'Sales', points: d.trends.map((p) => ({ month: p.month, y: p.sales, status: p.status })) }]} format={fmtCount} label="Multifamily sales by month" height={150} /></section>
            {child ? <section className="mi-card"><h2>Top {LEVEL_PLURAL[child]} by MF sales</h2><QueryState q={rq}>{(r) => <Leaderboard rows={r.rows} metric="sales_count" onPick={(id) => setInspect(id)} />}</QueryState></section> : null}
          </div>
        </>
      )}</QueryState>
      <section className="mi-card">
        <h2>Recent market sales <small>recorded sales, not valuation comps</small></h2>
        <QueryState q={sq}>{(r) => <RecentSales rows={r.rows} />}</QueryState>
      </section>
    </div>
  )
}

export function RecentSales({ rows }: { rows: MiRecentSale[] }) {
  if (!rows.length) return <p className="mi-quiet">No sale of this class here in the recent record.</p>
  return (
    <table className="mi-table">
      <thead><tr><th>Sold</th><th>Address</th><th>Class</th><th className="r">Units</th><th className="r">Price</th><th className="r">$/unit</th><th>Buyer</th><th aria-label="Open" /></tr></thead>
      <tbody>{rows.map((s) => (
        <tr key={s.comp_id}>
          <td>{fmtDate(s.sold_on)}</td>
          <td>{s.address ?? '—'}{s.city ? <small> · {s.city} {s.zip}</small> : null}</td>
          <td>{s.asset_label}</td>
          <td className="r">{s.units && s.units > 0 ? s.units : '—'}</td>
          <td className="r">{s.price ? fmtUsd(s.price) : <span className="mi-quiet">unpriced</span>}</td>
          <td className="r">{s.price && s.units && s.units > 1 ? fmtUsd(s.price / s.units) : '—'}</td>
          <td>{s.buyer ?? (s.investor ? <span className="mi-quiet">investor (unnamed)</span> : '—')}</td>
          <td>{s.property_id ? <LCButton size="sm" variant="ghost" trailingIcon="arrow-up-right" title="Open in Deal Intelligence, beside" onClick={() => openBeside(`/deal-intelligence?property_id=${encodeURIComponent(s.property_id as string)}`)}>Open</LCButton> : null}</td>
        </tr>
      ))}</tbody>
    </table>
  )
}

// ── Demographics (brief §19) ───────────────────────────────────────────────
const ACS = ['population', 'households', 'housing_units', 'median_household_income', 'median_gross_rent', 'vacancy_rate', 'renter_share', 'owner_share', 'acs_median_year_built', 'rent_burden', 'units_2_4_share', 'units_5plus_share']
export function DemographicsSurface({ d }: { d: MiDossier }) {
  const { registry, metric } = useMi()
  const v = d.values
  const anyOk = ACS.some((id) => v[id]?.status === 'ok')
  return (
    <div className="mi-demo">
      {anyOk ? (
        <section className="mi-rail">{ACS.map((id) => <MetricTile key={id} id={id} value={v[id]} />)}</section>
      ) : <LCEmpty title="No census cell for this geography" body="ACS 5-year cells exist for 1,325 ZIPs, 403 cities, 76 counties and 33 states. Open a ZIP, city, county or state." />}
      <section className="mi-card">
        <h2>Source &amp; coverage</h2>
        <dl className="mi-dl">
          <dt>Source</dt><dd>US Census ACS 5-year ({String(d.data_quality.census_vintage ?? '—')}), production cells</dd>
          <dt>This geography</dt><dd>{d.geography.level === 'market' ? `Markets sum their member ZIP cells (${fmtValue(metric('population'), v.population)} people from ${v.population?.n ?? 0} cells${typeof v.population?.coverage === 'number' ? `, ${fmtPct(v.population.coverage)} of member ZIPs` : ''}). Medians cannot be summed and are not shown.` : 'The ACS cell for this census geography.'}</dd>
          <dt>Not in the production data</dt><dd>{Object.entries(registry?.unsupported ?? {}).filter(([k]) => ['median_age', 'education', 'employment', 'crime'].includes(k)).map(([k, why]) => `${k.replace('_', ' ')}: ${why}`).join(' · ')}</dd>
        </dl>
      </section>
    </div>
  )
}
