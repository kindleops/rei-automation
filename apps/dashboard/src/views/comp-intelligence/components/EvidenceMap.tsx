import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { CompTransactionEvidence } from '../../../domain/comp-intelligence/v3-types'
import { fmtK, isValidCoord, makeRadiusGeoJson } from '../utils/mapGeo'

export type MapPinTone =
  | 'subject'
  | 'pricing'
  | 'retail'
  | 'demand'
  | 'review'
  | 'rejected'
  | 'context'
  | 'package'
  | 'degraded'

interface Props {
  subjectLat: number | null
  subjectLng: number | null
  subjectAddress: string
  evidence: CompTransactionEvidence[]
  radiusMiles: number
  selectedId: string | null
  hoveredId: string | null
  loading?: boolean
  onSelect: (id: string) => void
  onHover: (id: string | null) => void
  onStyleError?: () => void
  onReady?: () => void
  fitBoundsToken?: number
}

const DARK_MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

function pinTone(row: CompTransactionEvidence): MapPinTone {
  if (row.evidence_authority === 'DEGRADED_NON_AUTHORITATIVE') return 'degraded'
  if (row.package_probability != null && row.package_probability > 0.5) return 'package'
  if (row.qualification_status === 'REJECTED' || row.qualification_status === 'QUARANTINED') return 'rejected'
  if (row.pricing_eligibility) {
    if (/retail|arv/i.test(row.evidence_role || '') || /RETAIL/i.test(row.routed_universe || '')) return 'retail'
    if (/institutional|demand/i.test(row.evidence_role || '') && !row.pricing_eligibility) return 'demand'
    return 'pricing'
  }
  if (row.demand_eligibility) return 'demand'
  if (/review/i.test(row.qualification_status)) return 'review'
  if (row.source_lineage?.identity_unresolved) return 'context'
  return 'context'
}

function markerId(row: CompTransactionEvidence): string {
  return String(row.candidate_id || row.property_id || row.transaction_cluster_id || row.address || '')
}

function computeMapCenter(
  subjectLat: number | null,
  subjectLng: number | null,
  evidence: CompTransactionEvidence[],
): [number, number] {
  if (isValidCoord(subjectLat, subjectLng)) return [subjectLng!, subjectLat!]
  const coords = evidence
    .map((row) => {
      const lat = row.geography.latitude
      const lng = row.geography.longitude
      return isValidCoord(lat, lng) ? [lng!, lat!] as [number, number] : null
    })
    .filter(Boolean) as [number, number][]
  if (!coords.length) return [-80.05, 26.6]
  const avgLng = coords.reduce((sum, [lng]) => sum + lng, 0) / coords.length
  const avgLat = coords.reduce((sum, [, lat]) => sum + lat, 0) / coords.length
  return [avgLng, avgLat]
}

export function EvidenceMap({
  subjectLat,
  subjectLng,
  subjectAddress,
  evidence,
  radiusMiles,
  selectedId,
  hoveredId,
  loading = false,
  onSelect,
  onHover,
  onStyleError,
  onReady,
  fitBoundsToken = 0,
}: Props) {
  const mapRef = useRef<HTMLDivElement | null>(null)
  const mapInstanceRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map())
  const subjectMarkerRef = useRef<maplibregl.Marker | null>(null)
  const [mapReady, setMapReady] = useState(false)

  const hasSubjectPin = isValidCoord(subjectLat, subjectLng)
  const mapCenter = useMemo(
    () => computeMapCenter(subjectLat, subjectLng, evidence),
    [subjectLat, subjectLng, evidence],
  )
  const canMountMap = hasSubjectPin || evidence.some((row) =>
    isValidCoord(row.geography.latitude, row.geography.longitude),
  )

  const fitAllBounds = useCallback(() => {
    const map = mapInstanceRef.current
    if (!map || !mapReady) return
    const bounds = new maplibregl.LngLatBounds()
    if (hasSubjectPin) bounds.extend([subjectLng!, subjectLat!])
    for (const row of evidence) {
      const lat = row.geography.latitude
      const lng = row.geography.longitude
      if (isValidCoord(lat, lng)) bounds.extend([lng!, lat!])
    }
    if (bounds.isEmpty()) return
    map.fitBounds(bounds, { padding: 56, maxZoom: 15, duration: 450 })
  }, [evidence, mapReady, hasSubjectPin, subjectLat, subjectLng])

  useEffect(() => {
    if (!mapRef.current || !canMountMap) return undefined

    const container = mapRef.current
    const { offsetWidth, offsetHeight } = container
    if (offsetWidth < 2 || offsetHeight < 2) return undefined

    const [centerLng, centerLat] = mapCenter
    const map = new maplibregl.Map({
      container,
      style: DARK_MAP_STYLE,
      center: [centerLng, centerLat],
      zoom: hasSubjectPin ? 14 : 12,
      attributionControl: false,
      pitchWithRotate: false,
    })

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left')
    map.on('error', (event) => {
      if (event?.error?.message) onStyleError?.()
    })

    map.on('load', () => {
      if (hasSubjectPin) {
        const subEl = document.createElement('div')
        subEl.className = 'ci-subject-pin'
        subEl.setAttribute('aria-label', `Subject: ${subjectAddress}`)
        subEl.textContent = '★'
        subjectMarkerRef.current = new maplibregl.Marker({ element: subEl })
          .setLngLat([subjectLng!, subjectLat!])
          .addTo(map)

        map.addSource('ci-radius', { type: 'geojson', data: makeRadiusGeoJson([subjectLng!, subjectLat!], radiusMiles) })
        map.addLayer({ id: 'ci-radius-fill', type: 'fill', source: 'ci-radius', paint: { 'fill-color': 'rgba(59,130,246,0.05)' } })
        map.addLayer({ id: 'ci-radius-line', type: 'line', source: 'ci-radius', paint: { 'line-color': 'rgba(59,130,246,0.45)', 'line-width': 1.5, 'line-dasharray': [4, 3] } })
      }
      setMapReady(true)
      onReady?.()
      requestAnimationFrame(() => map.resize())
    })

    mapInstanceRef.current = map

    const observer = new ResizeObserver(() => {
      if (mapInstanceRef.current) mapInstanceRef.current.resize()
    })
    observer.observe(container)

    return () => {
      observer.disconnect()
      markersRef.current.forEach((marker) => marker.remove())
      markersRef.current.clear()
      subjectMarkerRef.current?.remove()
      subjectMarkerRef.current = null
      setMapReady(false)
      map.remove()
      mapInstanceRef.current = null
    }
  }, [mapCenter, hasSubjectPin, subjectLat, subjectLng, subjectAddress, onReady, onStyleError, canMountMap, radiusMiles])

  useEffect(() => {
    if (!mapReady) return
    fitAllBounds()
  }, [mapReady, fitBoundsToken, fitAllBounds])

  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !mapReady || !hasSubjectPin) return
    const source = map.getSource('ci-radius') as maplibregl.GeoJSONSource | undefined
    source?.setData(makeRadiusGeoJson([subjectLng!, subjectLat!], radiusMiles))
  }, [radiusMiles, mapReady, hasSubjectPin, subjectLat, subjectLng])

  useEffect(() => {
    const el = subjectMarkerRef.current?.getElement()
    if (el) el.classList.toggle('is-scanning', loading)
  }, [loading])

  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !mapReady) return

    markersRef.current.forEach((marker) => marker.remove())
    markersRef.current.clear()

    const clusters = new Map<string, CompTransactionEvidence>()
    for (const row of evidence) {
      const clusterId = row.transaction_cluster_id || markerId(row)
      if (!clusters.has(clusterId)) clusters.set(clusterId, row)
    }

    for (const row of clusters.values()) {
      const lat = row.geography.latitude
      const lng = row.geography.longitude
      if (!isValidCoord(lat, lng)) continue

      const id = markerId(row)
      const tone = pinTone(row)
      const el = document.createElement('button')
      el.type = 'button'
      el.className = [
        'ci-comp-pin',
        `ci-comp-pin--${tone}`,
        selectedId === id ? 'is-selected' : '',
        hoveredId === id ? 'is-hovered' : '',
        row.package_probability != null && row.package_probability > 0.5 ? 'is-package' : '',
      ].filter(Boolean).join(' ')
      el.setAttribute('aria-label', `${row.address ?? 'Comp'}: ${fmtK(row.sale_price)}`)
      el.innerHTML = `<span>${row.sale_price ? fmtK(row.sale_price) : tone === 'package' ? 'PKG' : '—'}</span>`
      el.addEventListener('mouseenter', () => onHover(id))
      el.addEventListener('mouseleave', () => onHover(null))
      el.addEventListener('click', (event) => {
        event.stopPropagation()
        onSelect(id)
      })

      const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([lng!, lat!])
        .addTo(map)
      markersRef.current.set(id, marker)
    }

    if (fitBoundsToken > 0) fitAllBounds()
  }, [evidence, mapReady, selectedId, hoveredId, onHover, onSelect, fitBoundsToken, fitAllBounds])

  useEffect(() => {
    if (!mapReady) return
    const map = mapInstanceRef.current
    if (!map) return
    requestAnimationFrame(() => map.resize())
  }, [mapReady, fitBoundsToken])

  return <div ref={mapRef} className="ci-map-canvas" role="application" aria-label="Transaction evidence map" />
}