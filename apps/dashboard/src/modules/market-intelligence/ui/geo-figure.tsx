import { useMemo, useState } from 'react'
import { LCButton, LCSegmented } from '../../../shared/lc'
import { miUrl, useMiQuery } from '../mi-api'
import { useMi } from '../mi-context'
import { fmtCount, fmtUnit } from '../mi-format'
import { showGeoOnMap } from '../mi-handoffs'
import type { MiGeoSummary, MiRankResult, MiUnit } from '../mi-types'
import { writeMiMapContext } from '../map/mi-map-lenses'
import { QueryState } from './parts'
import { figureRequest, projectOutlines } from './figure-model'

/**
 * MAP-FIRST HERO FIGURE: the geography drawn from geometry we own (US Census ZCTAs,
 * or states), coloured by a registry metric over the summary. Static vector art: no
 * tiles, no second map engine. "Open on Map" hands the same lens to the real Map. Colour
 * is the area's rank among the areas drawn, on ONE sequential hue (theme-aware via CSS).
 * Areas outside the geography are drawn quiet; areas without a supported value carry no fill.
 */
interface HeatRow { key: string; id: string; label: string; v: number; n: number; t: number; tip: string; outline: GeoJSON.Geometry }
interface HeatResult { ok: true; level: string; metric: string; label: string; unit: MiUnit; rows: HeatRow[]; without_value: number; note: string | null }

const FIGURE_METRICS: Array<{ id: string; label: string }> = [
  { id: 'sales_count', label: 'Sales' },
  { id: 'median_sale_price', label: 'Median price' },
  { id: 'investor_purchase_share', label: 'Investor share' },
  { id: 'median_ppsf', label: '$/sq ft' },
]

export function GeoHeatFigure({ geo, height = 360 }: { geo: MiGeoSummary; height?: number }) {
  const { state, setInspect, metric: metricDef } = useMi()
  const [metric, setMetric] = useState(FIGURE_METRICS.some((m) => m.id === state.hm) ? state.hm : 'sales_count')
  const req = figureRequest(geo)
  const heatQ = useMiQuery<HeatResult>(req ? miUrl('heat', { metric, bbox: req.bbox, zoom: req.zoom, period: state.period, asset: state.asset }) : null)
  const childLevel = req?.zoom === 4 ? 'state' : 'zip'
  const memberQ = useMiQuery<MiRankResult>(geo.level === 'nation' || geo.level === 'zip' || geo.level === 'state' ? null : miUrl('rank', { level: childLevel, within: geo.id, metric: 'sales_count', period: state.period, asset: state.asset, limit: 500 }))
  const members = useMemo(() => {
    if (geo.level === 'nation') return null
    if (geo.level === 'zip' || geo.level === 'state') return new Set([geo.id])
    return memberQ.kind === 'ready' ? new Set([...memberQ.data.rows, ...memberQ.data.unranked].map((r) => r.id)) : null
  }, [geo, memberQ])
  const [hover, setHover] = useState<HeatRow | null>(null)
  const W = 960
  const unit = metricDef(metric)?.unit ?? 'count'
  return (
    <section className="mi-figure" aria-label={`${geo.label} on the map`}>
      <header className="mi-figure__bar">
        <LCSegmented label="Colour by" size="sm" value={metric} onChange={setMetric} options={FIGURE_METRICS.map((m) => ({ value: m.id, label: m.label }))} />
        <LCButton size="sm" variant="ghost" icon="map" trailingIcon="arrow-up-right" onClick={() => { writeMiMapContext({ period: state.period, asset: state.asset }); showGeoOnMap(geo, { lensMetric: metric }) }}>Open on Map</LCButton>
      </header>
      <QueryState q={heatQ} skeleton={<div className="mi-figure__canvas is-loading" style={{ height }} />}>{(h) => {
        const proj = projectOutlines(h.rows, W, height)
        if (!proj.ok) return <div className="mi-figure__canvas is-empty" style={{ height }}><span>{h.note ?? 'No outlined area with a value here.'}</span></div>
        const byId = new Map(h.rows.map((r) => [r.id, r]))
        return (
          <div className="mi-figure__canvas" style={{ height }}>
            <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`${h.label} by ${h.level === 'zip' ? 'ZIP' : 'state'}`}>
              {proj.paths.map((p) => {
                const r = byId.get(p.id) as HeatRow
                const member = !members || members.has(p.id)
                return (
                  <path key={p.id} d={p.d} fillRule="evenodd" className={`mi-figure__area${member ? '' : ' is-outside'}${hover?.id === p.id ? ' is-hover' : ''}`}
                    style={{ ['--t' as string]: member ? r.t.toFixed(3) : '0' }}
                    onMouseEnter={() => setHover(r)} onMouseLeave={() => setHover(null)} onClick={() => setInspect(p.id)} />
                )
              })}
            </svg>
            <div className="mi-figure__legend" aria-hidden="true">
              <span>{h.label}</span>
              <i className="mi-figure__ramp" />
              <small>low → high, rank among {fmtCount(h.rows.length)} {h.level === 'zip' ? 'ZIPs' : 'states'} drawn{h.without_value ? ` · ${fmtCount(h.without_value)} without a supported value` : ''}</small>
            </div>
            <div className={`mi-figure__read${hover ? ' is-on' : ''}`} role="status">
              {hover ? <><b>{fmtUnit(unit, hover.v)}</b><span>{hover.tip}</span></> : <span>Hover an area to read it · click to inspect</span>}
            </div>
          </div>
        )
      }}</QueryState>
    </section>
  )
}
