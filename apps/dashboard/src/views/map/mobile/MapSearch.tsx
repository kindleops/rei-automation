/**
 * Map search — one liquid-glass field for a state, market, county, city, ZIP
 * or street address (map_search).
 *
 * Choosing an area flies there, lights its outline, and opens the area card
 * (get_map_area_facts): the property mix, the last 12 months of MLS vs investor
 * sales with medians, institutional / builder / portfolio activity, who is
 * buying, and ACS census. Choosing an address flies to it and opens the
 * property.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type maplibregl from 'maplibre-gl'
import { getSupabaseClient } from '../../../lib/supabaseClient'
import { shouldUseSupabase } from '../../../lib/data/shared'
import { Icon } from '../../../shared/icons'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export type SearchKind = 'state' | 'market' | 'county' | 'city' | 'zip' | 'property'
export interface SearchHit {
  kind: SearchKind
  key: string
  label: string
  state?: string | null
  n: number
  bbox?: [number, number, number, number]
  center?: [number, number]
  sub?: string | null
}

interface AreaFacts {
  kind: SearchKind
  key: string
  label: string
  n: number
  bbox: [number, number, number, number]
  outline: GeoJSON.Geometry
  properties: { count: number; types: Array<{ type: string; n: number }>; avg_equity_pct: number | null; median_value: number | null; median_year_built: number | null; free_clear: number; tax_delinquent: number }
  sales: { mls_sales: number; mls_median_price: number | null; mls_median_ppsf: number | null; public_record_sales: number; investor_sales: number; investor_median_price: number | null; institutional_sales: number; builder_sales: number; portfolio_sales: number; sold_type: string | null }
  top_buyers: Array<{ buyer: string; buyer_class: string; n: number }>
  census: { median_household_income: number | null; median_gross_rent: number | null; vacancy_rate: number | null; renter_share: number | null; median_year_built: number | null; population: number | null; vintage: number | string | null } | null
}

const KIND_LABEL: Record<SearchKind, string> = { state: 'State', market: 'Market', county: 'County', city: 'City', zip: 'ZIP', property: 'Property' }
const KIND_ICON: Record<SearchKind, string> = { state: 'globe', market: 'target', county: 'layers', city: 'grid', zip: 'hash', property: 'home' }

const usd = (v?: number | null) => (v == null || !Number.isFinite(v) || v <= 0 ? '—' : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1000)}K`)
const pct = (v?: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const titleCase = (s?: string | null) => (s ? s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : '')

const SRC = 'nx-search-area'

function drawOutline(map: maplibregl.Map, geom: GeoJSON.Geometry | null) {
  try {
    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      const c = getComputedStyle(document.documentElement).getPropertyValue('--nexus-accent').trim() || '#38bdf8'
      map.addLayer({ id: `${SRC}-fill`, type: 'fill', source: SRC, paint: { 'fill-color': c, 'fill-opacity': 0.08 } })
      map.addLayer({ id: `${SRC}-glow`, type: 'line', source: SRC, paint: { 'line-color': c, 'line-width': 10, 'line-blur': 8, 'line-opacity': 0.55 } })
      map.addLayer({ id: `${SRC}-line`, type: 'line', source: SRC, layout: { 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 1.6, 'line-opacity': 0.9 } })
    }
    ;(map.getSource(SRC) as maplibregl.GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: geom ? [{ type: 'Feature', geometry: geom, properties: {} }] : [],
    })
  } catch { /* style mid-swap */ }
}

export interface MapSearchProps {
  map: maplibregl.Map | null
  epoch: number
  reducedMotion: boolean
  /** Open a property (fly + select). */
  onProperty: (hit: { propertyId: string; lng: number; lat: number; label: string }) => void
  /** The search is open / an area card is showing (the chrome yields). */
  onActiveChange?: (active: boolean) => void
}

export function MapSearch({ map, epoch, reducedMotion, onProperty, onActiveChange }: MapSearchProps) {
  const [q, setQ] = useState('')
  const [focused, setFocused] = useState(false)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [busy, setBusy] = useState(false)
  const [facts, setFacts] = useState<AreaFacts | null>(null)
  const [factsLoading, setFactsLoading] = useState(false)
  const seq = useRef(0)
  const input = useRef<HTMLInputElement | null>(null)

  useEffect(() => { onActiveChange?.(focused || Boolean(facts) || factsLoading) }, [focused, facts, factsLoading, onActiveChange])

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2 || !shouldUseSupabase()) { setHits([]); return }
    const id = ++seq.current
    setBusy(true)
    const t = window.setTimeout(async () => {
      const { data } = await getSupabaseClient().rpc('map_search', { p_q: term })
      if (id !== seq.current) return
      setHits(Array.isArray(data) ? (data as SearchHit[]) : [])
      setBusy(false)
    }, 180)
    return () => window.clearTimeout(t)
  }, [q])

  // Keep the outline across style swaps.
  const factsRef = useRef(facts)
  factsRef.current = facts
  useEffect(() => {
    if (!map) return
    const redraw = () => { if (factsRef.current) drawOutline(map, factsRef.current.outline) }
    map.on('styledata', redraw)
    return () => { map.off('styledata', redraw) }
  }, [map, epoch])

  const fly = (bbox?: [number, number, number, number], center?: [number, number], zoom?: number) => {
    if (!map) return
    if (bbox && bbox[0] !== bbox[2]) {
      map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], {
        padding: { top: 150, bottom: 380, left: 36, right: 76 }, maxZoom: 14, duration: reducedMotion ? 0 : 1800, curve: 1.6, essential: true,
      })
    } else if (center) {
      map.flyTo({ center, zoom: zoom ?? 13, duration: reducedMotion ? 0 : 1800, curve: 1.6, essential: true })
    }
  }

  const choose = async (hit: SearchHit) => {
    setFocused(false)
    input.current?.blur()
    setQ(hit.kind === 'property' ? titleCase(hit.label) : hit.label)
    if (hit.kind === 'property') {
      if (hit.center) {
        fly(undefined, hit.center, 16.5)
        onProperty({ propertyId: hit.key, lng: hit.center[0], lat: hit.center[1], label: hit.label })
      }
      return
    }
    fly(hit.bbox, hit.center)
    setFacts(null)
    setFactsLoading(true)
    const { data } = await getSupabaseClient().rpc('get_map_area_facts', { p_kind: hit.kind, p_key: hit.key })
    setFactsLoading(false)
    if (!data) return
    const f = data as AreaFacts
    setFacts(f)
    if (map) drawOutline(map, f.outline)
  }

  const clear = () => {
    setQ('')
    setHits([])
    setFacts(null)
    setFactsLoading(false)
    if (map) drawOutline(map, null)
  }

  const open = focused && q.trim().length >= 2
  const s = facts?.sales
  const p = facts?.properties
  const topType = p?.types?.[0]

  return (
    <>
      <div className={cls('mx-search', focused && 'is-focused', (facts || q) && 'has-value')} data-map-control="search">
        <Icon name="search" size={16} />
        <input
          ref={input}
          type="search"
          inputMode="search"
          enterKeyHint="search"
          placeholder="Search address, ZIP, city, county, market, state"
          aria-label="Search the map"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => window.setTimeout(() => setFocused(false), 160)}
          onKeyDown={(e) => { if (e.key === 'Enter' && hits[0]) void choose(hits[0]) }}
        />
        {busy && open && <span className="mx-search__spin" aria-hidden="true" />}
        {(q || facts) && (
          <button type="button" className="mx-search__clear" aria-label="Clear search" onMouseDown={(e) => e.preventDefault()} onClick={clear}>
            <Icon name="close" size={12} />
          </button>
        )}
      </div>

      {open && (
        <ul className="mx-search__results" role="listbox" aria-label="Search results">
          {hits.length === 0 && !busy && <li className="mx-search__empty">No match for “{q.trim()}”</li>}
          {hits.map((h, i) => (
            <li key={`${h.kind}:${h.key}`} style={{ animationDelay: `${i * 25}ms` }}>
              <button type="button" role="option" aria-selected={false} onMouseDown={(e) => e.preventDefault()} onClick={() => void choose(h)} data-search-kind={h.kind}>
                <span className={cls('mx-search__icon', `k-${h.kind}`)} aria-hidden="true"><Icon name={KIND_ICON[h.kind] as never} size={14} /></span>
                <span className="mx-row__copy">
                  <strong>{h.kind === 'property' ? titleCase(h.label) : h.label}</strong>
                  <span>{h.kind === 'property' ? [KIND_LABEL.property, h.sub].filter(Boolean).join(' · ') : `${KIND_LABEL[h.kind]} · ${h.n.toLocaleString()} properties`}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {(facts || factsLoading) && createPortal(
        <div className="mx-areacard" role="dialog" aria-label={facts?.label ?? 'Area'} data-map-card="area">
          <div className="mx-areacard__head">
            <span className="mx-areacard__kind">{facts ? KIND_LABEL[facts.kind] : 'Area'}</span>
            <strong>{facts ? (facts.kind === 'zip' ? `ZIP ${facts.label}` : facts.label) : 'Reading the area…'}</strong>
            <button type="button" className="mx-btn is-sm" aria-label="Close area" onClick={clear} data-map-sheet-close><Icon name="close" size={13} /></button>
          </div>
          {factsLoading && !facts && <div className="mx-area__loading"><span /><span /><span /></div>}
          {facts && s && p && (
            <div className="mx-areacard__body">
              <div className="mx-areacard__hero">
                <div><strong>{p.count.toLocaleString()}</strong><span>properties</span></div>
                <div><strong>{s.investor_sales.toLocaleString()}</strong><span>investor buys · 12 mo</span></div>
                <div><strong>{s.mls_sales.toLocaleString()}</strong><span>MLS sales · 12 mo</span></div>
              </div>
              <div className="mx-areacard__grid">
                {[
                  ['MLS median', usd(s.mls_median_price)],
                  ['Investor median', usd(s.investor_median_price)],
                  ['MLS $/sq ft', s.mls_median_ppsf ? `$${Math.round(s.mls_median_ppsf)}` : '—'],
                  ['Institutional', s.institutional_sales.toLocaleString()],
                  ['Portfolio sales', s.portfolio_sales.toLocaleString()],
                  ['Builders', s.builder_sales.toLocaleString()],
                  ['Predominant', topType ? `${topType.type} ${Math.round((topType.n / Math.max(1, p.count)) * 100)}%` : '—'],
                  ['Median value', usd(p.median_value)],
                  ['Avg equity', p.avg_equity_pct == null ? '—' : `${Math.round(p.avg_equity_pct)}%`],
                ].map(([k, v], i) => (
                  <div key={k} className="mx-area__cell" style={{ animationDelay: `${i * 30}ms` }}><span>{k}</span><strong>{v}</strong></div>
                ))}
              </div>
              {facts.top_buyers.length > 0 && (
                <section className="mx-block">
                  <h3>Who is buying · 12 months</h3>
                  <ul className="mx-areacard__buyers">
                    {facts.top_buyers.map((b) => (
                      <li key={b.buyer} className={cls((b.buyer_class === 'institutional' || b.buyer_class === 'hedge_fund') && 'is-gold')}>
                        <span>{titleCase(b.buyer)}</span>
                        <em>{b.n} · {b.buyer_class.replace('_', ' ')}</em>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {facts.census && (
                <div className="mx-areacard__census">
                  {[
                    ['Income', usd(facts.census.median_household_income)],
                    ['Rent', facts.census.median_gross_rent ? `$${Math.round(facts.census.median_gross_rent).toLocaleString()}` : '—'],
                    ['Renters', pct(facts.census.renter_share)],
                    ['Vacancy', pct(facts.census.vacancy_rate)],
                  ].map(([k, v]) => <div key={k}><span>{k}</span><strong>{v}</strong></div>)}
                  <p className="mx-legend__src">US Census ACS{facts.census.vintage ? ` ${facts.census.vintage}` : ''}{facts.kind === 'market' ? ' · core city' : ''}</p>
                </div>
              )}
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
