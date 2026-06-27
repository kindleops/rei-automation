/**
 * Comp Intelligence V4 — persistent spatial evidence map.
 *
 * The map initializes ONCE per mount and is never torn down on ordinary state
 * changes (data, selection, hover, radius). Style switches use `setStyle`; the
 * radius layer + markers are re-applied incrementally.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { V4Evidence, V4Subject } from '../state/types'
import type { MapStyleMode } from '../hooks/useCompV4Search'
import { boundsOf, isValidCoord, radiusCircleGeoJson } from '../adapters/geo'
import { fmtMoneyShort } from '../adapters/format'

interface EvidenceMapPaneProps {
  subject: V4Subject
  evidence: V4Evidence[]
  radiusMiles: number
  mapStyle: MapStyleMode
  isLightTheme: boolean
  selectedId: string | null
  hoveredId: string | null
  showExcluded: boolean
  onSelect: (id: string) => void
  onHover: (id: string | null) => void
  onOpenDossier: (id: string) => void
}

const LIGHT_STREET = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
const DARK_STREET = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
const ESRI_IMAGERY =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
function styleFor(mode: MapStyleMode, isLight: boolean): string | maplibregl.StyleSpecification {
  if (mode === 'street') return isLight ? LIGHT_STREET : DARK_STREET
  // satellite + hybrid both use raster imagery; hybrid overlays labels.
  const raster: maplibregl.StyleSpecification = {
    version: 8,
    glyphs: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/{fontstack}/{range}.pbf',
    sources: {
      esri: {
        type: 'raster',
        tiles: [ESRI_IMAGERY],
        tileSize: 256,
        attribution: 'Esri',
      },
    },
    layers: [{ id: 'esri', type: 'raster', source: 'esri' }],
  }
  return raster
}

const RADIUS_SOURCE = 'v4-radius'
const RADIUS_FILL = 'v4-radius-fill'
const RADIUS_LINE = 'v4-radius-line'

const STATE_COLOR: Record<string, string> = {
  qualified: '#34d399',
  candidate: '#60a5fa',
  review: '#fbbf24',
  demand_only: '#a78bfa',
  excluded: '#f87171',
}

export function EvidenceMapPane(props: EvidenceMapPaneProps) {
  const {
    subject,
    evidence,
    radiusMiles,
    mapStyle,
    isLightTheme,
    selectedId,
    hoveredId,
    showExcluded,
    onSelect,
    onHover,
    onOpenDossier,
  } = props

  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map())
  const subjectMarkerRef = useRef<maplibregl.Marker | null>(null)
  const readyRef = useRef(false)
  // Promoted to state so marker/radius effects re-run once the map's `load`
  // event fires (which can land AFTER evidence has already arrived).
  const [ready, setReady] = useState(false)

  const accent = useMemo(() => {
    if (typeof window === 'undefined') return '#38d0f0'
    return getComputedStyle(document.documentElement).getPropertyValue('--nx-accent').trim() || '#38d0f0'
  }, [])

  // Stable handler refs so effects don't re-init the map.
  const handlers = useRef({ onSelect, onHover, onOpenDossier })
  handlers.current = { onSelect, onHover, onOpenDossier }

  // ── init once ──────────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current
    if (!container || mapRef.current) return

    const center: [number, number] = subject.coord
      ? [subject.coord.lng, subject.coord.lat]
      : [-98.5, 39.5]
    const map = new maplibregl.Map({
      container,
      style: styleFor(mapStyle, isLightTheme),
      center,
      zoom: subject.coord ? 13 : 4,
      attributionControl: false,
      pitchWithRotate: false,
      dragRotate: false,
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left')
    mapRef.current = map
    map.on('load', () => {
      readyRef.current = true
      setReady(true)
    })
    return () => {
      readyRef.current = false
      setReady(false)
      markersRef.current.forEach((m) => m.remove())
      markersRef.current.clear()
      subjectMarkerRef.current?.remove()
      subjectMarkerRef.current = null
      map.remove()
      mapRef.current = null
    }
    // Init must run exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── style switch ─────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !readyRef.current) return
    map.setStyle(styleFor(mapStyle, isLightTheme))
    map.once('styledata', () => {
      applyRadius(map, subject, radiusMiles, accent)
      renderMarkers()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapStyle, isLightTheme])

  // ── radius / center on subject or radius change ──────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    applyRadius(map, subject, radiusMiles, accent)
    if (subject.coord) {
      map.easeTo({ center: [subject.coord.lng, subject.coord.lat], duration: 500 })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, subject.propertyId, subject.coord?.lat, subject.coord?.lng, radiusMiles])

  // ── markers on evidence / selection / hover / filter change ──────────────
  useEffect(() => {
    if (!ready) return
    renderMarkers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, evidence, selectedId, hoveredId, showExcluded])

  function renderMarkers() {
    const map = mapRef.current
    if (!map) return

    // subject marker
    if (subject.coord) {
      const el = subjectMarkerRef.current?.getElement() ?? document.createElement('div')
      el.className = 'civ4-marker civ4-marker--subject'
      el.innerHTML = '<span class="civ4-marker__star">★</span>'
      if (!subjectMarkerRef.current) {
        subjectMarkerRef.current = new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat([subject.coord.lng, subject.coord.lat])
          .addTo(map)
      } else {
        subjectMarkerRef.current.setLngLat([subject.coord.lng, subject.coord.lat])
      }
    }

    const visible = evidence.filter(
      (e) => isValidCoord(e.coord) && (e.state !== 'excluded' || showExcluded),
    )
    const nextIds = new Set(visible.map((e) => e.id))

    // remove stale
    for (const [id, marker] of markersRef.current.entries()) {
      if (!nextIds.has(id)) {
        marker.remove()
        markersRef.current.delete(id)
      }
    }

    for (const item of visible) {
      const isSelected = item.id === selectedId
      const isHovered = item.id === hoveredId
      let marker = markersRef.current.get(item.id)
      const el = marker?.getElement() ?? document.createElement('div')
      el.className = [
        'civ4-marker',
        `civ4-marker--${item.state}`,
        isSelected ? 'is-selected' : '',
        isHovered ? 'is-hovered' : '',
      ]
        .filter(Boolean)
        .join(' ')
      el.style.setProperty('--marker-color', STATE_COLOR[item.state] ?? '#9aa')
      el.innerHTML = `<span class="civ4-marker__price">${fmtMoneyShort(item.salePrice)}</span>`
      el.onmouseenter = () => handlers.current.onHover(item.id)
      el.onmouseleave = () => handlers.current.onHover(null)
      el.onclick = (evt) => {
        evt.stopPropagation()
        handlers.current.onSelect(item.id)
        handlers.current.onOpenDossier(item.id)
      }
      if (!marker) {
        marker = new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat([item.coord!.lng, item.coord!.lat])
          .addTo(map)
        markersRef.current.set(item.id, marker)
      } else {
        marker.setLngLat([item.coord!.lng, item.coord!.lat])
      }
    }
  }

  return (
    <div className="civ4-map">
      <div ref={containerRef} className="civ4-map__canvas" />
      <MapControls
        mapRef={mapRef}
        subject={subject}
        evidence={evidence}
        showExcluded={showExcluded}
      />
      <div className="civ4-map__legend" role="note" aria-label="Map legend">
        <span className="civ4-legend__item"><i className="civ4-dot civ4-dot--subject" />Subject</span>
        <span className="civ4-legend__item"><i className="civ4-dot civ4-dot--qualified" />Qualified</span>
        <span className="civ4-legend__item"><i className="civ4-dot civ4-dot--review" />Review</span>
        <span className="civ4-legend__item"><i className="civ4-dot civ4-dot--excluded" />Excluded</span>
      </div>
    </div>
  )
}

function applyRadius(
  map: maplibregl.Map,
  subject: V4Subject,
  radiusMiles: number,
  accent: string,
) {
  if (!subject.coord) return
  const data = radiusCircleGeoJson(subject.coord, radiusMiles)
  const existing = map.getSource(RADIUS_SOURCE) as maplibregl.GeoJSONSource | undefined
  if (existing) {
    existing.setData(data as GeoJSON.Feature)
    return
  }
  map.addSource(RADIUS_SOURCE, { type: 'geojson', data: data as GeoJSON.Feature })
  map.addLayer({
    id: RADIUS_FILL,
    type: 'fill',
    source: RADIUS_SOURCE,
    paint: { 'fill-color': accent, 'fill-opacity': 0.08 },
  })
  map.addLayer({
    id: RADIUS_LINE,
    type: 'line',
    source: RADIUS_SOURCE,
    paint: { 'line-color': accent, 'line-width': 1.5, 'line-opacity': 0.7 },
  })
}

function MapControls(props: {
  mapRef: React.MutableRefObject<maplibregl.Map | null>
  subject: V4Subject
  evidence: V4Evidence[]
  showExcluded: boolean
}) {
  const { mapRef, subject, evidence, showExcluded } = props

  const recenter = () => {
    const map = mapRef.current
    if (!map || !subject.coord) return
    map.easeTo({ center: [subject.coord.lng, subject.coord.lat], zoom: 13, duration: 500 })
  }
  const fit = (states: string[]) => {
    const map = mapRef.current
    if (!map) return
    const coords = evidence
      .filter((e) => states.includes(e.state) && (e.state !== 'excluded' || showExcluded))
      .map((e) => e.coord!)
      .filter(Boolean)
    if (subject.coord) coords.push(subject.coord)
    const b = boundsOf(coords)
    if (b) map.fitBounds(b, { padding: 80, maxZoom: 15, duration: 500 })
  }

  return (
    <div className="civ4-map__controls">
      <button type="button" className="civ4-mapbtn" onClick={recenter} title="Recenter on subject">
        ⌖
      </button>
      <button
        type="button"
        className="civ4-mapbtn"
        onClick={() => fit(['qualified'])}
        title="Fit qualified comps"
      >
        ◎
      </button>
      <button
        type="button"
        className="civ4-mapbtn"
        onClick={() => fit(['qualified', 'review', 'excluded'])}
        title="Fit all evidence"
      >
        ⤢
      </button>
    </div>
  )
}
