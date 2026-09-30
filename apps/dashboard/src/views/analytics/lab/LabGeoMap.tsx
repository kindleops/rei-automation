/**
 * GEOGRAPHY MAP — MapLibre, canonical markets (or ZIPs) as circles.
 *
 *   rate metrics   colour = the rate (single-hue ramp); size = the denominator;
 *                  opacity = sample confidence (faded below the minimum n)
 *   count metrics  size = the count; one colour (a count is never shaded as intensity)
 *
 * Centroids are the mean of the group's own property coordinates (server).
 * Clicking a circle drills into it (breadcrumb); the linked ranked list
 * highlights the same group. Unresolved rows are counted beside the map.
 */
import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { BreakdownRow } from '../../../domain/analytics/analytics-lab-api'

const DARK = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
const LIGHT = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
const SRC = 'lab-geo'
const LAYER = 'lab-geo-circles'
const HALO = 'lab-geo-halo'

type Props = {
  rows: Array<BreakdownRow & { centroid?: { lat: number; lng: number; n: number } }>
  isRate: boolean
  minSample: number
  theme: string
  selected: string | null
  format: (v: number | null) => string
  onPick: (row: BreakdownRow) => void
}

export function LabGeoMap({ rows, isRate, minSample, theme, selected, format, onPick }: Props) {
  const host = useRef<HTMLDivElement | null>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const light = theme === 'light'
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const pickRef = useRef(onPick)
  pickRef.current = onPick

  useEffect(() => {
    if (!host.current) return
    let m: maplibregl.Map
    try {
      m = new maplibregl.Map({ container: host.current, style: light ? LIGHT : DARK, center: [-95.7, 37.5], zoom: 3.2, attributionControl: false, dragRotate: false, pitchWithRotate: false })
    } catch { setFailed(true); return }
    map.current = m
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
    const onLoad = () => setReady(true)
    m.on('load', onLoad)
    m.on('error', (e) => { if (/style|sprite|glyph/i.test(String((e as { error?: Error })?.error?.message || ''))) setFailed(true) })
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'lab-map-pop', offset: 10 })
    m.on('mousemove', LAYER, (e) => {
      const f = e.features?.[0]
      if (!f) return
      m.getCanvas().style.cursor = 'pointer'
      const p = f.properties as Record<string, string | number>
      const el = document.createElement('div')
      const b = document.createElement('b'); b.textContent = String(p.label)
      const v = document.createElement('span'); v.textContent = String(p.text)
      el.append(b, v)
      popup.setLngLat(e.lngLat).setDOMContent(el).addTo(m)
    })
    m.on('mouseleave', LAYER, () => { m.getCanvas().style.cursor = ''; popup.remove() })
    m.on('click', LAYER, (e) => {
      const key = String(e.features?.[0]?.properties?.key || '')
      const row = rowsRef.current.find((r) => r.key === key)
      if (row) pickRef.current(row)
    })
    return () => { popup.remove(); m.remove(); map.current = null; setReady(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // theme swap: setStyle drops custom layers; they are re-added on the next styledata
  useEffect(() => {
    const m = map.current
    if (!m) return
    setReady(false)
    m.setStyle(light ? LIGHT : DARK)
    const again = () => setReady(true)
    m.once('styledata', again)
  }, [light])

  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    const withGeo = rows.filter((r) => r.centroid && r.key !== '__unresolved')
    const maxDen = Math.max(1, ...withGeo.map((r) => (isRate ? r.den ?? 0 : r.value ?? 0)))
    const maxRate = Math.max(0.0001, ...withGeo.filter((r) => (r.den ?? 0) >= minSample).map((r) => r.value ?? 0))
    const fc = {
      type: 'FeatureCollection' as const,
      features: withGeo.map((r) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [r.centroid!.lng, r.centroid!.lat] },
        properties: {
          key: r.key, label: r.label,
          size: Math.sqrt((isRate ? r.den ?? 0 : r.value ?? 0) / maxDen),
          t: isRate ? Math.min(1, (r.value ?? 0) / maxRate) : 0.75,
          conf: isRate ? Math.min(1, (r.den ?? 0) / Math.max(1, minSample)) : 1,
          sel: selected === r.key ? 1 : 0,
          text: isRate ? `${format(r.value)} · ${r.num}/${r.den}${(r.den ?? 0) < minSample ? ' · small n' : ''}` : `${format(r.value)}`,
        },
      })),
    }
    const src = m.getSource(SRC) as maplibregl.GeoJSONSource | undefined
    if (src) src.setData(fc)
    else {
      m.addSource(SRC, { type: 'geojson', data: fc })
      const E = (x: unknown) => x as maplibregl.ExpressionSpecification
      m.addLayer({ id: HALO, type: 'circle', source: SRC, paint: { 'circle-radius': E(['+', ['*', ['get', 'size'], 26], 9]), 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': E(['case', ['==', ['get', 'sel'], 1], 2, 0]), 'circle-stroke-color': light ? '#17181b' : '#ffffff' } })
      m.addLayer({
        id: LAYER, type: 'circle', source: SRC,
        paint: {
          'circle-radius': E(['+', ['*', ['get', 'size'], 26], 5]),
          'circle-color': E(light
            ? ['interpolate', ['linear'], ['get', 't'], 0, '#b7d3f6', 0.5, '#3987e5', 1, '#104281']
            : ['interpolate', ['linear'], ['get', 't'], 0, '#1c3a5e', 0.5, '#3987e5', 1, '#cde2fb']),
          'circle-opacity': E(['interpolate', ['linear'], ['get', 'conf'], 0, 0.28, 1, 0.9]),
          'circle-stroke-width': 1,
          'circle-stroke-color': light ? 'rgba(255,255,255,0.9)' : 'rgba(10,11,13,0.9)',
        },
      })
    }
    if (withGeo.length) {
      const b = new maplibregl.LngLatBounds()
      for (const r of withGeo) b.extend([r.centroid!.lng, r.centroid!.lat])
      m.fitBounds(b, { padding: 56, maxZoom: withGeo.length === 1 ? 9 : 7, duration: 0 })
    }
  }, [rows, isRate, minSample, selected, ready, format, light])

  return (
    <div className="lab-map">
      <div ref={host} className="lab-map__canvas" role="img" aria-label="Map of the selected metric by canonical market" />
      {failed ? <p className="lab-note lab-map__failed">The basemap could not load; the ranked list beside it carries every value.</p> : null}
      <div className="lab-map__legend" aria-hidden="true">
        {isRate ? <><i className="is-ramp" /><span>low → high rate</span><i className="is-size" /><span>size = sellers reached</span><i className="is-faded" /><span>faded = n &lt; {minSample}</span></> : <><i className="is-size" /><span>size = count</span></>}
      </div>
    </div>
  )
}
