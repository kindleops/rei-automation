import { useState } from 'react'
import { LCButton, LCFacts, LCInspector, LCInspectorSection, LCSkeleton } from '../../../shared/lc'
import { miUrl, useMiQuery } from '../mi-api'
import { useMi } from '../mi-context'
import { fmtCount, fmtDate, fmtPct, fmtUsd, fmtValue } from '../mi-format'
import type { MiDossier, MiRecentSale } from '../mi-types'
import { DistBars, TrendChart } from './charts'
import { GeoActions, MetricTile, QueryState } from './parts'
import { RecentSales } from './surfaces-detail'
import { UniverseLoad } from './surfaces-core'

/**
 * UNIVERSAL GEOGRAPHY INSPECTOR (brief §13): one panel for every level, not
 * dozens of detail pages. Sections: Overview, Sales, Investors, Ownership,
 * Multifamily, Demographics, Seller universe, Buyer demand, Trends, Data quality.
 */
const SECTIONS = ['Overview', 'Sales', 'Investors', 'Ownership', 'Multifamily', 'Demographics', 'Seller universe', 'Buyer demand', 'Trends', 'Data quality'] as const

export function GeoInspector({ id }: { id: string }) {
  const { state, setInspect, openGeo } = useMi()
  const q = useMiQuery<MiDossier>(miUrl('dossier', { id, period: state.period, asset: state.asset }))
  const d = q.kind === 'ready' ? q.data : null
  return (
    <LCInspector
      open
      mode="dock"
      id="mi-geo"
      onClose={() => setInspect(null)}
      eyebrow={d ? d.geography.level_label : 'Geography'}
      title={d ? d.geography.label : id}
      subtitle={d ? `${d.window.from} → ${d.window.to} · ${d.window.asset_label}` : undefined}
      contentKey={id}
      width={420}
      minWidth={340}
      maxWidth={620}
      resizable
      label="Geography inspector"
      footer={d ? <div className="mi-insp-foot"><LCButton size="sm" variant="secondary" trailingIcon="arrow-up-right" onClick={() => { openGeo(id); setInspect(null) }}>Open as subject</LCButton><GeoActions g={d.geography} heatMetric={state.hm} /></div> : null}
    >
      <QueryState q={q} skeleton={<LCSkeleton shape="rows" count={8} />}>{(dd) => <InspectorBody d={dd} />}</QueryState>
    </LCInspector>
  )
}

function InspectorBody({ d }: { d: MiDossier }) {
  const v = d.values
  const { metric } = useMi()
  const [showSales, setShowSales] = useState(false)
  const sq = useMiQuery<{ rows: MiRecentSale[] }>(showSales ? miUrl('recent_sales', { id: d.geography.id, asset: d.window.asset, limit: 15 }) : null)
  const jump = (s: string) => document.getElementById(`mi-insp-${s.replace(/\s+/g, '-').toLowerCase()}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  const facts = (ids: string[]) => ids.map((id) => ({ label: metric(id)?.label ?? id, value: <span className={v[id]?.status === 'ok' ? undefined : 'is-withheld'}>{fmtValue(metric(id), v[id])}</span>, hint: v[id]?.status === 'ok' ? (v[id]?.basis ?? `n ${fmtCount(v[id]?.n ?? 0)}`) : v[id]?.reason }))
  const sec = (title: (typeof SECTIONS)[number], body: React.ReactNode, aside?: React.ReactNode) => (
    <div id={`mi-insp-${title.replace(/\s+/g, '-').toLowerCase()}`} key={title}><LCInspectorSection title={title} aside={aside}>{body}</LCInspectorSection></div>
  )
  return (
    <div className="mi-insp">
      <nav className="mi-insp__nav" aria-label="Sections">{SECTIONS.map((s) => <button key={s} type="button" onClick={() => jump(s)}>{s}</button>)}</nav>
      {sec('Overview', <>
        <div className="mi-rail is-tight">{['sales_count', 'median_sale_price', 'investor_purchase_count', 'investor_purchase_share'].map((id) => <MetricTile key={id} id={id} value={v[id]} size="sm" />)}</div>
        <ol className="mi-brief is-compact">{d.brief.map((s, i) => <li key={i}>{s.text}</li>)}</ol>
      </>)}
      {sec('Sales', <>
        <LCFacts rows={facts(['sales_count', 'priced_sale_count', 'qualified_sale_count', 'median_sale_price', 'median_ppsf', 'monthly_sales_rate', 'sales_growth'])} />
        {d.sales.price_deciles ? <p className="mi-quiet">Qualified prices: p10 {fmtUsd(d.sales.price_deciles[0].value)} · p25 {fmtUsd(d.sales.price_deciles[1].value)} · median {fmtUsd(d.sales.price_deciles[2].value)} · p75 {fmtUsd(d.sales.price_deciles[3].value)} · p90 {fmtUsd(d.sales.price_deciles[4].value)}</p> : null}
        <DistBars label="Asset mix" rows={d.sales.asset_mix.map((a) => ({ label: a.label, n: a.n }))} />
        <p className="mi-quiet">MLS {fmtCount(d.sales.source_mix.mls)} · public record {fmtCount(d.sales.source_mix.public_record)} · latest {fmtDate(d.sales.latest_sale)}</p>
        {showSales ? <QueryState q={sq}>{(r) => <RecentSales rows={r.rows} />}</QueryState> : <LCButton size="sm" variant="quiet" icon="list" onClick={() => setShowSales(true)}>Recent market sales</LCButton>}
      </>)}
      {sec('Investors', <>
        <LCFacts rows={facts(['investor_purchase_count', 'investor_purchase_share', 'buyer_evidence_coverage', 'cash_purchase_count', 'cash_purchase_share', 'cash_evidence_coverage'])} />
        {d.investors.top_buyers.length ? <ul className="mi-buyers">{d.investors.top_buyers.slice(0, 6).map((b) => <li key={b.name}><span>{b.name}</span><b>{fmtCount(b.purchases)}</b></li>)}</ul> : <p className="mi-quiet">No named company buyer in the period.</p>}
      </>)}
      {sec('Ownership', <LCFacts rows={[...facts(['entity_owned_count']), { label: 'Corporate owner (seller universe)', value: d.universe.corporate_owner_count === null ? <span className="is-withheld">Not loaded</span> : fmtCount(d.universe.corporate_owner_count), hint: 'campaign graph is_corporate_owner' }]} />)}
      {sec('Multifamily', <>
        <LCFacts rows={facts(['mf_sale_count', 'median_price_per_unit'])} />
        <DistBars label="Units per building" rows={d.multifamily.unit_distribution.map((r) => ({ ...r, muted: r.label === 'not recorded' }))} />
      </>)}
      {sec('Demographics', <LCFacts rows={facts(['population', 'households', 'median_household_income', 'median_gross_rent', 'renter_share', 'vacancy_rate'])} />, <span className="mi-quiet">ACS {String(d.data_quality.census_vintage ?? '')}</span>)}
      {sec('Seller universe', <>
        <LCFacts rows={facts(['property_count', 'seller_record_count', 'phone_on_file_count', 'sms_eligible_count', 'queue_eligible_count', 'email_eligible_count', 'suppressed_count', 'recent_contact_hold_count', 'in_queue_count'])} />
        {v.seller_record_count?.status === 'not_loaded' && d.geography.state ? <UniverseLoad states={d.geography.state} /> : null}
        {d.universe.stock ? <p className="mi-quiet">Stock (medians, coverage): {d.universe.stock.filter((s) => s.median !== null).map((s) => `${s.label} ${s.field === 'loan' || s.field === 'value' ? fmtUsd(s.median as number) : s.field === 'equity' ? `${Math.round(s.median as number)}%` : Math.round(s.median as number).toLocaleString('en-US')} (${fmtPct(s.coverage)})`).join(' · ')}</p> : null}
        <p className="mi-quiet">{d.universe.authority}</p>
      </>)}
      {sec('Buyer demand', <LCFacts rows={facts(['company_buyer_count', 'repeat_buyer_count', 'top5_buyer_share', 'median_investor_price'])} />)}
      {sec('Trends', <TrendChart series={[{ id: 's', label: 'Sales', points: d.trends.map((p) => ({ month: p.month, y: p.sales, status: p.status })) }]} format={fmtCount} label="Sales by month" height={120} />)}
      {sec('Data quality', <LCFacts rows={[
        { label: 'Sales data through', value: fmtDate(String(d.data_quality.sales_as_of ?? '')) },
        { label: 'Coverage window', value: `${d.data_quality.coverage_start ?? '—'} → ${d.data_quality.complete_through ?? '—'} (complete)` },
        { label: 'Property type recorded', value: pct(d.data_quality.property_type_coverage) },
        { label: 'Unit count (multifamily)', value: pct(d.data_quality.unit_count_coverage_mf) },
        { label: 'Building size (priced)', value: pct(d.data_quality.sqft_coverage_priced) },
        { label: 'Buyer recorded', value: pct(d.data_quality.buyer_coverage) },
        { label: 'Cash evidence', value: pct(d.data_quality.cash_coverage) },
        { label: 'Phone type (graph)', value: pct(d.data_quality.phone_type_coverage) },
        { label: 'Census vintage', value: String(d.data_quality.census_vintage ?? '—') },
        { label: 'Seller graph measured', value: d.data_quality.graph_measured_at ? fmtDate(String(d.data_quality.graph_measured_at)) : '—' },
        { label: 'Geometry', value: String(d.data_quality.geometry ?? '—') },
        ...(d.data_quality.county_membership ? [{ label: 'County membership', value: String(d.data_quality.county_membership) }] : []),
      ]} />)}
    </div>
  )
}

const pct = (x: unknown) => (typeof x === 'number' ? fmtPct(x) : '—')
