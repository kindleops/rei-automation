import { useEffect, useState } from 'react'
import { LCButton, LCChip, LCEmpty, LCIconButton, LCSegmented, LCSelect } from '../../../shared/lc'
import { dataOf, miUrl, useMiQuery } from '../mi-api'
import { useMi } from '../mi-context'
import { fmtValue } from '../mi-format'
import type { MiCompareResult, MiGeoSummary, MiLevel, MiScreenFilter, MiScreenResult, MiUnit } from '../mi-types'
import { TrendChart } from './charts'
import { metricAvailable, seriesColor } from './ui-model'
import { ExploreBar, QueryState } from './parts'
import { RowsGrid } from './surfaces-core'

// ── Compare (brief §23, §50) ───────────────────────────────────────────────
const CMP_GROUPS: Array<{ label: string; ids: string[] }> = [
  { label: 'Sales', ids: ['sales_count', 'monthly_sales_rate', 'sales_growth', 'median_sale_price', 'median_ppsf', 'median_price_per_unit'] },
  { label: 'Buyer evidence (shares of the sales that record it)', ids: ['investor_purchase_share', 'buyer_evidence_coverage', 'cash_purchase_share', 'cash_evidence_coverage', 'investor_purchase_count'] },
  { label: 'Ownership', ids: ['entity_owned_count'] },
  { label: 'Buyer depth', ids: ['company_buyer_count', 'repeat_buyer_count', 'top5_buyer_share'] },
  { label: 'Seller universe', ids: ['property_count', 'seller_record_count', 'sms_eligible_count'] },
  { label: 'Demographics', ids: ['population', 'median_household_income', 'renter_share', 'vacancy_rate'] },
]
const CMP_SERIES = [{ id: 'sales', label: 'Sales' }, { id: 'median_price', label: 'Median price' }, { id: 'investor_purchases', label: 'Investor purchases' }, { id: 'investor_share', label: 'Investor share' }] as const

export function CompareSurface() {
  const { state, set, metric, setInspect } = useMi()
  // Names from the Deck ("compare Dallas Houston") resolve to each name's best search match
  // (six fixed query slots); the chips then show exactly which geography was picked.
  const names = state.cq
  const r0 = useMiQuery<{ results: MiGeoSummary[] }>(names[0] ? miUrl('search', { q: names[0], limit: 1 }) : null)
  const r1 = useMiQuery<{ results: MiGeoSummary[] }>(names[1] ? miUrl('search', { q: names[1], limit: 1 }) : null)
  const r2 = useMiQuery<{ results: MiGeoSummary[] }>(names[2] ? miUrl('search', { q: names[2], limit: 1 }) : null)
  const r3 = useMiQuery<{ results: MiGeoSummary[] }>(names[3] ? miUrl('search', { q: names[3], limit: 1 }) : null)
  const r4 = useMiQuery<{ results: MiGeoSummary[] }>(names[4] ? miUrl('search', { q: names[4], limit: 1 }) : null)
  const r5 = useMiQuery<{ results: MiGeoSummary[] }>(names[5] ? miUrl('search', { q: names[5], limit: 1 }) : null)
  const slots = [r0, r1, r2, r3, r4, r5].slice(0, names.length)
  const resolved = names.length > 0 && slots.every((r) => r.kind === 'ready' || r.kind === 'error')
  const resolvedIds = resolved ? slots.map((r) => (r.kind === 'ready' ? r.data.results[0]?.id : undefined)).filter((x): x is string => Boolean(x)) : []
  const resolvedKey = resolvedIds.join(',')
  useEffect(() => {
    if (resolved) set({ cq: [], cmp: [...new Set([...state.cmp, ...resolvedKey.split(',').filter(Boolean)])].slice(0, 6) })
  }, [resolved, resolvedKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const resolving = names.length && !resolved ? names.join(', ') : null
  const [lead, setLead] = useState<string>('')
  const [series, setSeries] = useState<(typeof CMP_SERIES)[number]['id']>('sales')
  const key = state.cmp.length >= 2 ? miUrl('compare', { ids: state.cmp.join(','), period: state.period, asset: state.asset }) : null
  const q = useMiQuery<MiCompareResult>(key)
  const remove = (id: string) => set({ cmp: state.cmp.filter((x) => x !== id) })
  const labelOf = (id: string) => dataOf(q)?.items.find((i) => i.id === id)?.label ?? id.replace(/^[a-z]+:/, '').replace(/^[A-Z]{2}:/, '')
  return (
    <div className="mi-compare">
      <div className="mi-toolbar" role="toolbar" aria-label="Compare set">
        {state.cmp.map((id, i) => <LCChip key={id} onRemove={() => remove(id)} title={id} value={<><i className="mi-swatch" style={{ background: seriesColor(i) }} />{labelOf(id)}</>} />)}
        {state.cmp.length < 6 ? <div className="mi-compare__add"><ExploreBar onPick={(id) => set({ cmp: [...new Set([...state.cmp, id])].slice(0, 6) })} /></div> : null}
        {resolving ? <span className="mi-toolbar__meta">Resolving {resolving}…</span> : null}
      </div>
      {state.cmp.length < 2 ? <LCEmpty title="Compare 2 to 6 geographies" body="Add ZIPs, cities, counties, markets or states. Every column uses the same period, asset class, metric definitions and sample rules." /> : (
        <QueryState q={q}>{(c) => (
          <>
            <div className="mi-toolbar">
              <span className="mi-toolbar__meta">{c.window.from} → {c.window.to} · {c.window.asset_label} · same rules for every column</span>
              <LCSelect label="Highlight leader" prefix="Leader by" variant="chip" size="sm" value={lead} onChange={setLead} options={[{ value: '', label: 'No highlight' }, ...CMP_GROUPS.flatMap((g) => g.ids).map((id) => ({ value: id, label: metric(id)?.label ?? id }))]} />
            </div>
            <div className="mi-card mi-cmp-table">
              <table className="mi-table">
                <thead><tr><th>Metric</th>{c.items.map((it, i) => <th key={it.id} className="r"><button type="button" className="mi-linkish" onClick={() => setInspect(it.id)}><i className="mi-swatch" style={{ background: seriesColor(i) }} />{it.label}</button></th>)}</tr></thead>
                <tbody>
                  {CMP_GROUPS.map((g) => (
                    <FragmentRows key={g.label} label={g.label} cols={c.items.length}>
                      {g.ids.map((id) => {
                        const vals = c.items.map((it) => it.values[id])
                        const okVals = vals.map((v) => (v?.status === 'ok' ? (v.value as number) : null))
                        const max = Math.max(...okVals.filter((x): x is number => x !== null), 0)
                        const leader = lead === id ? okVals.indexOf(max) : -1
                        return (
                          <tr key={id}>
                            <th scope="row">{metric(id)?.label ?? id}</th>
                            {vals.map((v, i) => (
                              <td key={i} className={`r${leader === i && max ? ' is-lead' : ''}${v?.status === 'ok' ? '' : ' is-withheld'}`} title={v?.status === 'ok' ? `n ${v.n}${v.basis ? ` · ${v.basis}` : ''}` : v?.reason}>
                                {fmtValue(metric(id), v)}
                                {okVals[i] !== null && max > 0 ? <span className="mi-cmp-bar"><i style={{ width: `${((okVals[i] as number) / max) * 100}%`, background: seriesColor(i) }} /></span> : null}
                              </td>
                            ))}
                          </tr>
                        )
                      })}
                    </FragmentRows>
                  ))}
                </tbody>
              </table>
            </div>
            <section className="mi-card">
              <h2>Over time <LCSegmented label="Series" size="sm" value={series} onChange={setSeries} options={CMP_SERIES.map((s) => ({ value: s.id, label: s.label }))} /></h2>
              <TrendChart series={c.series.map((s) => ({ id: s.id, label: c.items.find((i) => i.id === s.id)?.label ?? s.label, points: s.months.map((p) => ({ month: p.month, y: (p[series] as number | null) ?? null, status: p.status })) }))}
                format={(v) => (series === 'investor_share' ? `${Math.round(v * 100)}%` : series === 'median_price' ? `$${Math.round(v / 1000)}K` : Math.round(v).toLocaleString('en-US'))} label="Compare over time" height={220} />
            </section>
          </>
        )}</QueryState>
      )}
    </div>
  )
}

function FragmentRows({ label, cols, children }: { label: string; cols: number; children: React.ReactNode }) {
  return <><tr className="mi-table__group"><th colSpan={cols + 1}>{label}</th></tr>{children}</>
}

// ── Screener (brief §24) ───────────────────────────────────────────────────
const OPS: Array<{ value: MiScreenFilter['op']; label: string }> = [{ value: 'gte', label: '≥' }, { value: 'lte', label: '≤' }, { value: 'gt', label: '>' }, { value: 'lt', label: '<' }]
const SCREEN_LEVELS: MiLevel[] = ['zip', 'city', 'county', 'market', 'state']
const SCREEN_LEVEL_LABEL: Partial<Record<MiLevel, string>> = { zip: 'ZIPs', city: 'Cities', county: 'Counties', market: 'Markets', state: 'States' }
const toDisplay = (unit: MiUnit, v: number) => (unit === 'pct' ? +(v * 100).toFixed(2) : v)
const fromDisplay = (unit: MiUnit, v: number) => (unit === 'pct' ? v / 100 : v)
const unitHint = (unit: MiUnit) => (unit === 'pct' ? '%' : unit === 'usd' ? '$' : unit === 'year' ? 'year' : '')

export function ScreenerSurface({ geo }: { geo: MiGeoSummary }) {
  const { state, set, registry, metric, status } = useMi()
  const within = state.sw ?? geo.id
  const level = SCREEN_LEVELS.includes(state.sl as MiLevel) ? (state.sl as MiLevel) : 'zip'
  const screenable = (registry?.metrics ?? []).filter((m) => m.screenable && metricAvailable(m, status) && m.levels.includes(level) && (state.asset === 'all' || m.assets.includes(state.asset)))
  const key = miUrl('screen', { level, within, filters: JSON.stringify(state.sf), match: state.sm, period: state.period, asset: state.asset })
  const q = useMiQuery<MiScreenResult>(key)
  const setFilter = (i: number, patch: Partial<MiScreenFilter>) => set({ sf: state.sf.map((f, k) => (k === i ? { ...f, ...patch } : f)) })
  const sortBy = state.sf[0]?.metric ?? 'sales_count'
  return (
    <div className="mi-screener mi-fill">
      <div className="mi-toolbar" role="toolbar" aria-label="Screen scope">
        <LCSegmented label="Screen" size="sm" value={level} onChange={(v) => set({ sl: v })} options={SCREEN_LEVELS.map((l) => ({ value: l, label: SCREEN_LEVEL_LABEL[l] ?? l }))} />
        <span className="mi-toolbar__in">inside {within === geo.id ? geo.label : within}</span>
        {within !== 'nation:US' ? <LCButton size="sm" variant="quiet" onClick={() => set({ sw: 'nation:US' })}>Nationwide</LCButton> : null}
        <LCSegmented label="Match" size="sm" value={state.sm} onChange={(v) => set({ sm: v })} options={[{ value: 'all', label: 'All filters' }, { value: 'any', label: 'Any filter' }]} />
      </div>
      <div className="mi-card mi-filters">
        {state.sf.map((f, i) => {
          const m = metric(f.metric)
          const unit = m?.unit ?? 'count'
          return (
            <div key={i} className="mi-filter">
              <LCSelect label="Metric" variant="field" size="sm" value={f.metric} onChange={(v) => setFilter(i, { metric: v })} options={screenable.map((x) => ({ value: x.id, label: x.label, group: x.group }))} />
              <LCSelect label="Operator" variant="field" size="sm" value={f.op} onChange={(v) => setFilter(i, { op: v })} options={OPS} />
              <label className="mi-num"><input type="number" inputMode="decimal" aria-label={`${m?.label ?? f.metric} value`} value={String(toDisplay(unit, f.value))} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) setFilter(i, { value: fromDisplay(unit, n) }) }} /><span>{unitHint(unit)}</span></label>
              <span className="mi-quiet">{m?.min_sample && m.min_sample > 1 ? `needs n ≥ ${m.min_sample}` : ''}</span>
              <LCIconButton icon="close" label="Remove filter" size="sm" onClick={() => set({ sf: state.sf.filter((_, k) => k !== i) })} />
            </div>
          )
        })}
        <LCButton size="sm" variant="secondary" icon="plus" disabled={state.sf.length >= 12 || !screenable.length} onClick={() => set({ sf: [...state.sf, { metric: screenable[0]?.id ?? 'sales_count', op: 'gte', value: 0 }] })}>Add filter</LCButton>
        <p className="mi-quiet">Filters come from the metric registry for this level. An area whose value is thin-sample or unavailable never passes a filter on that metric.</p>
      </div>
      <QueryState q={q}>{(r) => (
        <>
          {r.rejected.length ? <p className="mi-note">Ignored: {r.rejected.map((x) => `${x.metric} (${x.reason})`).join(', ')}</p> : null}
          {r.universe_incomplete ? <p className="mi-note">A seller-universe filter is applied but only {r.universe.loaded.length} of {r.universe.states.length} states are loaded; unloaded areas cannot pass it.</p> : null}
          <p className="mi-toolbar__meta">{r.total.toLocaleString('en-US')} of {r.considered.toLocaleString('en-US')} pass · {r.window.from} → {r.window.to} · {r.window.asset_label}</p>
          <div className="mi-grid-host"><RowsGrid id={`mi-screen-${level}`} label="Screen results" rows={r.rows} primary={sortBy} total={r.total} empty={{ title: 'Nothing passes this screen', body: 'Loosen a filter, widen the period or screen a larger area.' }} /></div>
        </>
      )}</QueryState>
    </div>
  )
}
