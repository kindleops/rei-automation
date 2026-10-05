/**
 * Pointer wiring for one context-overlay layer: a press picks, hover only
 * changes the cursor. Nothing here fetches — a hover must never cost a
 * request (owner rule; Street View fan-out lesson). The caller's `onPick`
 * runs on click only, and only the picked camera's detail is ever read.
 */
import type maplibregl from 'maplibre-gl'

type PointerMap = Pick<maplibregl.Map, 'on' | 'off' | 'getCanvas'>

export function bindOverlayPointer(map: PointerMap, layer: string, onPick: (f: maplibregl.MapGeoJSONFeature) => void): () => void {
  const click = (e: maplibregl.MapLayerMouseEvent) => { const f = e.features?.[0]; if (f) onPick(f) }
  const enter = () => { map.getCanvas().style.cursor = 'pointer' }
  const leave = () => { map.getCanvas().style.cursor = '' }
  map.on('click', layer, click)
  map.on('mouseenter', layer, enter)
  map.on('mouseleave', layer, leave)
  return () => { map.off('click', layer, click); map.off('mouseenter', layer, enter); map.off('mouseleave', layer, leave) }
}
