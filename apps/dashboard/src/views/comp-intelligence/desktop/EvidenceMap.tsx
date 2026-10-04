import { useEffect, useRef, useState } from 'react'
import maplibregl, { type GeoJSONSource, type LngLatLike } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Tier } from './derive-workstation'
import type { FocusStore } from './focus-store'
import { colorExpression, rampFor, readPalette, ringFeatures, ringLabelFeatures, styleFor, type MapMode, type MapPalette } from './map-style'
import { squareImage, recentCollection, RECENT_ICON_ACTIVITY, RECENT_ICON_PRICED, RECENT_SOURCE, type RecentPoint } from './recent-sales-layer'

export interface MapPoint {
  key: string
  lat: number
  lng: number
  tier: Tier
  /** mode metrics */
  unit: number | null
  price: number | null
  age: number | null
  score: number | null
  /** price label at street zoom */
  label: string
  /** adjusted value outside the engine's outlier band */
  flagged: boolean
}

export type CameraAction = { kind: 'subject' | 'set' | 'search' | 'zoomIn' | 'zoomOut'; n: number }

interface Props {
  subject: { lat: number | null; lng: number | null; address: string | null }
  points: MapPoint[]
  mode: MapMode
  domain: [number, number] | null
  radiusMiles: number
  imagery: boolean
  theme: string
  store: FocusStore
  onOpen: (key: string) => void
  camera: CameraAction | null
  reduced: boolean
  onReady: () => void
  /** recent market sales — their own layer, never valuation evidence */
  recent?: RecentPoint[]
  showRecent?: boolean
}

const INTERACTIVE = ['ci-set', 'ci-set-removed', 'ci-bg-candidate', 'ci-bg-excluded'] as const
const empty = { type: 'FeatureCollection' as const, features: [] as GeoJSON.Feature[] }
const CLUSTER_ABOVE = 80

function collection(points: MapPoint[], tiers: Tier[]) {
  return {
    type: 'FeatureCollection' as const,
    features: points.filter((p) => tiers.includes(p.tier)).map((p) => ({
      type: 'Feature' as const,
      id: p.key,
      properties: { key: p.key, tier: p.tier, unit: p.unit, price: p.price, age: p.age, score: p.score, label: p.label, flagged: p.flagged ? 1 : 0 },
      geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
    })),
  }
}

/**
 * THE SPATIAL EVIDENCE MAP (§10–18, §113–116). MapLibre layers, never a DOM
 * marker per sale — only the subject is a DOM element, so it can be shaped
 * and labelled unlike anything else on the map (§9). The shown set has its
 * own unclustered source (it must always be individually visible); the rest
 * of the universe clusters when it is large. Changing the analysis mode
 * changes paint, never the map; changing theme or imagery swaps the style
 * on the same map and reinstalls the layers.
 */
const NO_RECENT: RecentPoint[] = []

export function EvidenceMap({ subject, points, mode, domain, radiusMiles, imagery, theme, store, onOpen, camera, reduced, onReady, recent = NO_RECENT, showRecent = true }: Props) {
  const host = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const marker = useRef<maplibregl.Marker | null>(null)
  const latest = useRef({ subject, points, mode, domain, radiusMiles, imagery, theme, onOpen, reduced, onReady, recent, showRecent })
  const clustered = useRef<boolean | null>(null)
  const fitted = useRef<string | null>(null)
  const [ready, setReady] = useState(0)
  const { lat: sLat, lng: sLng, address: sAddress } = subject

  useEffect(() => { latest.current = { subject, points, mode, domain, radiusMiles, imagery, theme, onOpen, reduced, onReady, recent, showRecent } })

  // Create the map once; it lives as long as the workstation does (§151).
  useEffect(() => {
    if (!host.current || mapRef.current) return
    const s = latest.current
    const map = new maplibregl.Map({
      container: host.current,
      style: styleFor(s.theme, s.imagery),
      center: [s.subject.lng ?? -96, s.subject.lat ?? 38],
      zoom: s.subject.lat !== null ? 13 : 3.4,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      maxPitch: 0,
      fadeDuration: 0,
    })
    map.touchZoomRotate.disableRotation()
    map.keyboard.disableRotation()
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')
    mapRef.current = map
    map.on('style.load', () => {
      clustered.current = install(map, host.current, latest.current)
      setReady((n) => n + 1)
      latest.current.onReady()
    })
    for (const id of INTERACTIVE) {
      map.on('mousemove', id, (e) => {
        const k = e.features?.[0]?.properties?.key
        if (k) { map.getCanvas().style.cursor = 'pointer'; store.hover(String(k), 'map') }
      })
      map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; store.hover(null, null) })
      map.on('click', id, (e) => {
        const k = e.features?.[0]?.properties?.key
        if (k) { store.select(String(k)); latest.current.onOpen(String(k)) }
      })
    }
    map.on('click', 'ci-bg-cluster', (e) => {
      const f = e.features?.[0]
      const id = f?.properties?.cluster_id
      const src = map.getSource('ci-bg') as GeoJSONSource | undefined
      if (!f || id === undefined || !src) return
      void src.getClusterExpansionZoom(id).then((zoom) => {
        map.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as LngLatLike, zoom, duration: latest.current.reduced ? 0 : 450 })
      })
    })
    map.on('mouseenter', 'ci-bg-cluster', () => { map.getCanvas().style.cursor = 'zoom-in' })
    map.on('mouseleave', 'ci-bg-cluster', () => { map.getCanvas().style.cursor = '' })
    return () => {
      marker.current?.remove()
      marker.current = null
      map.remove()
      mapRef.current = null
    }
  }, [store])

  // Theme / imagery: same map, new cartography; layers reinstall on style.load.
  const styleKey = imagery ? 'imagery' : theme === 'light' ? 'light' : 'dark'
  const lastStyle = useRef(styleKey)
  useEffect(() => {
    const map = mapRef.current
    if (!map || lastStyle.current === styleKey) return
    lastStyle.current = styleKey
    map.setStyle(styleFor(theme, imagery))
  }, [styleKey, theme, imagery])

  // Evidence data (tiers change with every include / exclude / filter).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const bgCount = points.filter((p) => p.tier === 'candidate' || p.tier === 'excluded').length
    const wantCluster = bgCount > CLUSTER_ABOVE
    if (clustered.current !== wantCluster) {
      installBackground(map, latest.current, wantCluster, readPalette(host.current, theme, imagery))
      clustered.current = wantCluster
    }
    ;(map.getSource('ci-bg') as GeoJSONSource | undefined)?.setData(collection(points, ['candidate', 'excluded']))
    ;(map.getSource('ci-set') as GeoJSONSource | undefined)?.setData(collection(points, ['set', 'added', 'removed']))
    const links = sLat === null || sLng === null ? empty : {
      type: 'FeatureCollection' as const,
      features: points.filter((p) => p.tier === 'set' || p.tier === 'added').map((p) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: [[sLng as number, sLat as number], [p.lng, p.lat]] } })),
    }
    ;(map.getSource('ci-links') as GeoJSONSource | undefined)?.setData(links)
  }, [points, ready, sLat, sLng, theme, imagery])

  // Recent market sales: their own source, toggled by data (never by evidence tiers).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    ;(map.getSource(RECENT_SOURCE) as GeoJSONSource | undefined)?.setData(recentCollection(recent, showRecent))
  }, [recent, showRecent, ready])

  // Mode → paint only.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const pal = readPalette(host.current, theme, imagery)
    paintForMode(map, mode, domain, pal, rampFor(theme === 'light' && !imagery ? 'light' : 'dark'))
  }, [mode, domain, ready, theme, imagery])

  // Rings + subject marker follow the subject and the search radius.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const lat = sLat
    const lng = sLng
    const rings = lat !== null && lng !== null ? ringFeatures(lat, lng, radiusMiles) : empty
    const labels = lat !== null && lng !== null ? ringLabelFeatures(lat, lng, radiusMiles) : empty
    ;(map.getSource('ci-rings') as GeoJSONSource | undefined)?.setData(rings)
    ;(map.getSource('ci-ring-labels') as GeoJSONSource | undefined)?.setData(labels)
    marker.current?.remove()
    marker.current = null
    if (lat !== null && lng !== null) {
      const el = document.createElement('div')
      el.className = 'ciw-subject-pin'
      el.setAttribute('role', 'img')
      el.setAttribute('aria-label', `Subject · ${sAddress ?? 'subject property'}`)
      el.innerHTML = '<span class="ciw-subject-pin__halo"></span><span class="ciw-subject-pin__core"></span><span class="ciw-subject-pin__label">Subject</span>'
      marker.current = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([lng, lat]).addTo(map)
    }
  }, [sLat, sLng, sAddress, radiusMiles, ready])

  // Fit once per subject: the subject and the shown set.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || sLat === null || sLng === null) return
    const sig = `${sLat},${sLng}`
    if (fitted.current === sig) return
    fitted.current = sig
    fitTo(map, 'set', latest.current, true)
  }, [ready, sLat, sLng])

  // Explicit camera actions from the floating controls.
  const lastCamera = useRef<number | null>(null)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !camera || lastCamera.current === camera.n) return
    lastCamera.current = camera.n
    if (camera.kind === 'zoomIn') map.zoomIn({ duration: reduced ? 0 : 250 })
    else if (camera.kind === 'zoomOut') map.zoomOut({ duration: reduced ? 0 : 250 })
    else fitTo(map, camera.kind, latest.current, false)
  }, [camera, ready, reduced])

  // Focus: hover + selection halos, without a React render of the map.
  useEffect(() => {
    if (!ready) return
    const apply = () => {
      const map = mapRef.current
      const src = map?.getSource('ci-focus') as GeoJSONSource | undefined
      if (!map || !src) return
      const f = store.get()
      const pts = latest.current.points
      const feats: GeoJSON.Feature[] = []
      for (const [key, kind] of [[f.selected, 'selected'], [f.hover, 'hover']] as const) {
        if (!key) continue
        const p = pts.find((x) => x.key === key)
        if (p) feats.push({ type: 'Feature', properties: { kind }, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } })
      }
      src.setData({ type: 'FeatureCollection', features: feats })
      // a selection made elsewhere brings its sale into view, without yanking the camera when it is already visible
      if (f.selected && f.hoverSource !== 'map') {
        const p = pts.find((x) => x.key === f.selected)
        if (p && !map.getBounds().contains([p.lng, p.lat])) map.easeTo({ center: [p.lng, p.lat], duration: latest.current.reduced ? 0 : 500 })
      }
    }
    apply()
    return store.subscribe(apply)
  }, [store, ready])

  return <div ref={host} className="ciw-map__canvas" aria-label={`Map of comparable sales around ${subject.address ?? 'the subject'}`} role="region" />
}

type Latest = { subject: Props['subject']; points: MapPoint[]; mode: MapMode; domain: [number, number] | null; radiusMiles: number; imagery: boolean; theme: string; reduced: boolean; recent?: RecentPoint[]; showRecent?: boolean }

/**
 * The recent-sales layer sits beneath every evidence layer: a square in
 * neutral ink, constant under every analysis mode, so it can never read as
 * part of the valuation set.
 */
function installRecent(map: maplibregl.Map, el: HTMLElement | null, s: Latest, pal: MapPalette) {
  const ink = (el ? getComputedStyle(el).getPropertyValue('--ciw-recent').trim() : '') || pal.ink
  for (const [id, hollow] of [[RECENT_ICON_PRICED, false], [RECENT_ICON_ACTIVITY, true]] as const) {
    if (map.hasImage(id)) map.removeImage(id)
    map.addImage(id, squareImage(28, ink, pal.halo, hollow), { pixelRatio: 2 })
  }
  if (map.getSource(RECENT_SOURCE)) return
  map.addSource(RECENT_SOURCE, { type: 'geojson', data: recentCollection(s.recent ?? [], s.showRecent !== false) })
  map.addLayer({ id: 'ci-recent', type: 'symbol', source: RECENT_SOURCE, layout: {
    'icon-image': ['case', ['==', ['get', 'priced'], 1], RECENT_ICON_PRICED, RECENT_ICON_ACTIVITY],
    'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.72, 16, 1.05],
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
  }, paint: { 'icon-opacity': 0.82 } })
}

function fitTo(map: maplibregl.Map, kind: 'subject' | 'set' | 'search', s: Latest, initial: boolean) {
  const { lat, lng } = s.subject
  const duration = initial || s.reduced ? 0 : 600
  const padding = { top: 72, bottom: 56, left: 48, right: 48 }
  if (lat === null || lng === null) {
    const pts = s.points
    if (!pts.length) return
    const b = new maplibregl.LngLatBounds([pts[0].lng, pts[0].lat], [pts[0].lng, pts[0].lat])
    for (const p of pts) b.extend([p.lng, p.lat])
    map.fitBounds(b, { padding, maxZoom: 15, duration })
    return
  }
  if (kind === 'subject') { map.easeTo({ center: [lng, lat], zoom: 15, duration }); return }
  const b = new maplibregl.LngLatBounds([lng, lat], [lng, lat])
  if (kind === 'search') {
    const dLat = s.radiusMiles / 69
    const dLng = s.radiusMiles / (69 * Math.cos((lat * Math.PI) / 180))
    b.extend([lng - dLng, lat - dLat]).extend([lng + dLng, lat + dLat])
  } else {
    const set = s.points.filter((p) => p.tier === 'set' || p.tier === 'added')
    for (const p of set) b.extend([p.lng, p.lat])
    if (!set.length) {
      const d = Math.min(1, s.radiusMiles) / 69
      b.extend([lng - d, lat - d]).extend([lng + d, lat + d])
    }
  }
  map.fitBounds(b, { padding, maxZoom: 15, duration })
}

function firstSymbolLayer(map: maplibregl.Map): string | undefined {
  return map.getStyle().layers?.find((l) => l.type === 'symbol' && /label|place|road/i.test(l.id))?.id
}

function install(map: maplibregl.Map, el: HTMLElement | null, s: Latest): boolean {
  const pal = readPalette(el, s.theme, s.imagery)
  const before = firstSymbolLayer(map)
  if (!map.getSource('ci-rings')) {
    map.addSource('ci-rings', { type: 'geojson', data: empty })
    map.addLayer({ id: 'ci-rings', type: 'line', source: 'ci-rings', paint: {
      'line-color': ['case', ['==', ['get', 'kind'], 'search'], pal.set, pal.ink],
      'line-opacity': ['case', ['==', ['get', 'kind'], 'search'], 0.5, 0.16],
      'line-width': ['case', ['==', ['get', 'kind'], 'search'], 1.3, 1],
    } }, before)
    map.addSource('ci-ring-labels', { type: 'geojson', data: empty })
    map.addLayer({ id: 'ci-ring-labels', type: 'symbol', source: 'ci-ring-labels', layout: {
      'text-field': ['get', 'label'], 'text-size': 10, 'text-font': ['Open Sans Semibold', 'Open Sans Regular'], 'text-offset': [0, -0.7], 'text-allow-overlap': false,
    }, paint: { 'text-color': pal.ink, 'text-opacity': 0.62, 'text-halo-color': pal.halo, 'text-halo-width': 1.4 } })
  }
  if (!map.getSource('ci-links')) {
    map.addSource('ci-links', { type: 'geojson', data: empty })
    map.addLayer({ id: 'ci-links', type: 'line', source: 'ci-links', layout: { 'line-cap': 'round' }, paint: { 'line-color': pal.set, 'line-opacity': 0.32, 'line-width': 1 } })
  }
  installRecent(map, el, s, pal)
  const cluster = s.points.filter((p) => p.tier === 'candidate' || p.tier === 'excluded').length > CLUSTER_ABOVE
  installBackground(map, s, cluster, pal)
  if (!map.getSource('ci-set')) {
    map.addSource('ci-set', { type: 'geojson', data: collection(s.points, ['set', 'added', 'removed']), promoteId: 'key' })
    map.addLayer({ id: 'ci-set-flag', type: 'circle', source: 'ci-set', filter: ['==', ['get', 'flagged'], 1], paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 9, 16, 12], 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': pal.attn, 'circle-stroke-width': 1.6,
    } })
    map.addLayer({ id: 'ci-set-removed', type: 'circle', source: 'ci-set', filter: ['==', ['get', 'tier'], 'removed'], paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4.5, 16, 7], 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': pal.set, 'circle-stroke-width': 1.6, 'circle-stroke-opacity': 0.85,
      'circle-radius-transition': { duration: s.reduced ? 0 : 320 },
    } })
    map.addLayer({ id: 'ci-set', type: 'circle', source: 'ci-set', filter: ['in', ['get', 'tier'], ['literal', ['set', 'added']]], paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 5.2, 16, 8.5], 'circle-color': pal.set, 'circle-stroke-color': pal.surface, 'circle-stroke-width': 2,
      'circle-color-transition': { duration: s.reduced ? 0 : 320 }, 'circle-radius-transition': { duration: s.reduced ? 0 : 320 },
    } })
    map.addLayer({ id: 'ci-set-added', type: 'circle', source: 'ci-set', filter: ['==', ['get', 'tier'], 'added'], paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 8.4, 16, 12], 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': pal.added, 'circle-stroke-width': 1.5,
    } })
    map.addLayer({ id: 'ci-set-label', type: 'symbol', source: 'ci-set', minzoom: 12.6, filter: ['in', ['get', 'tier'], ['literal', ['set', 'added']]], layout: {
      'text-field': ['get', 'label'], 'text-size': 11, 'text-font': ['Open Sans Bold', 'Open Sans Semibold'], 'text-offset': [0, -1.45], 'text-allow-overlap': false, 'text-optional': true,
    }, paint: { 'text-color': pal.ink, 'text-halo-color': pal.halo, 'text-halo-width': 1.6 } })
  }
  if (!map.getSource('ci-focus')) {
    map.addSource('ci-focus', { type: 'geojson', data: empty })
    map.addLayer({ id: 'ci-focus', type: 'circle', source: 'ci-focus', paint: {
      'circle-radius': ['case', ['==', ['get', 'kind'], 'selected'], 15, 13], 'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': pal.ring, 'circle-stroke-width': ['case', ['==', ['get', 'kind'], 'selected'], 2.4, 1.6], 'circle-stroke-opacity': 0.95,
    } })
  }
  paintForMode(map, s.mode, s.domain, pal, rampFor(s.theme === 'light' && !s.imagery ? 'light' : 'dark'))
  return cluster
}

function installBackground(map: maplibregl.Map, s: Latest, cluster: boolean, pal: MapPalette) {
  for (const id of ['ci-bg-cluster-count', 'ci-bg-cluster', 'ci-bg-x', 'ci-bg-excluded', 'ci-bg-candidate', 'ci-bg-label']) if (map.getLayer(id)) map.removeLayer(id)
  if (map.getSource('ci-bg')) map.removeSource('ci-bg')
  map.addSource('ci-bg', {
    type: 'geojson',
    data: collection(s.points, ['candidate', 'excluded']),
    promoteId: 'key',
    ...(cluster ? { cluster: true, clusterMaxZoom: 13, clusterRadius: 34, clusterMinPoints: 5 } : {}),
  })
  const beforeSet = map.getLayer('ci-set-flag') ? 'ci-set-flag' : undefined
  const unclustered: maplibregl.FilterSpecification = ['!', ['has', 'point_count']]
  if (cluster) {
    map.addLayer({ id: 'ci-bg-cluster', type: 'circle', source: 'ci-bg', filter: ['has', 'point_count'], paint: {
      'circle-radius': ['step', ['get', 'point_count'], 11, 10, 14, 30, 18], 'circle-color': pal.cand, 'circle-opacity': 0.28,
      'circle-stroke-color': pal.cand, 'circle-stroke-width': 1, 'circle-stroke-opacity': 0.65,
    } }, beforeSet)
    map.addLayer({ id: 'ci-bg-cluster-count', type: 'symbol', source: 'ci-bg', filter: ['has', 'point_count'], layout: {
      'text-field': ['get', 'point_count_abbreviated'], 'text-size': 10.5, 'text-font': ['Open Sans Bold', 'Open Sans Semibold'], 'text-allow-overlap': true,
    }, paint: { 'text-color': pal.ink } }, beforeSet)
  }
  map.addLayer({ id: 'ci-bg-excluded', type: 'circle', source: 'ci-bg', filter: ['all', unclustered, ['==', ['get', 'tier'], 'excluded']], paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2.4, 16, 4.6], 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': pal.excl, 'circle-stroke-width': 1.1, 'circle-stroke-opacity': 0.75,
  } }, beforeSet)
  map.addLayer({ id: 'ci-bg-x', type: 'symbol', source: 'ci-bg', minzoom: 14.5, filter: ['all', unclustered, ['==', ['get', 'tier'], 'excluded']], layout: {
    'text-field': '×', 'text-size': 11, 'text-font': ['Open Sans Bold', 'Open Sans Semibold'], 'text-allow-overlap': true,
  }, paint: { 'text-color': pal.excl } }, beforeSet)
  map.addLayer({ id: 'ci-bg-candidate', type: 'circle', source: 'ci-bg', filter: ['all', unclustered, ['==', ['get', 'tier'], 'candidate']], paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2.6, 16, 5], 'circle-color': pal.cand, 'circle-opacity': 0.92, 'circle-stroke-color': pal.surface, 'circle-stroke-width': 1,
    'circle-color-transition': { duration: s.reduced ? 0 : 320 },
  } }, beforeSet)
  map.addLayer({ id: 'ci-bg-label', type: 'symbol', source: 'ci-bg', minzoom: 15.4, filter: ['all', unclustered, ['==', ['get', 'tier'], 'candidate']], layout: {
    'text-field': ['get', 'label'], 'text-size': 10, 'text-font': ['Open Sans Semibold', 'Open Sans Regular'], 'text-offset': [0, -1.2], 'text-allow-overlap': false, 'text-optional': true,
  }, paint: { 'text-color': pal.ink, 'text-opacity': 0.72, 'text-halo-color': pal.halo, 'text-halo-width': 1.3 } }, beforeSet)
}

function paintForMode(map: maplibregl.Map, mode: MapMode, domain: [number, number] | null, pal: MapPalette, ramp: string[]) {
  if (map.getLayer('ci-set')) map.setPaintProperty('ci-set', 'circle-color', colorExpression(mode, pal.set, pal, ramp, domain))
  if (map.getLayer('ci-bg-candidate')) map.setPaintProperty('ci-bg-candidate', 'circle-color', colorExpression(mode, pal.cand, pal, ramp, domain))
}
