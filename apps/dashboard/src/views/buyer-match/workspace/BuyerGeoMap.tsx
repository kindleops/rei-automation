/**
 * BUYER MATCH · GEOGRAPHY — a real MapLibre map of the evidence around the
 * subject: the subject pin, the evidence radius, and every recorded purchase
 * inside it coloured by buyer, with a legend, a hover card and a list synced
 * with the map. Same CARTO basemap as Comp Intelligence and the Map app.
 *
 * Purchases are one GeoJSON layer (never a DOM marker per sale); only the
 * subject is a DOM marker. Hover is feature-state, so hovering a row lights
 * its point and hovering a point lights its row.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl, { type GeoJSONSource } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { BuyerMatchWorkspace, MatchedBuyer } from '../../../domain/buyer-match/buyer-match-workspace-api'
import { money } from '../../../domain/buyer-match/buyer-match-workspace-api'
import { ringFeatures, ringLabelFeatures, styleFor } from '../../comp-intelligence/desktop/map-style'
import type { Holding, ReceiptSet } from './buyer-match-cockpit-model'
import { street } from './buyer-match-cockpit-model'
import { cls } from './BuyerMatchParts'
import { buildGeoModel, listOrder, pointCollection, radiusBounds, type GeoPoint } from './buyer-geo-model'
import './bm-geo-map.css'

const LIST_MAX = 80
const fmtDate = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null)
const mi = (m: number | null) => (m === null ? null : m < 10 ? `${m.toFixed(1)} mi` : `${Math.round(m)} mi`)
const priceText = (p: GeoPoint) => (p.kind === 'holding' ? (p.price ? `${money(p.price)} value` : 'Value not recorded') : p.price ? (p.nominal ? `${money(p.price)} · nominal` : money(p.price)) : 'No price recorded')

export interface BuyerGeoMapProps {
  w: BuyerMatchWorkspace
  buyers: MatchedBuyer[]
  selectedId: string | null
  onSelectBuyer?: (id: string) => void
  theme: string
  /** fallback evidence when the window read is absent */
  set: ReceiptSet
  holdings: Holding[]
  loading: boolean
}

export function BuyerGeoMap({ w, buyers, selectedId, onSelectBuyer, theme, set, holdings, loading }: BuyerGeoMapProps) {
  const s = w.subject
  const located = s.lat !== null && s.lng !== null
  const model = useMemo(
    () => buildGeoModel({ w, buyers, selectedId, receipts: set.receipts, holdings }),
    [w, buyers, selectedId, set.receipts, holdings],
  )
  const rows = useMemo(() => listOrder(model.points), [model.points])
  const byKey = useMemo(() => new Map(model.points.map((p) => [p.key, p])), [model.points])
  const anySelected = model.points.some((p) => p.selected) && model.points.some((p) => !p.selected)

  const host = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLOListElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const hoveredRef = useRef<string | null>(null)
  const [hover, setHover] = useState<{ key: string; from: 'map' | 'list' } | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [styled, setStyled] = useState(0)
  const latest = useRef({ model, anySelected, onSelectBuyer, theme, R: w.query.radiusMiles, lat: s.lat, lng: s.lng })
  latest.current = { model, anySelected, onSelectBuyer, theme, R: w.query.radiusMiles, lat: s.lat, lng: s.lng }

  const setHovered = (key: string | null) => {
    const map = mapRef.current
    const prev = hoveredRef.current
    if (map?.getSource('bmg-pts')) {
      if (prev) map.setFeatureState({ source: 'bmg-pts', id: prev }, { hover: false })
      if (key) map.setFeatureState({ source: 'bmg-pts', id: key }, { hover: true })
    }
    hoveredRef.current = key
  }

  // create once
  useEffect(() => {
    if (!host.current || mapRef.current || !located) return
    const l = latest.current
    const map = new maplibregl.Map({
      container: host.current,
      style: styleFor(theme, false),
      bounds: radiusBounds(l.lat as number, l.lng as number, l.R * 1.08),
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      maxPitch: 0,
      fadeDuration: 0,
    })
    map.touchZoomRotate.disableRotation()
    map.keyboard.disableRotation()
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')
    mapRef.current = map

    const el = document.createElement('div')
    el.className = 'bmg-subject'
    el.setAttribute('aria-label', 'Subject property')
    el.innerHTML = '<i></i><span>Subject</span>'
    new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([l.lng as number, l.lat as number]).addTo(map)

    map.on('style.load', () => { install(map); setStyled((n) => n + 1) })
    map.on('mousemove', 'bmg-pts', (e) => {
      const k = e.features?.[0]?.properties?.key
      if (!k) return
      map.getCanvas().style.cursor = 'pointer'
      setHovered(String(k))
      setHover({ key: String(k), from: 'map' })
    })
    map.on('mouseleave', 'bmg-pts', () => { map.getCanvas().style.cursor = ''; setHovered(null); setHover(null) })
    map.on('click', 'bmg-pts', (e) => {
      const k = e.features?.[0]?.properties?.key
      const p = k ? latest.current.model.points.find((x) => x.key === String(k)) : null
      if (p?.buyerId && !p.selected && latest.current.onSelectBuyer) latest.current.onSelectBuyer(p.buyerId)
    })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => map.resize()) : null
    ro?.observe(host.current)
    return () => { ro?.disconnect(); map.remove(); mapRef.current = null }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the map is created once; theme/data effects below update it
  }, [located])

  function install(map: maplibregl.Map) {
    const l = latest.current
    if (l.lat === null || l.lng === null) return
    const light = l.theme === 'light'
    map.addSource('bmg-rings', { type: 'geojson', data: ringFeatures(l.lat, l.lng, l.R) })
    map.addSource('bmg-ring-labels', { type: 'geojson', data: ringLabelFeatures(l.lat, l.lng, l.R) })
    map.addSource('bmg-pts', { type: 'geojson', data: pointCollection(l.model.points, l.anySelected), promoteId: 'key' })
    map.addLayer({ id: 'bmg-ring', type: 'line', source: 'bmg-rings', filter: ['==', ['get', 'kind'], 'ring'], paint: { 'line-color': light ? 'rgba(11,18,32,0.28)' : 'rgba(255,255,255,0.22)', 'line-width': 1, 'line-dasharray': [2, 3] } })
    map.addLayer({ id: 'bmg-search', type: 'line', source: 'bmg-rings', filter: ['==', ['get', 'kind'], 'search'], paint: { 'line-color': '#5eead4', 'line-width': 1.6, 'line-opacity': 0.85 } })
    map.addLayer({
      id: 'bmg-ring-label', type: 'symbol', source: 'bmg-ring-labels',
      layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-font': ['Open Sans Regular'], 'text-offset': [0, -0.6] },
      paint: { 'text-color': light ? '#334155' : '#cbd5e1', 'text-halo-color': light ? 'rgba(255,255,255,0.9)' : 'rgba(4,6,11,0.85)', 'text-halo-width': 1.2 },
    })
    map.addLayer({
      id: 'bmg-pts-halo', type: 'circle', source: 'bmg-pts',
      paint: {
        'circle-color': ['get', 'color'],
        'circle-radius': ['case', ['boolean', ['feature-state', 'hover'], false], 15, ['==', ['get', 'sel'], 1], 10, 0],
        'circle-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.35, 0.18],
        'circle-blur': 0.6,
      },
    })
    map.addLayer({
      id: 'bmg-pts', type: 'circle', source: 'bmg-pts',
      paint: {
        'circle-color': ['get', 'color'],
        'circle-radius': ['case', ['boolean', ['feature-state', 'hover'], false], 8, ['==', ['get', 'sel'], 1], 6.5, 4.5],
        'circle-opacity': ['case', ['==', ['get', 'dim'], 1], 0.55, 0.95],
        'circle-stroke-color': light ? 'rgba(255,255,255,0.95)' : 'rgba(4,6,11,0.9)',
        'circle-stroke-width': ['case', ['==', ['get', 'held'], 1], 2.5, ['==', ['get', 'sel'], 1], 1.6, 1],
      },
    })
  }

  // theme: same map, new style (layers reinstall on style.load)
  const themeRef = useRef(theme)
  useEffect(() => {
    const map = mapRef.current
    if (!map || themeRef.current === theme) return
    themeRef.current = theme
    map.setStyle(styleFor(theme, false))
  }, [theme])

  // data
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const src = map.getSource('bmg-pts') as GeoJSONSource | undefined
    src?.setData(pointCollection(model.points, anySelected))
    if (hoveredRef.current && !byKey.has(hoveredRef.current)) { hoveredRef.current = null; setHover(null) }
  }, [model.points, anySelected, byKey, styled])

  // radius: rings + camera
  useEffect(() => {
    const map = mapRef.current
    if (!map || s.lat === null || s.lng === null) return
    ;(map.getSource('bmg-rings') as GeoJSONSource | undefined)?.setData(ringFeatures(s.lat, s.lng, w.query.radiusMiles))
    ;(map.getSource('bmg-ring-labels') as GeoJSONSource | undefined)?.setData(ringLabelFeatures(s.lat, s.lng, w.query.radiusMiles))
    map.fitBounds(radiusBounds(s.lat, s.lng, w.query.radiusMiles * 1.08), { padding: 24, duration: 0 })
  }, [s.lat, s.lng, w.query.radiusMiles, styled])

  // hover card position follows the point (and the camera)
  useEffect(() => {
    const map = mapRef.current
    const p = hover ? byKey.get(hover.key) : null
    if (!map || !p) { setPos(null); return }
    const place = () => { const pt = map.project([p.lng, p.lat]); setPos({ x: pt.x, y: pt.y }) }
    place()
    map.on('move', place)
    return () => { map.off('move', place) }
  }, [hover, byKey])

  // map hover → list row into view
  useEffect(() => {
    if (hover?.from !== 'map') return
    listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(hover.key)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [hover])

  if (!located) return <figure className="bmc-vis is-geo"><p className="bmc-vis__none">The subject has no coordinates, so there is no map to draw.</p></figure>

  const hot = hover ? byKey.get(hover.key) ?? null : null
  const flyTo = (p: GeoPoint) => mapRef.current?.easeTo({ center: [p.lng, p.lat], zoom: Math.max(mapRef.current.getZoom(), 14), duration: 450 })
  const shown = rows.slice(0, LIST_MAX)

  return (
    <figure className="bmc-vis is-geo bmg">
      <div className="bmg-stage">
        <div className="bmg-map" ref={host} role="region" aria-label={`Map: ${model.points.length} recorded purchases within ${w.query.radiusMiles} mi of the subject`} />
        <div className="bmg-legend" aria-label="Buyers on the map">
          <span className="bmg-legend__head">{model.source === 'window' ? 'Purchases by buyer' : 'Selected buyer'}</span>
          <ul>
            {model.legend.map((r) => (
              <li key={r.key} className={cls(r.selected && 'is-sel')}>
                <button type="button" disabled={!r.buyerId || r.selected || !onSelectBuyer} onClick={() => r.buyerId && onSelectBuyer?.(r.buyerId)} title={r.buyerId && !r.selected ? 'Select this buyer' : undefined}>
                  <i style={{ background: r.color }} className={cls(r.key === 'held' && 'is-held')} />
                  <span>{r.label}</span>
                  <b>{r.count}</b>
                </button>
              </li>
            ))}
            <li className="bmg-legend__subject"><i /><span>Subject</span></li>
            <li className="bmg-legend__radius"><i /><span>{w.query.radiusMiles} mi radius</span></li>
          </ul>
        </div>
        {hot && pos ? (
          <div className={cls('bmg-pop', pos.y < 120 && 'is-below')} style={{ left: pos.x, top: pos.y }} role="tooltip">
            <span className="bmg-pop__k"><i style={{ background: hot.color }} />{hot.buyerLabel}</span>
            <b>{street(hot.address) ?? (hot.kind === 'holding' ? 'Property on record' : 'Recorded purchase')}</b>
            <span>{[hot.kind === 'holding' ? 'Holding' : fmtDate(hot.date) ?? 'Undated', priceText(hot)].join(' · ')}</span>
            <span className="is-quiet">{[hot.family, hot.sameFamily === true ? 'same type' : hot.sameFamily === false ? 'other type' : null, mi(hot.miles) ? `${mi(hot.miles)} from subject` : null].filter(Boolean).join(' · ')}</span>
          </div>
        ) : null}
        {!model.points.length ? <p className="bmg-empty">{loading ? 'Loading purchases…' : `No located purchase within ${w.query.radiusMiles} mi in this read.`}</p> : null}
      </div>
      <div className="bmg-list">
        <div className="bmg-list__head">
          <span>{model.points.length} on map</span>
          <em>{[model.truncated && model.total !== null ? `${model.total} in window, nearest loaded` : null, model.outside ? `${model.outside} outside radius / unlisted buyer` : null].filter(Boolean).join(' · ')}</em>
        </div>
        <ol ref={listRef} onMouseLeave={() => { setHovered(null); setHover(null) }}>
          {shown.map((p) => (
            <li key={p.key} data-key={p.key}>
              <button
                type="button"
                className={cls('bmg-row', p.selected && 'is-sel', hover?.key === p.key && 'is-hot')}
                onMouseEnter={() => { setHovered(p.key); setHover({ key: p.key, from: 'list' }) }}
                onFocus={() => { setHovered(p.key); setHover({ key: p.key, from: 'list' }) }}
                onClick={() => flyTo(p)}
              >
                <i style={{ background: p.color }} />
                <span className="bmg-row__t">{street(p.address) ?? (p.kind === 'holding' ? 'Holding' : 'Recorded purchase')}<em>{p.buyerLabel}</em></span>
                <span className="bmg-row__n">{p.kind === 'holding' ? 'held' : p.price ? (p.nominal ? 'nominal' : money(p.price)) : '—'}<em>{[fmtDate(p.date)?.replace(/, \d{4}$/, ''), mi(p.miles)].filter(Boolean).join(' · ')}</em></span>
              </button>
            </li>
          ))}
        </ol>
        {rows.length > LIST_MAX ? <p className="bmg-list__more">+{rows.length - LIST_MAX} more on the map</p> : null}
      </div>
    </figure>
  )
}
