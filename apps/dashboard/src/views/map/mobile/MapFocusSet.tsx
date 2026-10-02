/**
 * Lights and frames a set handed over by another app (Entity Graph selection,
 * a buyer's portfolio), with a glass chip to clear it. Read-only overlay.
 */
import { useEffect, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import { clearMapFocusSet, MAP_FOCUS_SET_EVENT, readMapFocusSet, type MapFocusSet as FocusSet } from '../../../domain/map/map-focus-set'
import { mapOverlayTarget } from '../map-overlay-host'
import { boundsOf, createAutoFramer, planSetFocus } from '../focus/focus-camera'

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

  // Frame the set once when it arrives — the bounds of EVERY point (never the
  // first pin), 500–900 ms by distance, and the operator's first drag / wheel /
  // pinch stops it (8.2 §3). Reduced motion jumps.
  useEffect(() => {
    if (!map || !set?.points.length) return
    const framer = createAutoFramer(map as unknown as Parameters<typeof createAutoFramer>[0])
    let grabbed = false
    const grab = (e: { originalEvent?: unknown }) => { if (e?.originalEvent) grabbed = true }
    map.on('movestart', grab)
    const t = window.setTimeout(() => {
      if (grabbed) return
      try {
        const box = map.getContainer()
        const width = box.clientWidth || 1, height = box.clientHeight || 1
        const b = boundsOf(set.points)
        let distancePx = Math.hypot(width, height) * 4
        if (b) {
          const p = map.project([(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2])
          if (Number.isFinite(p.x)) distancePx = Math.hypot(p.x - width / 2, p.y - height / 2)
        }
        const plan = planSetFocus({ points: set.points, fromZoom: map.getZoom(), distancePx, viewport: { width, height }, reducedMotion, maxZoom: 15, inset: { left: 40 } })
        if (plan) framer.run(plan, `set:${set.at}`)
      } catch { /* map not ready */ }
    }, 350)
    return () => { window.clearTimeout(t); map.off('movestart', grab); framer.dispose() }
  }, [map, set, reducedMotion])

  if (!set) return null
  return createPortal(
    <div className="mx-focusset" style={{ ['--tone' as string]: TONE[set.tone] }} role="status">
      <span className="mx-focusset__dot" aria-hidden="true" />
      <span className="mx-focusset__text"><b>{set.points.length.toLocaleString()}</b> {set.label}</span>
      <button type="button" className="mx-focusset__x" onClick={() => { clearMapFocusSet(); if (map) paint(map, null) }} aria-label="Clear highlighted set"><Icon name="close" /></button>
    </div>,
    mapOverlayTarget(),
  )
}
