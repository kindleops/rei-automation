import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { BuyerMatchV4Projection } from './buyer-match-v4.types'
import { fmtCurrency, humanDataState } from './formatters'

const SATELLITE_STYLE = {
  version: 8,
  sources: {
    satellite: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      attribution: 'Esri',
    },
  },
  layers: [{ id: 'satellite', type: 'raster', source: 'satellite' }],
} as maplibregl.StyleSpecification

interface Props {
  projection: BuyerMatchV4Projection | null
  selectedBuyerId: string | null
  selectedEventId: string | null
  onSelectEvent: (eventId: string, buyerId: string) => void
}

export function BuyerActivityMap({ projection, selectedBuyerId, selectedEventId, onSelectEvent }: Props) {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstance = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<maplibregl.Marker[]>([])

  const lat = projection?.subject.latitude ?? null
  const lng = projection?.subject.longitude ?? null
  const hasCoords = lat !== null && lng !== null && Math.abs(lat) > 0.01
  const dataState = projection?.market.dataState ?? 'NO_LOCAL_DATA'
  const events = projection?.purchaseEvents ?? []
  const mappable = events.filter((e) => e.latitude != null && e.longitude != null)
  const isPartial = dataState === 'PARTIAL'
  const noLocal = dataState === 'NO_LOCAL_DATA'

  useEffect(() => {
    if (!mapRef.current || !hasCoords || mapInstance.current) return
    const map = new maplibregl.Map({
      container: mapRef.current,
      style: SATELLITE_STYLE,
      center: [lng!, lat!],
      zoom: 12,
      attributionControl: false,
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left')
    const el = document.createElement('div')
    el.className = 'bmv4-subject-marker'
    new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([lng!, lat!]).addTo(map)
    mapInstance.current = map
    return () => {
      markersRef.current.forEach((m) => m.remove())
      markersRef.current = []
      map.remove()
      mapInstance.current = null
    }
  }, [hasCoords, lat, lng])

  useEffect(() => {
    if (!mapInstance.current) return
    markersRef.current.forEach((m) => m.remove())
    markersRef.current = []

    const filtered = selectedBuyerId
      ? mappable.filter((e) => e.buyerId === selectedBuyerId)
      : mappable

    for (const event of filtered.slice(0, 120)) {
      const el = document.createElement('button')
      el.type = 'button'
      el.className = `bmv4-event-pin${selectedEventId === event.eventId ? ' is-selected' : ''}`
      el.setAttribute('aria-label', `${event.address} ${fmtCurrency(event.purchasePrice)}`)
      el.addEventListener('click', () => onSelectEvent(event.eventId, event.buyerId))
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([event.longitude!, event.latitude!])
        .addTo(mapInstance.current!)
      markersRef.current.push(marker)
    }
  }, [mappable, selectedBuyerId, selectedEventId, onSelectEvent])

  if (!hasCoords) {
    return (
      <div className="bmv4-map bmv4-map--empty">
        <p className="bmv4-state bmv4-state--coords">{humanDataState('SUBJECT_COORDINATES_REQUIRED')}</p>
      </div>
    )
  }

  return (
    <div className="bmv4-map">
      <div ref={mapRef} className="bmv4-map__canvas" />
      {(isPartial || noLocal || mappable.length === 0) && (
        <div className="bmv4-map__banner">
          {noLocal
            ? 'Purchase activity unavailable — local buyer evidence is unavailable.'
            : mappable.length === 0
              ? 'Purchase activity unavailable — partial cache or no mapped events.'
              : humanDataState(dataState)}
        </div>
      )}
      <div className="bmv4-map__legend">
        <span><i className="bmv4-dot is-subject" /> Subject</span>
        <span><i className="bmv4-dot is-event" /> Buyer purchases ({mappable.length})</span>
      </div>
    </div>
  )
}