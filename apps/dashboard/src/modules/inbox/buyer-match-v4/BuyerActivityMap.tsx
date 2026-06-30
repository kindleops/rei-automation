import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { ActivityFilterState, BuyerMatchV4Projection, PurchaseEvent } from './buyer-match-v4.types'
import { filterPurchaseEvents } from './buyerFilters'
import { fmtCurrency, humanDataState } from './formatters'

const STYLES = {
  satellite: {
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
  },
  street: {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: 'OSM',
      },
    },
    layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
  },
  hybrid: {
    version: 8,
    sources: {
      satellite: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
      },
      labels: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
      },
    },
    layers: [
      { id: 'satellite', type: 'raster', source: 'satellite' },
      { id: 'labels', type: 'raster', source: 'labels' },
    ],
  },
} as Record<string, maplibregl.StyleSpecification>

const MAX_MARKERS = 200

interface Props {
  projection: BuyerMatchV4Projection | null
  events?: PurchaseEvent[]
  selectedBuyerId: string | null
  selectedEventId: string | null
  activityFilters?: ActivityFilterState
  onSelectEvent: (eventId: string, buyerId: string) => void
  onRecenter?: () => void
}

function familyId(e: PurchaseEvent): string {
  return e.buyerFamilyId ?? e.buyerId
}

export function BuyerActivityMap({
  projection,
  events: eventsOverride,
  selectedBuyerId,
  selectedEventId,
  activityFilters,
  onSelectEvent,
}: Props) {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstance = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<maplibregl.Marker[]>([])
  const [renderedCount, setRenderedCount] = useState(0)

  const lat = projection?.subject?.latitude ?? null
  const lng = projection?.subject?.longitude ?? null
  const hasCoords = lat !== null && lng !== null && Math.abs(lat) > 0.01
  const dataState = projection?.market?.dataState ?? 'NO_LOCAL_DATA'

  const institutionalIds = useMemo(
    () => new Set(
      (projection?.rankedBuyers ?? [])
        .filter((b) => b.institutionalStatus === 'VERIFIED_INSTITUTIONAL')
        .map((b) => b.buyerId),
    ),
    [projection?.rankedBuyers],
  )

  const events = useMemo(() => {
    if (eventsOverride) {
      return eventsOverride.filter((e) => e.latitude != null && e.longitude != null)
    }
    const all = projection?.purchaseEvents ?? []
    if (!activityFilters) return all.filter((e) => e.latitude != null && e.longitude != null)
    return filterPurchaseEvents(all, {
      periodDays: activityFilters.periodDays,
      buyerId: selectedBuyerId,
      institutionalBuyerIds: institutionalIds,
      institutionalOnly: activityFilters.institutionalOnly,
      localRegionalOnly: activityFilters.localRegionalOnly,
      singleAssetOnly: activityFilters.singleAssetOnly,
      packageOnly: activityFilters.packageOnly,
      pricingEligibleOnly: activityFilters.pricingEligibleOnly,
      demandOnly: activityFilters.demandOnly,
      nonMarketOnly: activityFilters.nonMarketOnly,
      unknownIdentityOnly: activityFilters.unknownIdentityOnly,
      buyerClass: activityFilters.buyerClass,
      radiusMiles: activityFilters.radiusMiles,
    }).filter((e) => e.latitude != null && e.longitude != null)
  }, [eventsOverride, projection?.purchaseEvents, activityFilters, selectedBuyerId, institutionalIds])

  const mapStyle = activityFilters?.mapStyle ?? 'satellite'

  useEffect(() => {
    if (!mapRef.current || !hasCoords) return
    if (mapInstance.current) {
      mapInstance.current.setStyle(STYLES[mapStyle] ?? STYLES.satellite)
      return
    }
    const map = new maplibregl.Map({
      container: mapRef.current,
      style: STYLES[mapStyle] ?? STYLES.satellite,
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
  }, [hasCoords, lat, lng, mapStyle])

  useEffect(() => {
    if (!mapInstance.current || !hasCoords) return
    markersRef.current.forEach((m) => m.remove())
    markersRef.current = []

    const displayEvents = selectedBuyerId
      ? events.filter((e) => familyId(e) === selectedBuyerId)
      : events

    const toRender = displayEvents.slice(0, MAX_MARKERS)
    setRenderedCount(toRender.length)

    for (const event of toRender) {
      const fid = familyId(event)
      const isInst = institutionalIds.has(fid)
      const isPackage = event.transactionScope !== 'SINGLE_ASSET'
      const isSelectedBuyer = selectedBuyerId === fid
      const isSelectedEvent = selectedEventId === event.eventId
      const el = document.createElement('button')
      el.type = 'button'
      el.className = [
        'bmv4-event-pin',
        isInst ? 'is-institutional' : 'is-local',
        isPackage ? 'is-package' : '',
        isSelectedBuyer ? 'is-buyer-selected' : '',
        isSelectedEvent ? ' is-selected' : '',
      ].filter(Boolean).join(' ')
      const price = event.pricingEligible
        ? fmtCurrency(event.propertyAllocatedConsideration ?? event.purchasePrice)
        : 'Demand evidence'
      el.setAttribute('aria-label', `${event.address} ${price}`)
      el.addEventListener('click', () => onSelectEvent(event.eventId, fid))
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([event.longitude!, event.latitude!])
        .addTo(mapInstance.current!)
      markersRef.current.push(marker)
    }
  }, [events, selectedBuyerId, selectedEventId, onSelectEvent, institutionalIds, hasCoords])

  const fitAll = useCallback(() => {
    if (!mapInstance.current || !hasCoords) return
    const bounds = new maplibregl.LngLatBounds([lng!, lat!], [lng!, lat!])
    for (const e of events.slice(0, 80)) {
      if (e.longitude != null && e.latitude != null) bounds.extend([e.longitude, e.latitude])
    }
    mapInstance.current.fitBounds(bounds, { padding: 48, maxZoom: 14 })
  }, [events, hasCoords, lat, lng])

  const recenter = useCallback(() => {
    mapInstance.current?.flyTo({ center: [lng!, lat!], zoom: 12 })
  }, [lat, lng])

  if (!hasCoords) {
    return (
      <div className="bmv4-map bmv4-map--empty">
        <p className="bmv4-state bmv4-state--coords">{humanDataState('SUBJECT_COORDINATES_REQUIRED')}</p>
      </div>
    )
  }

  return (
    <div className="bmv4-map">
      <div className="bmv4-map__toolbar">
        <button type="button" className="bmv4-btn is-ghost is-sm" onClick={fitAll}>Fit purchases</button>
        <button type="button" className="bmv4-btn is-ghost is-sm" onClick={recenter}>Recenter subject</button>
        <span className="bmv4-tabular">{renderedCount} markers · {events.length} geocoded</span>
      </div>
      <div ref={mapRef} className="bmv4-map__canvas" />
      {(dataState === 'PARTIAL' || dataState === 'NO_LOCAL_DATA') && (
        <div className="bmv4-map__banner">{humanDataState(dataState)}</div>
      )}
      <div className="bmv4-map__legend">
        <span><i className="bmv4-dot is-subject" /> Subject</span>
        <span><i className="bmv4-dot is-buyer" /> Selected buyer</span>
        <span><i className="bmv4-dot is-local" /> Local</span>
        <span><i className="bmv4-dot is-inst" /> Institutional</span>
        <span><i className="bmv4-dot is-package" /> Package</span>
        <span><i className="bmv4-dot is-event" /> Rendered ({renderedCount})</span>
      </div>
    </div>
  )
}