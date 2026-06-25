import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { CompTransactionEvidence } from '../../../domain/comp-intelligence/v3-types'
import type { EvidenceMapMode } from '../hooks/useCompEvidenceFilters'

interface Props {
  subjectLat: number
  subjectLng: number
  subjectAddress: string
  evidence: CompTransactionEvidence[]
  mapMode: EvidenceMapMode
  selectedId: string | null
  onSelect: (id: string) => void
}

const DARK_MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

function pinClass(row: CompTransactionEvidence): string {
  if (row.qualification_status === 'REJECTED' || row.qualification_status === 'QUARANTINED') return 'rejected'
  if (row.pricing_eligibility) return 'pricing'
  if (/retail/i.test(row.evidence_role || '')) return 'retail'
  if (/review/i.test(row.qualification_status)) return 'review'
  if (row.demand_eligibility && !row.pricing_eligibility) return 'demand'
  if (row.source_lineage?.identity_unresolved) return 'unresolved'
  return 'context'
}

export function EvidenceMap({
  subjectLat,
  subjectLng,
  subjectAddress,
  evidence,
  selectedId,
  onSelect,
}: Props) {
  const mapRef = useRef<HTMLDivElement | null>(null)
  const mapInstance = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<maplibregl.Marker[]>([])

  useEffect(() => {
    if (!mapRef.current) return
    if (mapInstance.current) {
      mapInstance.current.remove()
      mapInstance.current = null
    }

    const map = new maplibregl.Map({
      container: mapRef.current,
      style: DARK_MAP_STYLE,
      center: [subjectLng, subjectLat],
      zoom: 13,
      attributionControl: false,
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left')
    mapInstance.current = map

    map.on('load', () => {
      const subEl = document.createElement('div')
      subEl.className = 'ci-subject-pin'
      subEl.setAttribute('aria-label', `Subject: ${subjectAddress}`)
      subEl.textContent = '★'
      new maplibregl.Marker({ element: subEl }).setLngLat([subjectLng, subjectLat]).addTo(map)

      markersRef.current = []
      const clusters = new Map<string, CompTransactionEvidence>()
      for (const row of evidence) {
        const clusterId = row.transaction_cluster_id || row.candidate_id || ''
        if (!clusters.has(clusterId)) clusters.set(clusterId, row)
      }

      for (const row of clusters.values()) {
        const lat = row.geography.latitude
        const lng = row.geography.longitude
        if (lat == null || lng == null) continue
        const el = document.createElement('button')
        el.type = 'button'
        el.className = `ci-comp-pin ci-comp-pin--${pinClass(row)} ${selectedId === row.candidate_id ? 'is-selected' : ''}`
        el.setAttribute('aria-label', row.address || 'Comp')
        el.onclick = () => onSelect(row.candidate_id || '')
        const marker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map)
        markersRef.current.push(marker)
      }
    })

    return () => {
      markersRef.current = []
      map.remove()
      mapInstance.current = null
    }
  }, [evidence, subjectAddress, subjectLat, subjectLng, selectedId, onSelect])

  return <div ref={mapRef} className="ci-evidence-map" role="application" aria-label="Transaction evidence map" />
}