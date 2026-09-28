/**
 * EVIDENCE MAP — the subject, the operator's set, candidates and excluded
 * sales on the Map app's own cartography (Carto Dark Matter / Positron, Esri
 * imagery). GeoJSON layers, not per-comp DOM markers, so a dense market stays
 * smooth. Focus never yanks the camera: it only eases when the focused comp is
 * off-screen, so the operator keeps their orientation.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { EvidenceComp } from '../../../domain/comp-intelligence/comps-evidence-api'
import { money } from '../../../domain/comp-intelligence/comps-evidence-api'
import { CARTO_VECTOR_DARK_STYLE_URL, CARTO_VECTOR_LIGHT_STYLE_URL } from '../../map/map-visual-presets'

type Props = {
  subject: { lat: number | null; lng: number | null; address: string | null }
  comps: EvidenceComp[]
  inSet: Set<string>
  focusKey: string | null
  onFocus: (key: string) => void
  radiusMiles: number
  imagery: boolean
  theme: string
  tilt: boolean
}

const SATELLITE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  glyphs: 'https://tiles.basemaps.cartocdn.com/fonts/{fontstack}/{range}.pbf',
  sources: { sat: { type: 'raster', tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, attribution: 'Esri, Maxar, Earthstar Geographics' } },
  layers: [{ id: 'sat', type: 'raster', source: 'sat' }],
}

function circle(lat: number, lng: number, miles: number, steps = 72) {
  const coords: [number, number][] = []
  const dLat = miles / 69
  const dLng = miles / (69 * Math.cos((lat * Math.PI) / 180))
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2
    coords.push([lng + dLng * Math.cos(t), lat + dLat * Math.sin(t)])
  }
  return { type: 'Feature' as const, geometry: { type: 'Polygon' as const, coordinates: [coords] }, properties: {} }
}

export function CompsEvidenceMap({ subject, comps, inSet, focusKey, onFocus, radiusMiles, imagery, theme, tilt }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const subjectMarker = useRef<maplibregl.Marker | null>(null)
  const [ready, setReady] = useState(0)
  const onFocusRef = useRef(onFocus)
  onFocusRef.current = onFocus
  const fittedFor = useRef<string | null>(null)
  const light = theme === 'light'
  const styleUrl = imagery ? SATELLITE_STYLE : light ? CARTO_VECTOR_LIGHT_STYLE_URL : CARTO_VECTOR_DARK_STYLE_URL

  const data = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: comps.filter((c) => c.lat !== null && c.lng !== null).map((c) => ({
      type: 'Feature' as const,
      id: c.key,
      geometry: { type: 'Point' as const, coordinates: [c.lng as number, c.lat as number] },
      properties: {
        key: c.key,
        tier: inSet.has(c.key) ? 'set' : c.state === 'excluded' ? 'excluded' : 'candidate',
        system: c.state === 'system' ? 1 : 0,
        focus: c.key === focusKey ? 1 : 0,
        label: money(c.salePrice) ?? '',
      },
    })),
  }), [comps, inSet, focusKey])

  // Evidence lines: subject → every comp in the operator's set.
  const links = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: subject.lat === null || subject.lng === null ? [] : comps
      .filter((c) => inSet.has(c.key) && c.lat !== null && c.lng !== null)
      .map((c) => ({ type: 'Feature' as const, properties: { focus: c.key === focusKey ? 1 : 0 }, geometry: { type: 'LineString' as const, coordinates: [[subject.lng as number, subject.lat as number], [c.lng as number, c.lat as number]] } })),
  }), [comps, inSet, focusKey, subject.lat, subject.lng])

  // Create the map once.
  useEffect(() => {
    if (!hostRef.current || mapRef.current) return
    const map = new maplibregl.Map({
      container: hostRef.current,
      style: styleUrl,
      center: [subject.lng ?? -96, subject.lat ?? 37],
      zoom: subject.lat !== null ? 13 : 3,
      attributionControl: false,
      pitchWithRotate: false,
      dragRotate: false,
      maxPitch: 60,
    })
    map.touchZoomRotate.disableRotation()
    mapRef.current = map
    map.on('style.load', () => setReady((n) => n + 1))
    return () => { map.remove(); mapRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- created once; style changes handled below
  }, [])

  // Swap cartography with theme / imagery; data layers are re-added on style.load.
  const lastStyle = useRef(styleUrl)
  useEffect(() => {
    const map = mapRef.current
    if (!map || lastStyle.current === styleUrl) return
    lastStyle.current = styleUrl
    map.setStyle(styleUrl as string | maplibregl.StyleSpecification)
  }, [styleUrl])

  // Layers (re)installed whenever a style finishes loading.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const accent = getComputedStyle(hostRef.current as Element).getPropertyValue('--cev-set').trim() || '#38d0f0'
    const cand = getComputedStyle(hostRef.current as Element).getPropertyValue('--cev-cand').trim() || '#9fb2cc'
    const excl = getComputedStyle(hostRef.current as Element).getPropertyValue('--cev-excl').trim() || '#6b7485'
    if (!map.getSource('cev-radius') && subject.lat !== null && subject.lng !== null) {
      map.addSource('cev-radius', { type: 'geojson', data: circle(subject.lat, subject.lng, radiusMiles) })
      map.addLayer({ id: 'cev-radius-fill', type: 'fill', source: 'cev-radius', paint: { 'fill-color': accent, 'fill-opacity': 0.05 } })
      map.addLayer({ id: 'cev-radius-line', type: 'line', source: 'cev-radius', paint: { 'line-color': accent, 'line-opacity': 0.45, 'line-width': 1.2, 'line-dasharray': [2, 2] } })
    }
    if (!imagery && map.getSource('carto') && !map.getLayer('cev-3d')) {
      map.addLayer({
        id: 'cev-3d', type: 'fill-extrusion', source: 'carto', 'source-layer': 'building', minzoom: 13,
        paint: {
          'fill-extrusion-color': light ? '#d9e1ec' : '#1b2436',
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], ['get', 'height'], 9],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': light ? 0.7 : 0.85,
        },
      })
    }
    if (!map.getSource('cev-links')) {
      map.addSource('cev-links', { type: 'geojson', data: links, lineMetrics: true })
      map.addLayer({ id: 'cev-links-glow', type: 'line', source: 'cev-links', layout: { 'line-cap': 'round' }, paint: { 'line-color': accent, 'line-width': ['case', ['==', ['get', 'focus'], 1], 9, 5], 'line-opacity': 0.16, 'line-blur': 4 } })
      map.addLayer({
        id: 'cev-links', type: 'line', source: 'cev-links', layout: { 'line-cap': 'round' },
        paint: { 'line-width': ['case', ['==', ['get', 'focus'], 1], 2.6, 1.4], 'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, '#f5c65a', 1, accent], 'line-opacity': 0.9 },
      })
      map.addLayer({ id: 'cev-links-flow', type: 'line', source: 'cev-links', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 1.4, 'line-opacity': 0.55, 'line-dasharray': [0, 4, 3] } })
    }
    if (!map.getSource('cev-comps')) {
      map.addSource('cev-comps', { type: 'geojson', data, promoteId: 'key' })
      map.addLayer({
        id: 'cev-excluded', type: 'circle', source: 'cev-comps', filter: ['==', ['get', 'tier'], 'excluded'],
        paint: { 'circle-radius': 4, 'circle-color': 'transparent', 'circle-stroke-color': excl, 'circle-stroke-width': 1.2, 'circle-stroke-opacity': 0.6 },
      })
      map.addLayer({
        id: 'cev-candidate', type: 'circle', source: 'cev-comps', filter: ['==', ['get', 'tier'], 'candidate'],
        paint: { 'circle-radius': ['case', ['==', ['get', 'focus'], 1], 8, 5], 'circle-color': cand, 'circle-opacity': 0.75, 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1.2 },
      })
      map.addLayer({
        id: 'cev-set-glow', type: 'circle', source: 'cev-comps', filter: ['==', ['get', 'tier'], 'set'],
        paint: { 'circle-radius': ['case', ['==', ['get', 'focus'], 1], 22, 13], 'circle-color': accent, 'circle-opacity': 0.18, 'circle-blur': 0.8 },
      })
      map.addLayer({
        id: 'cev-set', type: 'circle', source: 'cev-comps', filter: ['==', ['get', 'tier'], 'set'],
        paint: { 'circle-radius': ['case', ['==', ['get', 'focus'], 1], 9, 6.5], 'circle-color': accent, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': ['case', ['==', ['get', 'focus'], 1], 2.5, 1.5] },
      })
      map.addLayer({
        id: 'cev-set-label', type: 'symbol', source: 'cev-comps', filter: ['==', ['get', 'tier'], 'set'],
        layout: { 'text-field': ['get', 'label'], 'text-size': ['case', ['==', ['get', 'focus'], 1], 13, 11], 'text-offset': [0, -1.5], 'text-font': ['Open Sans Bold'], 'text-allow-overlap': false },
        paint: { 'text-color': light && !imagery ? '#0b1220' : '#ffffff', 'text-halo-color': light && !imagery ? 'rgba(255,255,255,0.9)' : 'rgba(4,6,11,0.85)', 'text-halo-width': 1.4 },
      })
      for (const id of ['cev-set', 'cev-candidate', 'cev-excluded']) {
        map.on('click', id, (e) => { const k = e.features?.[0]?.properties?.key; if (k) onFocusRef.current(String(k)) })
        map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer' })
        map.on('mouseleave', id, () => { map.getCanvas().style.cursor = '' })
      }
    }
    if (subject.lat !== null && subject.lng !== null) {
      subjectMarker.current?.remove()
      const el = document.createElement('div')
      el.className = 'cev-subject-pin'
      el.innerHTML = '<span class="cev-subject-pin__halo"></span><span class="cev-subject-pin__core">★</span>'
      subjectMarker.current = new maplibregl.Marker({ element: el }).setLngLat([subject.lng, subject.lat]).addTo(map)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- installs once per loaded style
  }, [ready])

  // Data updates (selection / focus) without touching the camera.
  useEffect(() => {
    const src = mapRef.current?.getSource('cev-comps') as maplibregl.GeoJSONSource | undefined
    src?.setData(data)
  }, [data, ready])

  useEffect(() => {
    const src = mapRef.current?.getSource('cev-links') as maplibregl.GeoJSONSource | undefined
    src?.setData(links)
  }, [links, ready])

  // A light travelling along each evidence line (off under reduced motion).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const seq: number[][] = [[0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0], [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5]]
    let i = 0
    const t = window.setInterval(() => {
      if (!map.getLayer('cev-links-flow')) return
      i = (i + 1) % seq.length
      map.setPaintProperty('cev-links-flow', 'line-dasharray', seq[i])
    }, 90)
    return () => window.clearInterval(t)
  }, [ready])

  // 3D ↔ 2D.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    map.easeTo({ pitch: tilt ? 52 : 0, bearing: tilt ? -14 : 0, duration: 900 })
  }, [tilt, ready])

  // Radius ring follows the query.
  useEffect(() => {
    const src = mapRef.current?.getSource('cev-radius') as maplibregl.GeoJSONSource | undefined
    if (src && subject.lat !== null && subject.lng !== null) src.setData(circle(subject.lat, subject.lng, radiusMiles))
  }, [radiusMiles, subject.lat, subject.lng, ready])

  // Fit once per subject+radius: subject + the operator's set.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || subject.lat === null || subject.lng === null) return
    const sig = `${subject.lat},${subject.lng},${radiusMiles}`
    if (fittedFor.current === sig) return
    fittedFor.current = sig
    const b = new maplibregl.LngLatBounds([subject.lng, subject.lat], [subject.lng, subject.lat])
    for (const c of comps) if (inSet.has(c.key) && c.lat !== null && c.lng !== null) b.extend([c.lng, c.lat])
    const dLat = radiusMiles / 69
    b.extend([subject.lng, subject.lat - dLat * 0.35]).extend([subject.lng, subject.lat + dLat * 0.35])
    map.fitBounds(b, { padding: { top: 50, bottom: 50, left: 30, right: 30 }, maxZoom: 15, duration: 0 })
    if (tilt) map.easeTo({ pitch: 52, bearing: -14, duration: 1200 })
  }, [ready, comps, inSet, radiusMiles, subject.lat, subject.lng])

  // Gentle focus: ease only if the focused comp is off-screen.
  useEffect(() => {
    const map = mapRef.current
    const c = comps.find((x) => x.key === focusKey)
    if (!map || !c || c.lat === null || c.lng === null) return
    if (!map.getBounds().contains([c.lng, c.lat])) map.easeTo({ center: [c.lng, c.lat], duration: 650 })
  }, [focusKey, comps])

  const recenter = () => {
    const map = mapRef.current
    if (!map || subject.lat === null || subject.lng === null) return
    fittedFor.current = null
    map.easeTo({ center: [subject.lng, subject.lat], zoom: 14, pitch: tilt ? 52 : 0, bearing: tilt ? -14 : 0, duration: 800 })
  }

  return (
    <div className="cev-map">
      <div ref={hostRef} className="cev-map__canvas" />
      <button type="button" className="cev-map__recenter" onClick={recenter} aria-label="Recenter on subject">◎</button>
      <div className="cev-map__legend" aria-hidden="true">
        <span><i className="k-subject" />Subject</span>
        <span><i className="k-set" />Your set</span>
        <span><i className="k-cand" />Candidate</span>
        <span><i className="k-excl" />Excluded</span>
      </div>
    </div>
  )
}
