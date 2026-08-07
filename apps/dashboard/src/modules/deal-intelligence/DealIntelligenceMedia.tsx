/**
 * Deal Intelligence media pane.
 *
 * This file used to be a second, independent Street View implementation with
 * its own URL builder, its own mode state machine, and its own failure
 * handling. It is now a thin adapter over the single shared viewer
 * (`shared/media`), keeping only what is genuinely Deal-Intelligence-specific:
 * the interactive maplibre satellite map used for the aerial pane.
 */
import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { PropertyMediaViewer } from '../../shared/media/PropertyMediaViewer'
import { getCommandMapThemeStyle } from '../../views/map/commandMapThemes'

export type MediaTab = 'street' | 'aerial'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

interface DealIntelligenceMediaProps {
  activeTab: MediaTab
  propertyId?: string | number | null
  address?: string | null
  lat?: number | null
  lng?: number | null
  streetStoredUrl?: string | null
  aerialStoredUrl?: string | null
}

/**
 * Interactive satellite map. Keyed on coordinates by the caller, so switching
 * tabs or resizing the pane resizes the existing map rather than rebuilding it.
 */
const AerialMap = ({ lat, lng, visible }: { lat: number; lng: number; visible: boolean }) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markerRef = useRef<maplibregl.Marker | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: getCommandMapThemeStyle('satellite'),
      center: [lng, lat],
      zoom: 18,
      attributionControl: false,
      interactive: true,
      dragRotate: false,
      pitchWithRotate: false,
      touchZoomRotate: true,
    })
    markerRef.current = new maplibregl.Marker({ color: '#5096f5' }).setLngLat([lng, lat]).addTo(map)
    map.on('load', () => setReady(true))
    mapRef.current = map
    return () => {
      markerRef.current?.remove()
      map.remove()
      mapRef.current = null
      markerRef.current = null
    }
  }, [lat, lng])

  useEffect(() => {
    if (visible) mapRef.current?.resize()
  }, [visible])

  const reset = () => {
    mapRef.current?.flyTo({ center: [lng, lat], zoom: 18, duration: 600 })
  }

  return (
    <div className={cls('nx-di25-aerial-stack', visible && 'is-visible', ready && 'is-ready')}>
      <div className={cls('nx-di25-aerial-map', visible && 'is-visible', ready && 'is-ready')}>
        <div ref={containerRef} className="nx-di25-aerial-map__canvas" />
      </div>
      <button type="button" className="nx-di25-aerial-map__reset" onClick={reset} title="Center property">
        Recenter map
      </button>
    </div>
  )
}

export const DealIntelligenceMedia = ({
  activeTab,
  propertyId,
  address,
  lat,
  lng,
  streetStoredUrl,
  aerialStoredUrl,
}: DealIntelligenceMediaProps) => (
  <div className="nx-di25-media__surface">
    <PropertyMediaViewer
      className="nx-di25-media__viewer"
      propertyId={propertyId}
      address={address}
      lat={lat}
      lng={lng}
      storedStreetUrl={streetStoredUrl}
      storedAerialUrl={aerialStoredUrl}
      activeTab={activeTab}
      showTabs={false}
      renderInteractiveAerial={({ lat: aLat, lng: aLng, visible }) => (
        <AerialMap lat={aLat} lng={aLng} visible={visible} />
      )}
    />
  </div>
)
