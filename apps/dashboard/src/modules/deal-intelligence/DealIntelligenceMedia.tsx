import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { buildAerialViewUrl, buildStreetViewUrl } from '../../domain/inbox/inbox-normalization'
import { getCommandMapThemeStyle } from '../../views/map/commandMapThemes'
import { getGoogleMapsApiKey } from '../../lib/maps/loadGoogleMaps'
import { InteractiveStreetViewPanorama } from './InteractiveStreetViewPanorama'

export type MediaTab = 'street' | 'aerial'
export type StreetMode = 'interactive' | 'embed' | 'static' | 'unavailable' | 'loading'
export type AerialMode = 'interactive' | 'static' | 'unavailable' | 'loading'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

export function buildInteractiveStreetViewUrl({
  address,
  lat,
  lng,
}: {
  address?: string | null
  lat?: number | null
  lng?: number | null
}) {
  const apiKey = getGoogleMapsApiKey()
  if (!apiKey) return null
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(Number(lat)) > 0.0001 && Math.abs(Number(lng)) > 0.0001
  const location = hasCoords ? `${lat},${lng}` : address
  if (!location) return null
  const params = new URLSearchParams({
    key: apiKey,
    location,
    heading: '210',
    pitch: '2',
    fov: '85',
  })
  return `https://www.google.com/maps/embed/v1/streetview?${params.toString()}`
}

interface DealIntelligenceMediaProps {
  activeTab: MediaTab
  address?: string | null
  lat?: number | null
  lng?: number | null
  streetStoredUrl?: string | null
  aerialStoredUrl?: string | null
}

const AerialMap = ({
  lat,
  lng,
  visible,
}: {
  lat: number
  lng: number
  visible: boolean
}) => {
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
    mapRef.current?.resize()
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
  address,
  lat,
  lng,
  streetStoredUrl,
  aerialStoredUrl,
}: DealIntelligenceMediaProps) => {
  const [streetMode, setStreetMode] = useState<StreetMode>('loading')
  const [aerialMode, setAerialMode] = useState<AerialMode>('loading')
  const [streetStaticFailed, setStreetStaticFailed] = useState(false)
  const [aerialStaticFailed, setAerialStaticFailed] = useState(false)

  const streetEmbedUrl = useMemo(
    () => buildInteractiveStreetViewUrl({ address, lat, lng }),
    [address, lat, lng],
  )
  const staticStreetUrl = useMemo(
    () => buildStreetViewUrl(address ?? null, lat, lng),
    [address, lat, lng],
  )
  const staticAerialUrl = useMemo(
    () => buildAerialViewUrl(address ?? null, lat, lng),
    [address, lat, lng],
  )
  const resolvedStreetImage = streetStoredUrl || staticStreetUrl

  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(Number(lat)) > 0.0001
  const canUseInteractiveStreet = Boolean(getGoogleMapsApiKey() && (hasCoords || address?.trim()))

  useEffect(() => {
    setStreetStaticFailed(false)
    if (canUseInteractiveStreet) {
      setStreetMode('interactive')
      return
    }
    if (streetEmbedUrl) {
      setStreetMode('embed')
      return
    }
    if ((streetStoredUrl || staticStreetUrl) && !streetStaticFailed) {
      setStreetMode('static')
      return
    }
    setStreetMode('unavailable')
  }, [canUseInteractiveStreet, streetEmbedUrl, streetStaticFailed, streetStoredUrl, staticStreetUrl])

  useEffect(() => {
    setAerialStaticFailed(false)
    if (hasCoords) {
      setAerialMode('interactive')
      return
    }
    if ((aerialStoredUrl || staticAerialUrl) && !aerialStaticFailed) {
      setAerialMode('static')
      return
    }
    setAerialMode('unavailable')
  }, [aerialStoredUrl, aerialStaticFailed, hasCoords, staticAerialUrl])

  const handlePanoramaFailure = () => {
    if (streetEmbedUrl) {
      setStreetMode('embed')
      return
    }
    if ((streetStoredUrl || staticStreetUrl) && !streetStaticFailed) {
      setStreetMode('static')
      return
    }
    setStreetMode('unavailable')
  }

  const renderStreetPane = () => {
    if (streetMode === 'loading') return <div className="nx-di25-media__state">Loading Street View…</div>
    if (streetMode === 'interactive') {
      return (
        <InteractiveStreetViewPanorama
          address={address}
          lat={lat}
          lng={lng}
          visible
          onFailure={handlePanoramaFailure}
        />
      )
    }
    if (streetMode === 'embed' && streetEmbedUrl) {
      return (
        <iframe
          title="Interactive Street View"
          src={streetEmbedUrl}
          className="nx-di25-media__iframe"
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          allowFullScreen
        />
      )
    }
    if (streetMode === 'static' && resolvedStreetImage) {
      return (
        <img
          src={resolvedStreetImage}
          alt="Street View"
          className="nx-di25-media__img"
          loading="eager"
          decoding="async"
          onError={() => {
            setStreetStaticFailed(true)
            setStreetMode('unavailable')
          }}
        />
      )
    }
    return <div className="nx-di25-media__state">Street View unavailable</div>
  }

  const renderAerialPane = () => {
    if (aerialMode === 'loading') return <div className="nx-di25-media__state">Loading aerial…</div>
    if (aerialMode === 'interactive' && hasCoords) {
      return <AerialMap lat={Number(lat)} lng={Number(lng)} visible />
    }
    if (aerialMode === 'static' && (aerialStoredUrl || staticAerialUrl)) {
      return (
        <img
          src={aerialStoredUrl || staticAerialUrl || ''}
          alt="Aerial"
          className="nx-di25-media__img"
          onError={() => setAerialStaticFailed(true)}
        />
      )
    }
    return <div className="nx-di25-media__state">Aerial view unavailable</div>
  }

  return (
    <div className="nx-di25-media__surface">
      <div className="nx-di25-media__pane">
        {activeTab === 'street' ? renderStreetPane() : renderAerialPane()}
      </div>
    </div>
  )
}