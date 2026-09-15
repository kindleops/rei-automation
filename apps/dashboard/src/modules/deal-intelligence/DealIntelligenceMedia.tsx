/**
 * NO STREET VIEW HERE.
 *
 * The operator's call: Street View cards are out of this surface. The previous
 * pass tried to defer them behind a click-to-load poster instead, and worse,
 * that poster showed property data (type / value / equity / market) inside a
 * card labelled STREET VIEW -- information in an imagery card, which reads as a
 * mistake because it is one.
 *
 * So the Street View pane, its interactive panorama, its embed builder and its
 * static fallback are gone rather than deferred. Aerial is what remains, and it
 * still loads only on intent (see `activated`).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { buildAerialViewUrl } from '../../domain/inbox/inbox-normalization'
import { getCommandMapThemeStyle } from '../../views/map/commandMapThemes'

export type AerialMode = 'idle' | 'interactive' | 'static' | 'unavailable' | 'loading'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

interface DealIntelligenceMediaProps {
  address?: string | null
  lat?: number | null
  lng?: number | null
  aerialStoredUrl?: string | null
  /**
   * Whether the operator has actually asked for property imagery.
   *
   * Deal Intelligence mounts by default in the desktop Inbox workspace, and
   * this component's effects flipped straight to `interactive` on mount, which
   * called loadGoogleMaps() and instantiated a panorama for a pane nobody had
   * looked at. Measured on a desktop Inbox boot before this gate: 17 maps
   * requests (maps/api/js, streetview.js, imagery_viewer.js, two
   * SingleImageSearch POSTs, GeoPhotoService.GetMetadata).
   *
   * Street View is NOT removed. It waits.
   */
  activated?: boolean
  onActivate?: () => void
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
  address,
  lat,
  lng,
  aerialStoredUrl,
  activated = false,
  onActivate,
}: DealIntelligenceMediaProps) => {
  const [aerialMode, setAerialMode] = useState<AerialMode>('loading')
  const [aerialStaticFailed, setAerialStaticFailed] = useState(false)

  const staticAerialUrl = useMemo(
    () => buildAerialViewUrl(address ?? null, lat, lng),
    [address, lat, lng],
  )

  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(Number(lat)) > 0.0001

  useEffect(() => {
    setAerialStaticFailed(false)
    if (!activated) {
      setAerialMode('idle')
      return
    }
    if (hasCoords) {
      setAerialMode('interactive')
      return
    }
    if ((aerialStoredUrl || staticAerialUrl) && !aerialStaticFailed) {
      setAerialMode('static')
      return
    }
    setAerialMode('unavailable')
  }, [activated, aerialStoredUrl, aerialStaticFailed, hasCoords, staticAerialUrl])

  const renderActivationPoster = (label: string) => (
    <button
      type="button"
      className="nx-di25-media__poster"
      onClick={() => onActivate?.()}
      title={`${label} — loads Google Maps imagery`}
    >
      <span className="nx-di25-media__poster-cta">{label}</span>
      <span className="nx-di25-media__poster-note">Loads Google Maps imagery on demand</span>
    </button>
  )

  const renderAerialPane = () => {
    if (aerialMode === 'idle') return renderActivationPoster('Load aerial view')
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
        {renderAerialPane()}
      </div>
    </div>
  )
}