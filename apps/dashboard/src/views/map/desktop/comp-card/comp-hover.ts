/**
 * Sold-comp HOVER on the desktop Map — zero network.
 *
 * The comp layer (useSoldComps → nx-comps-point / nx-comps-cluster) had click
 * handlers only, so hovering a comp did nothing. This listens to the layer's
 * own mousemove / mouseleave, debounces (a pointer sweeping across a dense
 * block never paints a dozen previews) and reports the feature's properties +
 * its anchored screen point. It never fetches: the preview renders from what
 * the feature already carries (comp-card-model.hoverPreviewFromFeature).
 */
import { useEffect, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { COMP_LAYERS } from '../../mobile/useSoldComps'
import type { CompFeatureProps } from './comp-card-model'

export interface CompHoverState {
  key: string
  props: CompFeatureProps
  lngLat: [number, number]
  /** the pin's point in map-container pixels */
  point: { x: number; y: number }
}

type LayerEvent = maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }

/** The slice of maplibregl.Map this needs (a fake map drives the tests). */
export interface HoverMap {
  on(type: string, layer: string, fn: (e: LayerEvent) => void): unknown
  off(type: string, layer: string, fn: (e: LayerEvent) => void): unknown
  on(type: string, fn: () => void): unknown
  off(type: string, fn: () => void): unknown
  project(lngLat: [number, number]): { x: number; y: number }
  getCanvas(): { style: { cursor: string } }
}

export const COMP_HOVER_LAYERS = [COMP_LAYERS.point, COMP_LAYERS.cluster] as const
export const COMP_HOVER_DELAY_MS = 90
export const COMP_HOVER_LEAVE_MS = 70

export function compHoverKey(props: CompFeatureProps, lngLat: readonly [number, number]): string {
  return props.comp_id ? String(props.comp_id) : `cluster:${lngLat[0].toFixed(5)},${lngLat[1].toFixed(5)}`
}

/** Wire hover onto the comp layers; returns the detach. Pure event plumbing — no I/O. */
export function attachCompHover(
  map: HoverMap,
  onChange: (s: CompHoverState | null) => void,
  opts: { delay?: number; leave?: number; layers?: readonly string[] } = {},
): () => void {
  const delay = opts.delay ?? COMP_HOVER_DELAY_MS
  const leave = opts.leave ?? COMP_HOVER_LEAVE_MS
  const layers = opts.layers ?? COMP_HOVER_LAYERS
  let enterTimer: ReturnType<typeof setTimeout> | null = null
  let leaveTimer: ReturnType<typeof setTimeout> | null = null
  let pendingKey: string | null = null
  let shownKey: string | null = null
  const clear = (t: ReturnType<typeof setTimeout> | null) => { if (t) clearTimeout(t) }

  const onMove = (e: LayerEvent) => {
    const f = e.features?.[0]
    const g = f?.geometry as { type?: string; coordinates?: [number, number] } | undefined
    if (!f || g?.type !== 'Point' || !g.coordinates) return
    const props = (f.properties ?? {}) as CompFeatureProps
    const lngLat: [number, number] = [Number(g.coordinates[0]), Number(g.coordinates[1])]
    const key = compHoverKey(props, lngLat)
    try { map.getCanvas().style.cursor = 'pointer' } catch { /* canvas gone */ }
    clear(leaveTimer); leaveTimer = null
    if (key === shownKey || key === pendingKey) return
    clear(enterTimer)
    pendingKey = key
    enterTimer = setTimeout(() => {
      enterTimer = null
      pendingKey = null
      let point = { x: 0, y: 0 }
      try { point = map.project(lngLat) } catch { return }
      shownKey = key
      onChange({ key, props: { ...props }, lngLat, point })
    }, delay)
  }
  const onLeave = () => {
    try { map.getCanvas().style.cursor = '' } catch { /* canvas gone */ }
    clear(enterTimer); enterTimer = null; pendingKey = null
    clear(leaveTimer)
    leaveTimer = setTimeout(() => { leaveTimer = null; shownKey = null; onChange(null) }, leave)
  }
  // The camera moving under a preview detaches it from its pin: hide it.
  const onCamera = () => {
    clear(enterTimer); enterTimer = null; pendingKey = null
    if (shownKey !== null) { shownKey = null; onChange(null) }
  }

  for (const l of layers) { map.on('mousemove', l, onMove); map.on('mouseleave', l, onLeave) }
  map.on('movestart', onCamera)
  return () => {
    clear(enterTimer); clear(leaveTimer)
    for (const l of layers) { map.off('mousemove', l, onMove); map.off('mouseleave', l, onLeave) }
    map.off('movestart', onCamera)
  }
}

/** React binding: the current hover (desktop only — pass enabled=false on a phone). */
export function useCompHover(map: maplibregl.Map | null, epoch: number, enabled: boolean): CompHoverState | null {
  const [hover, setHover] = useState<CompHoverState | null>(null)
  useEffect(() => {
    if (!map || !enabled) return
    const detach = attachCompHover(map as unknown as HoverMap, setHover)
    return () => { detach(); setHover(null) }
  }, [map, epoch, enabled])
  return enabled ? hover : null
}
