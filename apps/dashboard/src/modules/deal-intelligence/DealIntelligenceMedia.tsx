import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { getCommandMapThemeStyle } from '../../views/map/commandMapThemes'

const GOOGLE_MAPS_API_KEY =
  (import.meta.env as Record<string, string | undefined>).VITE_GOOGLE_MAPS_API_KEY
  || 'AIzaSyAhOk7KZkduU4qywmrlq5ZqSOtgktHYiFk'

export type MediaTab = 'street' | 'aerial'
export type StreetMode = 'interactive' | 'static' | 'unavailable' | 'loading'
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
  if (!GOOGLE_MAPS_API_KEY) return null
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(Number(lat)) > 0.0001 && Math.abs(Number(lng)) > 0.0001
  const location = hasCoords ? `${lat},${lng}` : address
  if (!location) return null
  const params = new URLSearchParams({
    key: GOOGLE_MAPS_API_KEY,
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
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
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
    <div className={cls('nx-di25-aerial-map', visible && 'is-visible', ready && 'is-ready')}>
      <div ref={containerRef} className="nx-di25-aerial-map__canvas" />
      <button type="button" className="nx-di25-aerial-map__reset" onClick={reset} title="Center property">
        Reset
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
  const [lockScroll, setLockScroll] = useState(false)

  const streetEmbedUrl = useMemo(
    () => buildInteractiveStreetViewUrl({ address, lat, lng }),
    [address, lat, lng],
  )

  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(Number(lat)) > 0.0001

  useEffect(() => {
    if (streetEmbedUrl) {
      setStreetMode('interactive')
      return
    }
    if (streetStoredUrl) {
      setStreetMode('static')
      return
    }
    setStreetMode('unavailable')
  }, [streetEmbedUrl, streetStoredUrl])

  useEffect(() => {
    if (hasCoords) {
      setAerialMode('interactive')
      return
    }
    if (aerialStoredUrl) {
      setAerialMode('static')
      return
    }
    setAerialMode('unavailable')
  }, [hasCoords, aerialStoredUrl])

  useEffect(() => {
    const scrollBody = document.querySelector('.nx-intelligence-panel.is-layout-compact .nx-intel-scroll-body') as HTMLElement | null
    if (!scrollBody) return
    if (lockScroll) {
      scrollBody.style.overflowY = 'hidden'
      return () => { scrollBody.style.overflowY = '' }
    }
    scrollBody.style.overflowY = ''
    return undefined
  }, [lockScroll])

  const streetBadge = streetMode === 'interactive'
    ? 'Interactive Street View'
    : streetMode === 'static'
      ? 'Static Street View'
      : null

  const aerialBadge = aerialMode === 'interactive'
    ? 'Interactive Aerial'
    : aerialMode === 'static'
      ? 'Static Aerial'
      : null

  return (
    <div
      className={cls('nx-di25-media__surface', lockScroll && 'is-interacting')}
      onPointerEnter={() => { if (activeTab === 'street' && streetMode === 'interactive') setLockScroll(true) }}
      onPointerLeave={() => setLockScroll(false)}
    >
      <div className={cls('nx-di25-media__pane', activeTab !== 'street' && 'is-hidden')}>
        {streetMode === 'loading' ? <div className="nx-di25-media__state">Loading Street View…</div> : null}
        {streetMode === 'interactive' && streetEmbedUrl ? (
          <iframe
            title="Interactive Street View"
            src={streetEmbedUrl}
            className="nx-di25-media__iframe"
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            allowFullScreen
          />
        ) : null}
        {streetMode === 'static' && streetStoredUrl ? (
          <img src={streetStoredUrl} alt="Street View" className="nx-di25-media__img" />
        ) : null}
        {streetMode === 'unavailable' ? <div className="nx-di25-media__state">Street View unavailable</div> : null}
        {streetBadge ? <span className="nx-di25-media__badge">{streetBadge}</span> : null}
      </div>

      <div className={cls('nx-di25-media__pane', activeTab !== 'aerial' && 'is-hidden')}>
        {aerialMode === 'loading' ? <div className="nx-di25-media__state">Loading aerial…</div> : null}
        {aerialMode === 'interactive' && hasCoords ? (
          <AerialMap lat={Number(lat)} lng={Number(lng)} visible={activeTab === 'aerial'} />
        ) : null}
        {aerialMode === 'static' && aerialStoredUrl ? (
          <img src={aerialStoredUrl} alt="Aerial" className="nx-di25-media__img" />
        ) : null}
        {aerialMode === 'unavailable' ? <div className="nx-di25-media__state">Aerial view unavailable</div> : null}
        {aerialBadge ? <span className="nx-di25-media__badge">{aerialBadge}</span> : null}
      </div>

      <div className="nx-di25-media__gradient" />
    </div>
  )
}