import { useState } from 'react'
import { LCButton, LCDataGrid, LCEmpty, LCSegmented, LCSelect, type LCRowActivationEvent } from '../../../shared/lc'
import { dataOf, miFetch, miUrl, refreshAllMiQueries, useMiQuery } from '../mi-api'
import { useMi } from '../mi-context'
import { fmtCount, fmtDate, fmtDateTime, fmtValue } from '../mi-format'
import { showGeoOnMap } from '../mi-handoffs'
import { childLevelOf } from '../mi-route-state'
import type { MiDossier, MiGeoSummary, MiLevel, MiRankResult, MiRow, MiStatusPayload, MiTrendPoint } from '../mi-types'
import { writeMiMapContext } from '../map/mi-map-lenses'
import { TrendChart } from './charts'
import { GeoActions, MetricTile, QueryState } from './parts'
import { geoMenu, metricAvailable, sparkOf } from './ui-model'
import { useRowColumns } from './use-row-columns'
import { EvidenceShare, InferredInvestorSlot } from './evidence'
import { GeoHeatFigure } from './geo-figure'

const LEVEL_PLURAL: Record<string, string> = { state: 'states', market: 'markets', county: 'counties', city: 'cities', zip: 'ZIPs' }
const ORDER: MiLevel[] = ['nation', 'state', 'market', 'county', 'city', 'zip']

function rankLabel(d: MiDossier, metric: string): string | null {
  const r = d.rank_context.find((x) => x.metric === metric)
  return r ? `#${r.rank} of ${fmtCount(r.of)} ${LEVEL_PLURAL[r.level] ?? ''} · ${r.parent_label}` : null
}

// ── Overview (brief §7, §32): map-first, a real metric rail, evidence that can't be misread ──
const SPARK: Record<string, keyof MiTrendPoint> = { sales_count: 'sales', median_sale_price: 'median_price', median_ppsf: 'median_ppsf' }

export function Hero({ d, compact }: { d: MiDossier; compact?: boolean }) {
  const { openGeo, state, status } = useMi()
  const g = d.geography
  const v = d.values
  const spec = [
    v.sales_count?.status === 'ok' ? `${fmtCount(v.sales_count.value ?? 0)} sales` : null,
    `${fmtDate(d.window.from)} – ${fmtDate(d.window.to)}`,
    d.window.asset === 'all' ? null : d.window.asset_label,
    d.children ? `${fmtCount(d.children.count)} ${LEVEL_PLURAL[d.children.level] ?? ''}` : null,
    status?.summary?.built_at ? `summary built ${fmtDateTime(status.summary.built_at)}` : null,
  ].filter(Boolean)
  return (
    <header className={`mi-hero${compact ? ' is-compact' : ''}`}>
      <nav className="mi-crumbs" aria-label="Geography lineage">
        <span className="mi-crumbs__level">{g.level_label}</span>
        {(g.lineage ?? []).map((l) => <button key={l.id} type="button" onClick={() => openGeo(l.id)}>{l.label}</button>)}
      </nav>
      <div className="mi-hero__row">
        <div className="mi-hero__id">
          <h1>{g.label}</h1>
          <p className="mi-hero__spec">{spec.map((x, i) => <span key={i}>{x}</span>)}</p>
        </div>
        <GeoActions g={g} heatMetric={state.hm} />
      </div>
    </header>
  )
}

/** The metric rail: one plate, four labelled groups, evidence shares in their own group. */
export function MetricRail({ d }: { d: MiDossier }) {
  const cell = (id: string) => <MetricTile key={id} id={id} value={d.values[id]} spark={SPARK[id] ? sparkOf(d.trends, SPARK[id]) : undefined} rank={rankLabel(d, id)} size="sm" />
  return (
    <section className="mi-rail2" aria-label="Headline metrics">
      <div className="mi-rail2__group"><h3>Activity</h3><div className="mi-rail2__cells">{['sales_count', 'monthly_sales_rate', 'sales_growth'].map(cell)}</div></div>
      <div className="mi-rail2__group"><h3>Price</h3><div className="mi-rail2__cells">{['median_sale_price', 'median_ppsf', 'median_price_per_unit'].map(cell)}</div></div>
      <div className="mi-rail2__group is-evidence">
        <h3>Buyer evidence <small>shares of the sales that record it</small></h3>
        <div className="mi-rail2__cells is-ev">
          <EvidenceShare kind="investor" values={d.values} />
          <EvidenceShare kind="cash" values={d.values} />
          {d.inferred_investors !== undefined ? <InferredInvestorSlot data={d.inferred_investors} compact /> : null}
        </div>
      </div>
      <div className="mi-rail2__group"><h3>Ownership &amp; universe</h3><div className="mi-rail2__cells">{['entity_owned_count', 'property_count', 'sms_eligible_count'].map(cell)}</div></div>
    </section>
  )
}

export function OverviewSurface({ d, wall }: { d: MiDossier; wall?: boolean }) {
  const { state, setInspect } = useMi()
  const child = childLevelOf(d.geography.level)
  const bySales = useMiQuery<MiRankResult>(child ? miUrl('rank', { level: child, within: d.geography.id, metric: 'sales_count', period: state.period, asset: state.asset, limit: 8 }) : null)
  const byShare = useMiQuery<MiRankResult>(child ? miUrl('rank', { level: child, within: d.geography.id, metric: 'investor_purchase_share', period: state.period, asset: state.asset, limit: 8 }) : null)
  const sales = d.trends.map((p) => ({ month: p.month, y: p.sales, status: p.status }))
  return (
    <div className={`mi-overview${wall ? ' is-wall' : ''}`}>
      <MetricRail d={d} />
      <div className="mi-stage">
        <GeoHeatFigure geo={d.geography} height={wall ? 520 : 380} />
        <aside className="mi-stage__side">
          <section className="mi-card mi-brief" aria-label="Market brief">
            <h2>Brief <small>each line is a registry metric</small></h2>
            <ol>{d.brief.map((x, i) => <li key={i}>{x.text}</li>)}</ol>
          </section>
          {child ? (
            <section className="mi-card mi-leaders" aria-label={`Leading ${LEVEL_PLURAL[child]}`}>
              <h2>Leading {LEVEL_PLURAL[child]}</h2>
              <h3 className="mi-sub">By sales</h3>
              <QueryState q={bySales}>{(r) => <Leaderboard rows={r.rows} metric="sales_count" onPick={(id) => setInspect(id)} />}</QueryState>
              <h3 className="mi-sub">By investor share <small>of sales with a recorded buyer, n ≥ 20</small></h3>
              <QueryState q={byShare}>{(r) => <Leaderboard rows={r.rows} metric="investor_purchase_share" onPick={(id) => setInspect(id)} />}</QueryState>
            </section>
          ) : null}
        </aside>
      </div>
      <section className="mi-card" aria-label="Sales by month">
        <h2>Sales by month <small>{d.window.asset_label} · hatched months are before sales coverage, dashed may be incomplete</small></h2>
        <TrendChart series={[{ id: 'sales', label: 'Sales', points: sales }]} format={(v) => fmtCount(v)} label="Sales by month" height={180} />
      </section>
    </div>
  )
}

export function Leaderboard({ rows, metric, onPick }: { rows: MiRow[]; metric: string; onPick: (id: string) => void }) {
  const { metric: def } = useMi()
  const m = def(metric)
  const max = Math.max(1, ...rows.map((r) => r.values[metric]?.value ?? 0))
  if (!rows.length) return <p className="mi-quiet">No ranked areas in this period.</p>
  return (
    <ol className="mi-leader">
      {rows.map((r) => (
        <li key={r.id}>
          <button type="button" onClick={() => onPick(r.id)}>
            <span className="mi-leader__rank">{r.rank}</span>
            <span className="mi-leader__name">{r.label}</span>
            <span className="mi-leader__bar"><i style={{ width: `${((r.values[metric]?.value ?? 0) / max) * 100}%` }} /></span>
            <span className="mi-leader__v">{fmtValue(m, r.values[metric])}</span>
          </button>
        </li>
      ))}
    </ol>
  )
}

// ── Rankings (brief §9, §10) ───────────────────────────────────────────────

export function RowsGrid({ id, label, rows, primary, sort, onSort, total, empty }: { id: string; label: string; rows: MiRow[]; primary: string; sort?: { id: string; dir: 'asc' | 'desc' } | null; onSort?: (s: { id: string; dir: 'asc' | 'desc' } | null) => void; total?: number; empty?: { title: string; body?: string } }) {
  const { inspect, setInspect, openGeo, addToCompare, set, state } = useMi()
  const columns = useRowColumns(primary, rows)
  const asGeo = (r: MiRow): MiGeoSummary => ({ id: r.id, level: r.level, level_label: r.level, name: r.label, label: r.label, state: r.state, parent_id: null, parents: {}, centroid: r.centroid, bbox: null, geometry: 'none' })
  return (
    <LCDataGrid<MiRow>
      id={id}
      label={label}
      rows={rows}
      rowKey={(r) => r.id}
      columns={columns}
      density="dense"
      sort={sort ?? null}
      onSortChange={(s) => onSort?.(s as { id: string; dir: 'asc' | 'desc' } | null)}
      activeKey={inspect}
      total={total}
      onActivate={(r, e?: LCRowActivationEvent) => {
        // Click = Inspector beside the table; Cmd/Ctrl+click = the Map beside, framed on it.
        if (e && (('metaKey' in e && e.metaKey) || ('ctrlKey' in e && e.ctrlKey))) { showGeoOnMap(asGeo(r), { lensMetric: state.hm }); return }
        setInspect(r.id)
      }}
      rowMenu={(r) => geoMenu(asGeo(r), { openGeo, addToCompare, setInspect, setTab: (t) => set({ tab: t as never }), heatMetric: state.hm })}
      empty={empty ?? { title: 'No areas match', body: 'Widen the period, the asset class or the minimum sample.' }}
    />
  )
}

export function RankingsSurface({ geo }: { geo: MiGeoSummary }) {
  const { state, set, registry, status } = useMi()
  const levels = ORDER.slice(ORDER.indexOf(geo.level) + 1).filter((l) => !(geo.level === 'county' && l === 'market') && !(geo.level === 'city' && (l === 'market' || l === 'county')))
  const level = state.rl && levels.includes(state.rl as MiLevel) ? state.rl : childLevelOf(geo.level) && levels.includes(childLevelOf(geo.level) as MiLevel) ? (childLevelOf(geo.level) as string) : levels[0]
  const rankable = (registry?.metrics ?? []).filter((m) => m.rankable && metricAvailable(m, status) && m.levels.includes(level as MiLevel) && (state.asset === 'all' || m.assets.includes(state.asset)))
  const metric = rankable.some((m) => m.id === state.rm) ? state.rm : 'sales_count'
  const key = level ? miUrl('rank', { level, within: geo.id, metric, dir: state.rd, min_sales: state.rmin || null, period: state.period, asset: state.asset, limit: 500 }) : null
  const q = useMiQuery<MiRankResult>(key)
  const r = dataOf(q)
  if (!level) return <LCEmpty title="A ZIP has no smaller geographies" body="Open its city, county or market to rank its neighbours." />
  return (
    <div className="mi-rankings mi-fill">
      <div className="mi-toolbar" role="toolbar" aria-label="Ranking controls">
        <LCSegmented label="Rank" size="sm" value={level} onChange={(v) => set({ rl: v })} options={levels.map((l) => ({ value: l, label: LEVEL_PLURAL[l] ?? l }))} />
        <span className="mi-toolbar__in">in {geo.label}</span>
        <LCSelect label="Metric" prefix="By" variant="chip" size="sm" value={metric} onChange={(v) => set({ rm: v })} options={rankable.map((m) => ({ value: m.id, label: m.label, hint: m.group, group: m.group }))} />
        <LCSegmented label="Order" size="sm" value={state.rd} onChange={(v) => set({ rd: v })} options={[{ value: 'desc', label: 'Highest' }, { value: 'asc', label: 'Lowest' }]} />
        <LCSelect label="Minimum sales" prefix="Min sales" variant="chip" size="sm" value={String(state.rmin)} onChange={(v) => set({ rmin: Number(v) })} options={['0', '10', '25', '50', '100', '250'].map((v) => ({ value: v, label: v === '0' ? 'Any' : `≥ ${v}` }))} />
        <span className="mi-toolbar__meta">{r ? `${fmtCount(r.total)} ranked${r.unranked_count ? ` · ${fmtCount(r.unranked_count)} without a supported value` : ''} · ${r.window.from} → ${r.window.to}` : ''}</span>
      </div>
      {r && r.universe.loaded.length < r.universe.states.length && registry?.metrics.find((m) => m.id === metric)?.group === 'universe' ? <UniverseNote states={r.universe.states} loaded={r.universe.loaded} /> : null}
      <div className="mi-grid-host">
        <QueryState q={q}>{(res) => (
          <RowsGrid id={`mi-rank-${level}`} label={`${LEVEL_PLURAL[level]} in ${geo.label} by ${metric}`} rows={res.rows} primary={metric} total={res.total}
            sort={{ id: metric, dir: state.rd }} onSort={(s) => { if (s) set({ rm: s.id, rd: s.dir }) }} />
        )}</QueryState>
      </div>
    </div>
  )
}

export function UniverseNote({ states, loaded }: { states: string[]; loaded: string[] }) {
  return (
    <p className="mi-note">
      Seller-universe figures are summarised from the campaign target graph per state on request. Loaded: {loaded.length} of {states.length} state{states.length === 1 ? '' : 's'}.
      {' '}<UniverseLoad states={states.length > 1 ? 'all' : states[0]} />
    </p>
  )
}

export function UniverseLoad({ states }: { states: string }) {
  const [busy, setBusy] = useState<string | null>(null)
  return (
    <LCButton size="sm" variant="quiet" icon="database" loading={Boolean(busy)} title="Reads the campaign target graph one state at a time (indexed). Summary only." onClick={async () => {
      setBusy('Requesting')
      const r = await miFetch<{ requested: string[] }>('universe_load', { states })
      if (!r.ok) { setBusy(null); return }
      const want = r.data.requested
      // Poll the server's loaded set; refresh every view once the requested states are in.
      for (let i = 0; i < 60; i += 1) {
        await new Promise((res) => window.setTimeout(res, 2000))
        const st = await miFetch<MiStatusPayload>('status')
        const loaded = st.ok ? ((st.data.sources?.graph as { loaded_states?: string[] } | undefined)?.loaded_states ?? []) : []
        if (want.every((s) => loaded.includes(s))) break
      }
      refreshAllMiQueries()
      setBusy(null)
    }}>{busy ? 'Loading seller universe…' : states === 'all' ? 'Load every state (sequential graph reads)' : `Load ${states}`}</LCButton>
  )
}

// ── Map mode (brief §11, §27, §40) ─────────────────────────────────────────
export function MapModeSurface({ geo }: { geo: MiGeoSummary }) {
  const { state, set, registry, setInspect, status } = useMi()
  const heatable = (registry?.metrics ?? []).filter((m) => m.heatable && metricAvailable(m, status))
  const metric = heatable.find((m) => m.id === state.hm) ?? heatable[0]
  const child = childLevelOf(geo.level)
  const key = child && metric ? miUrl('rank', { level: child, within: geo.id, metric: metric.id, period: state.period, asset: state.asset, limit: 20 }) : null
  const q = useMiQuery<MiRankResult>(key)
  const open = () => { writeMiMapContext({ period: state.period, asset: state.asset }); showGeoOnMap(geo, { lensMetric: metric?.id ?? null }) }
  return (
    <div className="mi-mapmode">
      <section className="mi-card">
        <h2>Heat by</h2>
        <div className="mi-heatlist" role="radiogroup" aria-label="Heat metric">
          {heatable.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={m.id === metric?.id} className={m.id === metric?.id ? 'is-on' : undefined} onClick={() => set({ hm: m.id })}>
              <b>{m.label}</b><span>{m.description}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="mi-card mi-mapmode__go">
        <h2>On the Map</h2>
        <p>The heat is a lens on the existing Map: same canvas, same lighting and themes, same pins. States are coloured nationwide; ZIPs from zoom 9, with US Census outlines. Counties, cities and markets have no outline in the database and are not drawn.</p>
        <p className="mi-quiet">Colour is the area's rank among the areas in view, on one blue scale. Hover reads the area's real figures; click opens it here.</p>
        <LCButton variant="primary" icon="map" onClick={open} disabled={!metric}>Open the Map beside: {metric?.label ?? ''}</LCButton>
      </section>
      {child ? (
        <section className="mi-card">
          <h2>{LEVEL_PLURAL[child]} in {geo.label} by {metric?.label}</h2>
          <QueryState q={q}>{(r) => <Leaderboard rows={r.rows} metric={metric?.id ?? 'sales_count'} onPick={(id) => setInspect(id)} />}</QueryState>
        </section>
      ) : null}
    </div>
  )
}

