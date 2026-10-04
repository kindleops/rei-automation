import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl, { type GeoJSONSource, type Map as MlMap, type StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { LCIconButton, useLcReducedMotion } from '../../../shared/lc'
import type { SearchModel } from '../domain/model'
import { coverageGaps, geoCoverage } from '../domain/geography'
import { BLACK_MARBLE, CARTO_DARK, GLOBE_HOME, STATES_URL, US_FRAME, ZOOM_FOR, cssVar, territoryFeatures } from './globe-model'

/**
 * The planning globe. Everything it lights is a PLAN: a place glows because
 * pages are planned for it, and brightens as those pages reach READY. There
 * is no traffic on this globe and no live dot — live modes are rendered by
 * the parent as honest unavailable states until a provider reports.
 *
 * Earth: NASA GIBS VIIRS Black Marble (city lights, keyless public tiles)
 * over CARTO dark (no labels), desaturated. Atmosphere via the v5 sky spec.
 * Camera moves only on intent (scope change, selection) — never idly.
 */

export interface GlobeProps {
  model: SearchModel
  scope: string | null
  selectedGeo: string | null
  onSelectGeo: (id: string) => void
  /** dims the territory when a live mode is shown over it */
  dimmed?: boolean
  label: string
}

function hasWebGL(): boolean {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    return false
  }
}

export function Globe({ model, scope, selectedGeo, onSelectGeo, dimmed, label }: GlobeProps) {
  const host = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MlMap | null>(null)
  const [failed, setFailed] = useState<string | null>(() => (hasWebGL() ? null : 'WebGL is unavailable'))
  const [ready, setReady] = useState(false)
  const [hover, setHover] = useState<{ x: number; y: number; id: string } | null>(null)
  const reduced = useLcReducedMotion()
  const reducedRef = useRef(reduced)
  useEffect(() => { reducedRef.current = reduced }, [reduced])
  const onSelectRef = useRef(onSelectGeo)
  useEffect(() => { onSelectRef.current = onSelectGeo }, [onSelectGeo])

  const cov = useMemo(() => geoCoverage(model, scope), [model, scope])
  const gapStates = useMemo(() => new Set(coverageGaps(model, scope).flatMap((g) => (g.kind === 'GEO_WITHOUT_PAGE' ? [model.geo.get(g.geographyId)?.code ?? ''] : []))), [model, scope])

  // mount once
  useEffect(() => {
    const el = host.current
    if (!el || !hasWebGL()) return
    const exec = cssVar(el, '--lc-exec', '#5ab8ff')
    const ok = cssVar(el, '--lc-ok', '#5fd39b')
    const ink = cssVar(el, '--lc-ink-1', '#eef2f8')
    const style: StyleSpecification = {
      version: 8,
      projection: { type: 'globe' },
      sources: {
        carto: { type: 'raster', tiles: CARTO_DARK, tileSize: 256, maxzoom: 18, attribution: '© OpenStreetMap contributors © CARTO' },
        lights: { type: 'raster', tiles: [BLACK_MARBLE], tileSize: 256, maxzoom: 8, attribution: 'NASA Earth Observatory / GIBS — VIIRS Black Marble' },
        states: { type: 'geojson', data: STATES_URL, promoteId: 'abbr' },
        territory: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      },
      sky: {
        'sky-color': '#03060c',
        'horizon-color': '#0d2238',
        'fog-color': '#071424',
        'sky-horizon-blend': 0.55,
        'horizon-fog-blend': 0.7,
        'fog-ground-blend': 0.45,
        'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0],
      },
      layers: [
        { id: 'space', type: 'background', paint: { 'background-color': '#010205' } },
        { id: 'carto', type: 'raster', source: 'carto', paint: { 'raster-saturation': -1, 'raster-opacity': 0.55, 'raster-brightness-max': 0.5, 'raster-contrast': 0.1 } },
        { id: 'lights', type: 'raster', source: 'lights', paint: { 'raster-opacity': ['interpolate', ['linear'], ['zoom'], 1, 0.95, 6, 0.55, 9, 0.2], 'raster-saturation': -0.35, 'raster-hue-rotate': 0, 'raster-contrast': 0.15 } },
        {
          id: 'states-fill', type: 'fill', source: 'states',
          paint: {
            'fill-color': exec,
            'fill-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.22, ['>', ['coalesce', ['feature-state', 'planned'], 0], 0], ['+', 0.05, ['*', 0.16, ['coalesce', ['feature-state', 'completion'], 0]]], 0],
          },
        },
        {
          id: 'states-gap', type: 'line', source: 'states',
          filter: ['==', ['get', 'abbr'], '__none__'],
          paint: { 'line-color': ink, 'line-opacity': 0.32, 'line-width': 0.8, 'line-dasharray': [2, 2] },
        },
        {
          id: 'states-line', type: 'line', source: 'states',
          paint: { 'line-color': exec, 'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 1.6, 0.6], 'line-opacity': ['case', ['>', ['coalesce', ['feature-state', 'planned'], 0], 0], 0.55, 0.08] },
        },
        {
          id: 'territory-halo', type: 'circle', source: 'territory',
          paint: {
            'circle-color': ['interpolate', ['linear'], ['get', 'completion'], 0, exec, 1, ok],
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, ['+', 2, ['*', 1.4, ['sqrt', ['get', 'planned']]]], 7, ['+', 8, ['*', 3, ['sqrt', ['get', 'planned']]]]],
            'circle-blur': 1, 'circle-opacity': 0.32,
          },
        },
        {
          id: 'territory-core', type: 'circle', source: 'territory',
          paint: {
            'circle-color': ['case', ['>', ['get', 'ready'], 0], ['interpolate', ['linear'], ['get', 'completion'], 0, exec, 1, ok], 'rgba(0,0,0,0)'],
            'circle-stroke-color': ['interpolate', ['linear'], ['get', 'completion'], 0, exec, 1, ok],
            'circle-stroke-width': ['case', ['==', ['get', 'selected'], 1], 2, 1],
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 1.6, 7, 4.5],
            'circle-opacity': 0.95,
          },
        },
      ],
    }
    let map: MlMap
    try {
      map = new maplibregl.Map({
        container: el, style, center: GLOBE_HOME.center, zoom: GLOBE_HOME.zoom, attributionControl: { compact: true },
        keyboard: false, maxPitch: 60, renderWorldCopies: false, fadeDuration: 0,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'WebGL is unavailable'
      queueMicrotask(() => setFailed(msg))
      return
    }
    mapRef.current = map
    map.on('load', () => setReady(true))
    map.on('error', (ev) => {
      // tile hiccups are not fatal; only a dead context is
      if (String((ev as { error?: Error }).error?.message ?? '').includes('WebGL')) setFailed('WebGL context lost')
    })
    map.on('mousemove', 'territory-core', (ev) => {
      const f = ev.features?.[0]
      if (!f) return
      map.getCanvas().style.cursor = 'pointer'
      setHover({ x: ev.point.x, y: ev.point.y, id: String(f.properties?.id) })
    })
    map.on('mouseleave', 'territory-core', () => { map.getCanvas().style.cursor = ''; setHover(null) })
    map.on('click', 'territory-core', (ev) => { const id = ev.features?.[0]?.properties?.id; if (id) onSelectRef.current(String(id)) })
    map.on('click', 'states-fill', (ev) => {
      if (map.queryRenderedFeatures(ev.point, { layers: ['territory-core'] }).length) return
      const abbr = ev.features?.[0]?.properties?.abbr
      if (abbr) onSelectRef.current(`us-${String(abbr).toLowerCase()}`)
    })
    return () => { map.remove(); mapRef.current = null }
  }, [])

  // data → sources + feature state
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    ;(map.getSource('territory') as GeoJSONSource | undefined)?.setData(territoryFeatures(cov, selectedGeo))
    map.removeFeatureState({ source: 'states' })
    for (const c of cov.values()) {
      if (c.geo.kind !== 'STATE' || !c.geo.code) continue
      map.setFeatureState({ source: 'states', id: c.geo.code }, { planned: c.planned, completion: c.planned ? c.ready / c.planned : 0, selected: c.geo.id === selectedGeo })
    }
    const sel = selectedGeo ? model.geo.get(selectedGeo) : null
    if (sel?.kind === 'STATE' && sel.code && !cov.has(sel.id)) map.setFeatureState({ source: 'states', id: sel.code }, { selected: true })
    map.setFilter('states-gap', ['in', ['get', 'abbr'], ['literal', [...gapStates]]])
  }, [ready, cov, gapStates, selectedGeo, model])

  // camera: frame the scope once loaded; fly to a selection
  const framed = useRef<string | null>(null)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const key = `${scope ?? 'portfolio'}`
    if (framed.current === key && !selectedGeo) return
    framed.current = key
    const g = selectedGeo ? model.geo.get(selectedGeo) : null
    const target = g && g.lat != null && g.lng != null ? { center: [g.lng, g.lat] as [number, number], zoom: ZOOM_FOR[g.kind] } : US_FRAME
    if (reducedRef.current) map.jumpTo(target)
    else map.flyTo({ ...target, duration: g ? 1800 : 2600, curve: 1.35, essential: false })
  }, [ready, scope, selectedGeo, model])

  const hovered = hover ? cov.get(hover.id) : null
  if (failed) {
    return (
      <div className="si-globe si-globe--fallback" role="img" aria-label={label}>
        <div className="si-globe__fallback">
          <b>The globe needs WebGL</b>
          <span>The planned territory is listed beside it, and the Geography view shows the same plan on a flat map.</span>
        </div>
      </div>
    )
  }
  return (
    <div className="si-globe" data-dimmed={dimmed ? 'true' : undefined}>
      <div ref={host} className="si-globe__map" role="application" aria-label={label} />
      {hovered && hover ? (
        <div className="si-globe__tip" style={{ left: hover.x, top: hover.y }}>
          <b>{hovered.geo.name}{hovered.geo.stateCode && hovered.geo.kind !== 'STATE' ? `, ${hovered.geo.stateCode}` : ''}</b>
          <span>{hovered.planned} planned · {hovered.ready} ready</span>
        </div>
      ) : null}
      <div className="si-globe__ctl">
        <LCIconButton icon="globe" label="Whole globe" size="sm" onClick={() => { const m = mapRef.current; if (!m) return; if (reducedRef.current) m.jumpTo(GLOBE_HOME); else m.flyTo({ ...GLOBE_HOME, duration: 2000 }) }} />
        <LCIconButton icon="target" label="Frame the United States" size="sm" onClick={() => { const m = mapRef.current; if (!m) return; if (reducedRef.current) m.jumpTo(US_FRAME); else m.flyTo({ ...US_FRAME, duration: 1800 }) }} />
      </div>
    </div>
  )
}
