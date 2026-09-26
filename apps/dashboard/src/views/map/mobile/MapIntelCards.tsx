/**
 * Floating intelligence cards for the phone map.
 *
 *   LensLegend   what the colour on the map means: a live gradient with the
 *                lens's real domain printed at each end, the source, and how
 *                many areas / properties the view holds. For Acquisition Radar
 *                it is the stage-ring key.
 *   MarketPanel  the ZIP under the map centre — ACS income / rent / vacancy /
 *                renters / housing age, HUD fair-market rent, FHFA price growth
 *                and FEMA flood share (get_map_area_intel). Updates as the map
 *                settles; never invents a value it doesn't have.
 */
import { useEffect, useRef, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { getSupabaseClient } from '../../../lib/supabaseClient'
import { shouldUseSupabase } from '../../../lib/data/shared'
import { UNIVERSAL_STAGE_RING_COLORS } from '../universal-stage-colors'
import { formatLensValue, LENS_RAMPS, type MapLens } from './map-lenses'
import type { LensState } from './useMapLens'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export const rampGradient = (lens: MapLens, dir = '90deg') =>
  `linear-gradient(${dir}, ${LENS_RAMPS[lens.ramp ?? 'heat'].join(', ')})`

const STAGE_KEY: Array<[string, string]> = [
  ['Uncontacted', UNIVERSAL_STAGE_RING_COLORS.uncontacted],
  ['Ownership check', UNIVERSAL_STAGE_RING_COLORS.ownership_check],
  ['Talking', UNIVERSAL_STAGE_RING_COLORS.active_communication],
  ['Negotiating', UNIVERSAL_STAGE_RING_COLORS.negotiating],
  ['Hot', UNIVERSAL_STAGE_RING_COLORS.hot_urgent],
  ['Follow-up', UNIVERSAL_STAGE_RING_COLORS.follow_up_due],
]

export function LensLegend({ lens, state, zoom }: { lens: MapLens; state: LensState; zoom: number }) {
  if (!lens.source || lens.ambient) {
    return (
      <div className="mx-legend mx-glass" data-map-card="legend">
        <div className="mx-legend__head"><strong>{lens.label}</strong><span>Ring = stage</span></div>
        <div className="mx-legend__stages">
          {STAGE_KEY.map(([label, c]) => (
            <span key={label}><i style={{ borderColor: c }} />{label}</span>
          ))}
        </div>
      </div>
    )
  }
  const [a, b] = lens.domain ?? [0, 1]
  // Cold end on the left. Inverted lenses (older = hotter) read newest → oldest.
  const coldLabel = lens.invert ? `${formatLensValue(lens, b)}+` : `≤ ${formatLensValue(lens, a)}`
  const hotLabel = lens.invert ? `≤ ${formatLensValue(lens, a)}` : `${formatLensValue(lens, b)}+`
  const range = state.lensId === lens.id ? state.inView : null
  const unit = lens.areal ? 'areas' : zoom >= 13 ? 'properties' : 'cells'
  return (
    <div className={cls('mx-legend mx-glass', state.loading && 'is-loading')} data-map-card="legend">
      <div className="mx-legend__head">
        <strong>{lens.label}</strong>
        <span>{state.error ? state.error : state.loading && !state.count ? 'Reading…' : `${state.count.toLocaleString()} ${unit}`}</span>
      </div>
      <div className="mx-legend__bar" style={{ backgroundImage: rampGradient(lens) }}><i /></div>
      <div className="mx-legend__ends">
        <span>{lens.id === 'territory' ? 'Sparse' : coldLabel}</span>
        {range && lens.id !== 'territory' && lens.id !== 'execution' && (
          <em>here {formatLensValue(lens, range[0])} – {formatLensValue(lens, range[1])}</em>
        )}
        <span>{lens.id === 'territory' ? 'Dense' : hotLabel}</span>
      </div>
      <p className="mx-legend__src">{[lens.attribution, 'hold the map to read a value'].filter(Boolean).join(' · ')}</p>
    </div>
  )
}

interface AreaIntel {
  zip?: string
  city?: string | null
  state?: string | null
  population?: number | null
  median_household_income?: number | null
  median_gross_rent?: number | null
  vacancy_rate?: number | null
  renter_share?: number | null
  median_year_built?: number | null
  rent_burden?: number | null
  vintage?: string | number | null
  fmr_2br?: number | null
  hpi_5y?: number | null
  hpi_1y?: number | null
  flood_sfha_share?: number | null
}

const money = (v?: number | null) => (v == null ? null : v >= 1000 ? `$${Math.round(v / 1000)}K` : `$${Math.round(v).toLocaleString()}`)
const dollars = (v?: number | null) => (v == null ? null : `$${Math.round(v).toLocaleString()}`)
const pct = (v?: number | null, digits = 0) => (v == null ? null : `${(v * 100).toFixed(digits)}%`)
const signedPct = (v?: number | null) => (v == null ? null : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%`)

export function MarketPanel({ map, epoch, onClose }: { map: maplibregl.Map | null; epoch: number; onClose: () => void }) {
  const [intel, setIntel] = useState<AreaIntel | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'empty' | 'zoom' | 'error'>('idle')
  const seq = useRef(0)
  const lastZip = useRef<string | null>(null)

  useEffect(() => {
    if (!map) return
    if (!shouldUseSupabase()) { setState('error'); return }
    let timer = 0
    const load = async () => {
      if (map.getZoom() < 7) { setState('zoom'); return }
      const id = ++seq.current
      const c = map.getCenter()
      setState((s) => (s === 'idle' || s === 'zoom' ? 'loading' : s))
      const { data, error } = await getSupabaseClient().rpc('get_map_area_intel', { p_lat: c.lat, p_lng: c.lng })
      if (id !== seq.current) return
      if (error) { setState('error'); return }
      if (!data || !(data as AreaIntel).zip) { setIntel(null); setState('empty'); return }
      lastZip.current = (data as AreaIntel).zip ?? null
      setIntel(data as AreaIntel)
      setState('idle')
    }
    const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { void load() }, 380) }
    schedule()
    map.on('moveend', schedule)
    return () => { map.off('moveend', schedule); window.clearTimeout(timer) }
  }, [map, epoch])

  const metrics: Array<[string, string | null, string?]> = intel ? [
    ['Income', money(intel.median_household_income), 'median household'],
    ['Rent', dollars(intel.median_gross_rent), 'median gross'],
    ['FMR 2-bed', dollars(intel.fmr_2br), 'HUD'],
    ['5-yr growth', signedPct(intel.hpi_5y), intel.hpi_1y != null ? `1-yr ${signedPct(intel.hpi_1y)}` : 'FHFA'],
    ['Renters', pct(intel.renter_share), 'of households'],
    ['Vacancy', pct(intel.vacancy_rate, 1), 'of units'],
    ['Built', intel.median_year_built ? String(Math.round(intel.median_year_built)) : null, 'median year'],
    ['Flood zone', pct(intel.flood_sfha_share), 'FEMA SFHA'],
  ] : []
  const shown = metrics.filter(([, v]) => v != null)

  return (
    <div className={cls('mx-market mx-glass', state === 'loading' && 'is-loading')} data-map-card="market">
      <div className="mx-market__head">
        <span className="mx-market__zip">{intel?.zip ? `ZIP ${intel.zip}` : 'Market'}</span>
        <strong>{intel ? [intel.city, intel.state].filter(Boolean).join(', ') || 'Area in view' : state === 'zoom' ? 'Zoom in for a market read' : state === 'empty' ? 'No market data here' : state === 'error' ? 'Market data unavailable' : 'Reading the area…'}</strong>
        <button type="button" className="mx-btn is-sm" aria-label="Hide market panel" onClick={onClose}>×</button>
      </div>
      {shown.length > 0 && (
        <div className="mx-market__grid" key={intel?.zip}>
          {shown.map(([label, value, sub], i) => (
            <div key={label} className="mx-market__cell" style={{ animationDelay: `${i * 30}ms` }}>
              <span>{label}</span>
              <strong>{value}</strong>
              {sub && <em>{sub}</em>}
            </div>
          ))}
        </div>
      )}
      {intel && (
        <p className="mx-legend__src">
          US Census ACS{intel.vintage ? ` ${intel.vintage}` : ''}{intel.population ? ` · pop ${Math.round(intel.population).toLocaleString()}` : ''}
        </p>
      )}
    </div>
  )
}
