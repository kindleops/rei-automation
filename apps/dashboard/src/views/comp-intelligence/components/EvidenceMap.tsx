import { useCallback, useEffect, useRef, useState } from 'react'
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

function evidenceSignature(rows: CompTransactionEvidence[]): string {
  return rows
    .map((row) => {
      const id = markerId(row)
      const lat = row.geography.latitude
      const lng = row.geography.longitude
      return `${id}:${lat ?? ''}:${lng ?? ''}:${row.sale_price ?? ''}`
    })
    .sort()
    .join('|')
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
  fitBoundsToken = 0,
}: Props) {
  const mapRef = useRef<HTMLDivElement | null>(null)
  const mapInstanceRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<Map<string, { marker: maplibregl.Marker; row: CompTransactionEvidence }>>(new Map())
  const subjectMarkerRef = useRef<maplibregl.Marker | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const initialFitDoneRef = useRef(false)
  const lastFitTokenRef = useRef(fitBoundsToken)
  const evidenceSigRef = useRef('')

  const onSelectRef = useRef(onSelect)
  const onHoverRef = useRef(onHover)
  const onStyleErrorRef = useRef(onStyleError)
  onSelectRef.current = onSelect
  onHoverRef.current = onHover
  onStyleErrorRef.current = onStyleError

  const hasSubjectPin = isValidCoord(subjectLat, subjectLng)
  const canMountMap = hasSubjectPin || evidence.some((row) =>
    isValidCoord(row.geography.latitude, row.geography.longitude),
  )
  const mapBootKey = `${subjectLat ?? 'na'}:${subjectLng ?? 'na'}`

  const fitAllBounds = useCallback((animate = true) => {
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
    map.fitBounds(bounds, {
      padding: 56,
      maxZoom: 15,
      duration: animate ? 450 : 0,
    })
  }, [evidence, mapReady, hasSubjectPin, subjectLat, subjectLng])

  useEffect(() => {
    if (!mapRef.current || !canMountMap) return undefined

    const container = mapRef.current
    const { offsetWidth, offsetHeight } = container
    if (offsetWidth < 2 || offsetHeight < 2) return undefined

    initialFitDoneRef.current = false
    evidenceSigRef.current = ''
    const [centerLng, centerLat] = computeMapCenter(subjectLat, subjectLng, evidence)

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
      if (event?.error?.message) onStyleErrorRef.current?.()
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
      requestAnimationFrame(() => map.resize())
    })

    mapInstanceRef.current = map

    const observer = new ResizeObserver(() => {
      mapInstanceRef.current?.resize()
    })
    observer.observe(container)

    return () => {
      observer.disconnect()
      markersRef.current.forEach(({ marker }) => marker.remove())
      markersRef.current.clear()
      subjectMarkerRef.current?.remove()
      subjectMarkerRef.current = null
      setMapReady(false)
      map.remove()
      mapInstanceRef.current = null
    }
  // Remount only when subject anchor changes or map becomes mountable from empty state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapBootKey, canMountMap])

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

    const signature = evidenceSignature(evidence)
    if (signature === evidenceSigRef.current) return
    evidenceSigRef.current = signature

    const clusters = new Map<string, CompTransactionEvidence>()
    for (const row of evidence) {
      const clusterId = row.transaction_cluster_id || markerId(row)
      if (!clusters.has(clusterId)) clusters.set(clusterId, row)
    }

    const nextIds = new Set<string>()
    for (const row of clusters.values()) {
      const lat = row.geography.latitude
      const lng = row.geography.longitude
      if (!isValidCoord(lat, lng)) continue

      const id = markerId(row)
      nextIds.add(id)
      const existing = markersRef.current.get(id)
      if (existing) {
        existing.row = row
        existing.marker.setLngLat([lng!, lat!])
        continue
      }

      const tone = pinTone(row)
      const el = document.createElement('button')
      el.type = 'button'
      el.className = `ci-comp-pin ci-comp-pin--${tone}`
      el.setAttribute('aria-label', `${row.address ?? 'Comp'}: ${fmtK(row.sale_price)}`)
      el.innerHTML = `<span>${row.sale_price ? fmtK(row.sale_price) : tone === 'package' ? 'PKG' : '—'}</span>`
      el.addEventListener('mouseenter', () => onHoverRef.current(id))
      el.addEventListener('mouseleave', () => onHoverRef.current(null))
      el.addEventListener('click', (event) => {
        event.stopPropagation()
        onSelectRef.current(id)
      })

      const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([lng!, lat!])
        .addTo(map)
      markersRef.current.set(id, { marker, row })
    }

    for (const [id, entry] of markersRef.current.entries()) {
      if (!nextIds.has(id)) {
        entry.marker.remove()
        markersRef.current.delete(id)
      }
    }

    if (!initialFitDoneRef.current && nextIds.size > 0) {
      initialFitDoneRef.current = true
      fitAllBounds(true)
    }
  }, [evidence, mapReady, fitAllBounds])

  useEffect(() => {
    for (const [id, entry] of markersRef.current.entries()) {
      const el = entry.marker.getElement()
      if (!el) continue
      const tone = pinTone(entry.row)
      el.className = [
        'ci-comp-pin',
        `ci-comp-pin--${tone}`,
        selectedId === id ? 'is-selected' : '',
        hoveredId === id ? 'is-hovered' : '',
        entry.row.package_probability != null && entry.row.package_probability > 0.5 ? 'is-package' : '',
      ].filter(Boolean).join(' ')
    }
  }, [selectedId, hoveredId])

  useEffect(() => {
    if (!mapReady) return
    if (fitBoundsToken === lastFitTokenRef.current) return
    lastFitTokenRef.current = fitBoundsToken
    fitAllBounds(true)
  }, [fitBoundsToken, mapReady, fitAllBounds])

  useEffect(() => {
    if (!mapReady) return
    const map = mapInstanceRef.current
    if (!map) return
    requestAnimationFrame(() => map.resize())
  }, [mapReady])

  return <div ref={mapRef} className="ci-map-canvas" role="application" aria-label="Transaction evidence map" />
}