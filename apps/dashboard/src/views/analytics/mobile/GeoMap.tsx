import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { StatePerformance } from '../../../lib/data/kpiDashboardData'
import { metricCount, metricIntensity, metricRate, type GeoMetric } from './geo-metric'
import { CONUS_BOUNDS, NATIONAL_VIEW, stateGeography, US_STATE_GEOGRAPHY } from './us-state-geography'

/**
 * THE UNITED STATES, AS AN ACTUAL MAP — CARVED OUT OF THE WORLD.
 *
 * This replaces a hand-simplified SVG outline set (`USA_STATE_PATHS`) the metrics
 * were painted onto. It was a drawing of the country, and it looked like one:
 * blocky, projection-less, unrecognisable once a single state was framed. The
 * numbers were real; the geography was not.
 *
 * Three layers do the work, over the same MapLibre + Carto basemap the Map and
 * Comp Intelligence surfaces already run on — no new dependency, no new key:
 *
 *   MASK      one world-sized polygon with all 51 state outlines punched through
 *             it as holes. Everything that is not the United States sinks; the
 *             country reads as carved out of the surface rather than floating on
 *             a world map that happens to be centred on it.
 *   FILL      every state, tinted by the selected metric where it was measured,
 *             and a tap target across its whole area rather than only its dot.
 *   OUTLINE   every state border, always — including the quiet ones, which is
 *             what makes the shape of the country legible at national zoom.
 *
 * The METRIC itself stays on proportional circles. Shading an area by a COUNT is
 * the classic choropleth error: it reads as density and makes Montana look like a
 * market because it is large. The fill carries only a faint "this one is live"
 * tint; the circle carries the magnitude.
 *
 * WHAT IS NOT CLAIMED. A state the endpoint never measured is outlined like every
 * other and left empty. A state measured at zero on the current metric gets a
 * hollow ring. Neither is shaded as if it had produced something.
 *
 * §30.24 — nothing here depends on hover: the value is painted beside each state,
 * selection is a visible halo, and every shape is a tap target.
 */

const DARK_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
const LIGHT_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'

/** 51 simplified state outlines, keyed by abbreviation. Served, not bundled. */
const STATES_GEOJSON_URL = '/geo/us-states.json'

const STATES_SOURCE = 'geo-state-shapes'
const MASK_SOURCE = 'geo-world-mask'
const POINT_SOURCE = 'geo-state-points'

const MASK_LAYER = 'geo-mask'
const FILL_LAYER = 'geo-state-fill'
const OUTLINE_LAYER = 'geo-state-outline'
const SELECTED_LAYER = 'geo-state-selected'
const CIRCLE_LAYER = 'geo-state-circle'
const LABEL_LAYER = 'geo-state-label'

type StateShapes = {
  type: 'FeatureCollection'
  features: Array<{
    type: 'Feature'
    id: string
    properties: { abbr: string; name: string }
    geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][] }
  }>
}

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

const compact = (value: number): string =>
  value >= 1000 ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
    : String(value)

const isLightTheme = () => {
  if (typeof document === 'undefined') return false
  return document.documentElement.getAttribute('data-nexus-theme') === 'light'
}

/**
 * The world, minus the United States.
 *
 * A GeoJSON polygon's first ring is its outer boundary and every ring after it is
 * a HOLE. So one ring around the whole planet followed by every state's outer
 * ring produces a single shape covering everything except the country. Filled with
 * a dark wash it is the carve-out; no per-state masking and no second basemap.
 *
 * Only OUTER rings are punched. A state's own interior holes (lakes, enclaves)
 * would otherwise re-cover slivers of the country with the mask.
 */
const buildWorldMask = (shapes: StateShapes) => {
  const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]
  const holes: number[][][] = []
  for (const feature of shapes.features) {
    if (feature.geometry.type === 'Polygon') {
      const outer = (feature.geometry.coordinates as number[][][])[0]
      if (outer) holes.push(outer)
    } else {
      for (const polygon of feature.geometry.coordinates as number[][][][]) {
        if (polygon[0]) holes.push(polygon[0])
      }
    }
  }
  return {
    type: 'FeatureCollection' as const,
    features: [{
      type: 'Feature' as const,
      properties: {},
      geometry: { type: 'Polygon' as const, coordinates: [world, ...holes] },
    }],
  }
}

export interface GeoMapProps {
  states: StatePerformance[]
  metric: GeoMetric
  selectedState: string | null
  onSelectState: (abbr: string | null) => void
  loading: boolean
}

export const GeoMap = ({ states, metric, selectedState, onSelectState, loading }: GeoMapProps) => {
  const holder = useRef<HTMLDivElement | null>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const [ready, setReady] = useState(false)
  const [styleFailed, setStyleFailed] = useState(false)
  const [light, setLight] = useState(isLightTheme)
  const [shapes, setShapes] = useState<StateShapes | null>(null)

  // Handlers change every render; the map's listeners are bound once, so they read
  // the latest through a ref rather than being torn down and rebound.
  const selectRef = useRef(onSelectState)
  selectRef.current = onSelectState

  // The tap handler binds to a LAYER, and the layers are rebuilt on every theme
  // swap. Tracking the binding here rather than on the map instance keeps it to
  // one registration without stapling a field onto maplibre's own type.
  const tapBound = useRef(false)

  /**
   * Every state the endpoint MEASURED, including those sitting at zero on the
   * selected metric. Measured-and-zero is a different fact from never-measured:
   * a live state with no replies yet gets a hollow ring, an unmeasured one gets
   * only its outline.
   */
  const measured = useMemo(
    () => states.filter((row) => US_STATE_GEOGRAPHY[row.state]),
    [states],
  )

  const max = useMemo(
    () => measured.reduce((best, row) => Math.max(best, metricCount(row, metric)), 0),
    [measured, metric],
  )

  /** abbr -> intensity, for the state FILL tint. */
  const intensityExpression = useMemo(() => {
    const stops: Array<string | number> = []
    for (const row of measured) {
      stops.push(row.state, metricIntensity(row, metric, max))
    }
    return stops
  }, [measured, metric, max])

  const points = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: measured.map((row) => {
      const geography = US_STATE_GEOGRAPHY[row.state]
      const count = metricCount(row, metric)
      const rate = metricRate(row, metric)
      return {
        type: 'Feature' as const,
        id: row.state,
        geometry: { type: 'Point' as const, coordinates: geography.center },
        properties: {
          abbr: row.state,
          count,
          // Radius tracks the MAGNITUDE, not the rank. Sizing off the
          // max-normalised intensity meant the leading state always drew the
          // largest possible circle — a 38px disc announcing a single message,
          // which is what one live state in a quiet week actually produced.
          radius: count > 0 ? Math.min(30, 5 + 3.1 * Math.sqrt(count)) : 6,
          intensity: metricIntensity(row, metric, max),
          zero: count > 0 ? 0 : 1,
          label: rate == null
            ? `${row.state} ${compact(count)}`
            : `${row.state} ${compact(count)} · ${Math.round(rate * 10) / 10}%`,
          selected: row.state === selectedState ? 1 : 0,
        },
      }
    }),
  }), [measured, metric, max, selectedState])

  // ── the outlines, fetched once and shared by the mask
  useEffect(() => {
    let live = true
    fetch(STATES_GEOJSON_URL)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((data: StateShapes) => { if (live) setShapes(data) })
      // The outlines failing is not the map failing: the basemap and the metric
      // circles still carry the answer, so this degrades rather than blanks out.
      .catch(() => { if (live) setShapes(null) })
    return () => { live = false }
  }, [])

  // ── theme follows the app, like every other map in the product
  useEffect(() => {
    const observer = new MutationObserver(() => setLight(isLightTheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-nexus-theme'] })
    return () => observer.disconnect()
  }, [])

  // ── map lifecycle
  useEffect(() => {
    if (!holder.current || map.current) return
    let instance: maplibregl.Map
    try {
      instance = new maplibregl.Map({
        container: holder.current,
        style: light ? LIGHT_STYLE : DARK_STYLE,
        center: NATIONAL_VIEW.center,
        zoom: NATIONAL_VIEW.zoom,
        attributionControl: { compact: true },
        // An instrument inside a scrolling column, not the page. Drag and pinch
        // stay on; rotation does not, because a rotated country is never useful.
        dragRotate: false,
        pitchWithRotate: false,
        touchZoomRotate: true,
      })
    } catch {
      setStyleFailed(true)
      return
    }
    map.current = instance
    instance.on('error', (event) => {
      if (String(event?.error?.message || '').match(/style|sprite|glyph/i)) setStyleFailed(true)
    })
    instance.on('load', () => setReady(true))
    return () => {
      instance.remove()
      map.current = null
      setReady(false)
    }
    // `light` is intentionally not a dependency — the style is swapped below so a
    // theme change does not destroy and rebuild the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── theme swap without a remount. setStyle drops every custom layer, so
  // `ready` flips false and the layer effect below rebuilds them.
  useEffect(() => {
    const instance = map.current
    if (!instance || !ready) return
    setReady(false)
    instance.once('styledata', () => setReady(true))
    instance.setStyle(light ? LIGHT_STYLE : DARK_STYLE)
  }, [light]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── sources + layers
  useEffect(() => {
    const instance = map.current
    if (!instance || !ready) return

    /**
     * The basemap names the countries; this map does not need it to.
     *
     * "UNITED STATES" is drawn by Carto in the middle of the country, where it
     * lands on top of the state outlines and the metric labels, and MEXICO /
     * CUBA / GUATEMALA keep announcing themselves through the carve-out wash —
     * which is the one thing the wash exists to stop. Country, state and
     * continent labels go; city labels stay, because at state zoom they are the
     * only way to tell where a market actually is.
     */
    for (const layer of instance.getStyle().layers ?? []) {
      if (layer.type !== 'symbol') continue
      if (!/place[-_](country|state|continent)/i.test(layer.id)) continue
      instance.setLayoutProperty(layer.id, 'visibility', 'none')
    }

    const ensureSource = (id: string, data: unknown) => {
      const existing = instance.getSource(id) as maplibregl.GeoJSONSource | undefined
      if (existing) existing.setData(data as GeoJSON.FeatureCollection)
      else instance.addSource(id, { type: 'geojson', data: data as GeoJSON.FeatureCollection })
    }

    if (shapes) {
      ensureSource(MASK_SOURCE, buildWorldMask(shapes))
      ensureSource(STATES_SOURCE, shapes)

      if (!instance.getLayer(MASK_LAYER)) {
        instance.addLayer({
          id: MASK_LAYER,
          type: 'fill',
          source: MASK_SOURCE,
          paint: { 'fill-color': light ? '#dfe5ee' : '#04060b', 'fill-opacity': light ? 0.82 : 0.86 },
        })
      }

      if (!instance.getLayer(FILL_LAYER)) {
        instance.addLayer({
          id: FILL_LAYER,
          type: 'fill',
          source: STATES_SOURCE,
          paint: { 'fill-color': 'rgba(94, 234, 212, 0.16)', 'fill-opacity': 0 },
        })
      }

      if (!instance.getLayer(OUTLINE_LAYER)) {
        instance.addLayer({
          id: OUTLINE_LAYER,
          type: 'line',
          source: STATES_SOURCE,
          paint: {
            'line-color': light ? 'rgba(15, 23, 42, 0.28)' : 'rgba(255, 255, 255, 0.22)',
            'line-width': 0.8,
          },
        })
      }

      if (!instance.getLayer(SELECTED_LAYER)) {
        instance.addLayer({
          id: SELECTED_LAYER,
          type: 'line',
          source: STATES_SOURCE,
          filter: ['==', ['get', 'abbr'], ''],
          paint: {
            'line-color': light ? '#0d9488' : '#5eead4',
            'line-width': 2,
          },
        })
      }

      if (!tapBound.current) {
        // A whole state is the target, not a 12px dot.
        instance.on('click', FILL_LAYER, (event) => {
          const abbr = event.features?.[0]?.properties?.abbr
          if (typeof abbr === 'string') selectRef.current(abbr)
        })
        tapBound.current = true
      }
    }

    ensureSource(POINT_SOURCE, points)

    if (!instance.getLayer(CIRCLE_LAYER)) {
      instance.addLayer({
        id: CIRCLE_LAYER,
        type: 'circle',
        source: POINT_SOURCE,
        paint: {
          // sqrt-scaled radius, so AREA is proportional to the value — the whole
          // point of a proportional-symbol map.
          'circle-radius': ['get', 'radius'],
          'circle-color': 'rgba(94, 234, 212, 0.5)',
          // Measured but zero on this metric: an empty ring. Present, and honestly
          // empty — not absent, and not shaded as if it had produced something.
          'circle-opacity': ['case', ['==', ['get', 'zero'], 1], 0, 0.95],
          'circle-stroke-width': ['case', ['==', ['get', 'selected'], 1], 2, 1],
          'circle-stroke-color': [
            'case',
            ['==', ['get', 'selected'], 1], '#ffffff',
            ['==', ['get', 'zero'], 1], 'rgba(255,255,255,0.34)',
            'rgba(255,255,255,0.5)',
          ],
        },
      })
    }

    if (!instance.getLayer(LABEL_LAYER)) {
      instance.addLayer({
        id: LABEL_LAYER,
        type: 'symbol',
        source: POINT_SOURCE,
        layout: {
          'text-field': ['get', 'label'],
          'text-size': ['case', ['==', ['get', 'zero'], 1], 9.5, 11],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'text-offset': [0, 1.5],
          'text-anchor': 'top',
        },
        paint: {
          'text-color': light ? '#0f172a' : '#ffffff',
          'text-halo-color': light ? 'rgba(255,255,255,0.9)' : 'rgba(3, 7, 15, 0.88)',
          'text-halo-width': 1.4,
        },
      })
    }
  }, [ready, shapes, points, light])

  // ── metric-driven paint. Separated from layer creation so switching metric
  // repaints rather than rebuilding, and so the inverse ramp lives in one place.
  useEffect(() => {
    const instance = map.current
    if (!instance || !ready) return

    const ramp = metric.inverse
      ? ['interpolate', ['linear'], ['get', 'intensity'],
        0, 'rgba(251, 191, 36, 0.34)', 0.5, 'rgba(248, 113, 113, 0.64)', 1, 'rgba(239, 68, 68, 0.9)']
      : ['interpolate', ['linear'], ['get', 'intensity'],
        0, 'rgba(94, 234, 212, 0.38)', 0.5, 'rgba(56, 189, 248, 0.68)', 1, 'rgba(129, 140, 248, 0.9)']

    if (instance.getLayer(CIRCLE_LAYER)) {
      instance.setPaintProperty(CIRCLE_LAYER, 'circle-color', ramp as maplibregl.ExpressionSpecification)
    }

    if (instance.getLayer(FILL_LAYER)) {
      // A faint "this one is live" wash, never the metric's own encoding — see the
      // choropleth note at the top. Unmeasured states match nothing and stay at 0.
      const opacity = intensityExpression.length
        ? ['*', 0.5, ['match', ['get', 'abbr'], ...intensityExpression, 0]]
        : 0
      instance.setPaintProperty(FILL_LAYER, 'fill-opacity', opacity as maplibregl.ExpressionSpecification)
      instance.setPaintProperty(FILL_LAYER, 'fill-color', metric.inverse
        ? 'rgba(248, 113, 113, 0.5)'
        : 'rgba(94, 234, 212, 0.34)')
    }
  }, [ready, metric.inverse, intensityExpression])

  // ── selection outline
  useEffect(() => {
    const instance = map.current
    if (!instance || !ready || !instance.getLayer(SELECTED_LAYER)) return
    instance.setFilter(SELECTED_LAYER, ['==', ['get', 'abbr'], selectedState ?? ''])
  }, [ready, selectedState])

  // ── mask + outline tone follow the theme
  useEffect(() => {
    const instance = map.current
    if (!instance || !ready) return
    if (instance.getLayer(MASK_LAYER)) {
      instance.setPaintProperty(MASK_LAYER, 'fill-color', light ? '#dfe5ee' : '#04060b')
      instance.setPaintProperty(MASK_LAYER, 'fill-opacity', light ? 0.82 : 0.86)
    }
    if (instance.getLayer(OUTLINE_LAYER)) {
      instance.setPaintProperty(OUTLINE_LAYER, 'line-color',
        light ? 'rgba(15, 23, 42, 0.28)' : 'rgba(255, 255, 255, 0.22)')
    }
  }, [ready, light])

  // ── the drill: the same map, moved
  useEffect(() => {
    const instance = map.current
    if (!instance || !ready) return
    const target = stateGeography(selectedState)
    if (target) {
      instance.easeTo({ center: target.center, zoom: target.zoom, duration: 700 })
      return
    }
    // The nation is FITTED rather than flown to a guessed zoom: a fixed zoom that
    // frames the country on one phone clips Florida on a shorter one, and Florida
    // is where the activity is. Bottom padding also keeps a circle from landing
    // under the basemap attribution, which cannot be moved or hidden.
    instance.fitBounds(CONUS_BOUNDS, {
      padding: { top: 16, bottom: 34, left: 14, right: 14 },
      duration: 700,
    })
  }, [ready, selectedState])

  if (styleFailed) {
    return (
      <div className="geo-map is-unavailable" role="status">
        <strong>Map unavailable</strong>
        <span>The basemap could not be loaded. The measurements below are unaffected.</span>
      </div>
    )
  }

  return (
    <div className={cls('geo-map', loading && 'is-loading')}>
      <div ref={holder} className="geo-map__canvas" aria-hidden />
      {/* The map is a picture to a screen reader; this is the same information. */}
      <ul className="nx-sr-only">
        {measured.map((row) => (
          <li key={row.state}>
            {row.stateName}: {metricCount(row, metric)} {metric.label.toLowerCase()}
          </li>
        ))}
      </ul>
      {!loading && measured.length === 0 ? (
        <div className="geo-map__empty" role="status">
          No {metric.label.toLowerCase()} measured in this range.
        </div>
      ) : null}
      {selectedState ? (
        <button type="button" className="geo-map__reset" onClick={() => onSelectState(null)}>
          Back to United States
        </button>
      ) : null}
    </div>
  )
}
