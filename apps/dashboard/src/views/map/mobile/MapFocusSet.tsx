/**
 * Lights and frames a set handed over by another app (Entity Graph selection,
 * a buyer's portfolio), with a glass chip to clear it. Read-only overlay.
 */
import { useEffect, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import { clearMapFocusSet, MAP_FOCUS_SET_EVENT, readMapFocusSet, type MapFocusSet as FocusSet } from '../../../domain/map/map-focus-set'

const SRC = 'nx-focus-set'
const TONE: Record<FocusSet['tone'], string> = { property: '#5ee7ff', buyer: '#34e8c4', portfolio: '#f7c75b' }

function paint(map: maplibregl.Map, set: FocusSet | null) {
  try {
    const color = set ? TONE[set.tone] : '#5ee7ff'
    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addLayer({ id: `${SRC}-halo`, type: 'circle', source: SRC, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 6, 14, 22], 'circle-color': color, 'circle-blur': 1, 'circle-opacity': 0.45 } })
      map.addLayer({ id: `${SRC}-dot`, type: 'circle', source: SRC, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2.5, 14, 6.5], 'circle-color': color, 'circle-stroke-color': '#04060b', 'circle-stroke-width': 1.2 } })
    } else {
      map.setPaintProperty(`${SRC}-halo`, 'circle-color', color)
      map.setPaintProperty(`${SRC}-dot`, 'circle-color', color)
    }
    const src = map.getSource(SRC) as maplibregl.GeoJSONSource
    src.setData({
      type: 'FeatureCollection',
      features: (set?.points ?? []).map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { id: p.id ?? '' } })),
    })
  } catch { /* style mid-swap; the epoch effect repaints */ }
}

export function MapFocusSet({ map, mapEpoch, reducedMotion }: { map: maplibregl.Map | null; mapEpoch: number; reducedMotion: boolean }) {
  const [set, setSet] = useState<FocusSet | null>(() => readMapFocusSet())

  useEffect(() => {
    const onChange = () => setSet(readMapFocusSet())
    window.addEventListener(MAP_FOCUS_SET_EVENT, onChange)
    return () => window.removeEventListener(MAP_FOCUS_SET_EVENT, onChange)
  }, [])

  // Paint on every style epoch (a theme swap drops custom layers).
  useEffect(() => {
    if (!map) return
    paint(map, set)
  }, [map, mapEpoch, set])

  // Frame the set once when it arrives.
  useEffect(() => {
    if (!map || !set?.points.length) return
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
    for (const p of set.points) { w = Math.min(w, p.lng); e = Math.max(e, p.lng); s = Math.min(s, p.lat); n = Math.max(n, p.lat) }
    if (!Number.isFinite(w)) return
    const t = window.setTimeout(() => {
      try {
        if (set.points.length === 1) map.easeTo({ center: [w, s], zoom: 16, duration: reducedMotion ? 0 : 900 })
        else map.fitBounds([[w, s], [e, n]], { padding: { top: 150, bottom: 220, left: 40, right: 60 }, maxZoom: 15, duration: reducedMotion ? 0 : 1100 })
      } catch { /* map not ready */ }
    }, 350)
    return () => window.clearTimeout(t)
  }, [map, set, reducedMotion])

  if (!set) return null
  return createPortal(
    <div className="mx-focusset" style={{ ['--tone' as string]: TONE[set.tone] }} role="status">
      <span className="mx-focusset__dot" aria-hidden="true" />
      <span className="mx-focusset__text"><b>{set.points.length.toLocaleString()}</b> {set.label}</span>
      <button type="button" className="mx-focusset__x" onClick={() => { clearMapFocusSet(); if (map) paint(map, null) }} aria-label="Clear highlighted set"><Icon name="close" /></button>
    </div>,
    document.body,
  )
}
