/**
 * ONE SELECTED PROPERTY, ONE INTENTIONAL IMAGERY REQUEST.
 *
 * Street View is RESTORED here. Deal Intelligence is a single-property
 * inspection surface, and the rule is about request FAN-OUT, not about the app
 * name: a high-volume list must never auto-request imagery per row, while one
 * property the operator deliberately opened may load its own.
 *
 * WHY IT WAS REMOVED, AND WHAT IS DIFFERENT NOW. The problem was never
 * fan-out on this surface — it was AUTO-LOAD. Deal Intelligence mounts by
 * default in the desktop Inbox workspace, and these effects flipped straight to
 * `interactive` on mount, so every Inbox boot pulled the Maps JS API and built
 * a panorama for a pane nobody had looked at: 17 maps requests per boot
 * (maps/api/js, streetview.js, imagery_viewer.js, two SingleImageSearch POSTs,
 * GeoPhotoService.GetMetadata).
 *
 * So the imagery is back, but it still waits for `activated` — the same intent
 * gate Aerial already uses. Restoring the literal pre-removal behaviour would
 * have reinstated a measured defect, and an unviewed pane requesting imagery is
 * not what "one intentional request" means.
 *
 * The earlier deferral attempt also rendered property data (type / value /
 * equity / market) inside a card labelled STREET VIEW. That is not repeated:
 * the poster below is a plain call to action with no property data in it.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { buildAerialViewUrl, buildStreetViewUrl } from '../../domain/inbox/inbox-normalization'
import { getCommandMapThemeStyle } from '../../views/map/commandMapThemes'
import { getGoogleMapsApiKey } from '../../lib/maps/loadGoogleMaps'
import { InteractiveStreetViewPanorama } from './InteractiveStreetViewPanorama'

export type MediaTab = 'street' | 'aerial'
export type StreetMode = 'idle' | 'interactive' | 'embed' | 'static' | 'unavailable' | 'loading'
export type AerialMode = 'idle' | 'interactive' | 'static' | 'unavailable' | 'loading'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

/**
 * Restored unchanged from the pre-removal implementation. Builds an embed URL
 * for the SELECTED property only; it is called for one address at a time and
 * never mapped over a collection.
 */
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
  // A whitespace-only address is truthy, so the pre-removal version built a
  // `location=+++` request that can never resolve. One wasted Street View call
  // per blank-address subject is exactly what this phase is trying to avoid.
  const location = hasCoords ? `${lat},${lng}` : address?.trim()
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
  /** Which pane the operator is looking at. Only that pane loads imagery. */
  activeTab?: MediaTab
  address?: string | null
  streetStoredUrl?: string | null
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
  activeTab = 'street',
  address,
  lat,
  lng,
  streetStoredUrl,
  aerialStoredUrl,
  activated = false,
  onActivate,
}: DealIntelligenceMediaProps) => {
  const [streetMode, setStreetMode] = useState<StreetMode>('idle')
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

  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(Number(lat)) > 0.0001
  const canUseInteractiveStreet = Boolean(getGoogleMapsApiKey() && (hasCoords || address?.trim()))

  /**
   * The pre-removal fallback chain, unchanged:
   *   interactive panorama -> embed iframe -> static image -> unavailable
   * with `handlePanoramaFailure` stepping down on a live failure, so imagery
   * degrades instead of blocking the rest of Deal Intelligence.
   *
   * Two gates in front of it that the original did not have:
   *   `activated`  — the operator asked for imagery on this property
   *   `activeTab`  — only the pane being looked at loads anything
   * The address/lat/lng deps mean a subject change re-derives the URLs, so a
   * previous property's imagery cannot persist into a new subject.
   */
  useEffect(() => {
    setStreetStaticFailed(false)
    if (!activated || activeTab !== 'street') {
      setStreetMode('idle')
      return
    }
    if (canUseInteractiveStreet) {
      setStreetMode('interactive')
      return
    }
    if (streetEmbedUrl) {
      setStreetMode('embed')
      return
    }
    if (streetStoredUrl || staticStreetUrl) {
      setStreetMode('static')
      return
    }
    setStreetMode('unavailable')
  }, [activated, activeTab, canUseInteractiveStreet, streetEmbedUrl, streetStoredUrl, staticStreetUrl])

  useEffect(() => {
    setAerialStaticFailed(false)
    if (!activated || activeTab !== 'aerial') {
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
  }, [activated, activeTab, aerialStoredUrl, aerialStaticFailed, hasCoords, staticAerialUrl])

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
    if (streetMode === 'idle') return renderActivationPoster('Load Street View')
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
    if (streetMode === 'static' && (streetStoredUrl || staticStreetUrl) && !streetStaticFailed) {
      return (
        <img
          src={streetStoredUrl || staticStreetUrl || ''}
          alt="Street View"
          className="nx-di25-media__img"
          onError={() => setStreetStaticFailed(true)}
        />
      )
    }
    return <div className="nx-di25-media__state">Street View unavailable</div>
  }

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
    <div className={cls('nx-di25-media__surface', `is-tab-${activeTab}`)}>
      <div className="nx-di25-media__pane">
        {activeTab === 'street' ? renderStreetPane() : renderAerialPane()}
      </div>
    </div>
  )
}