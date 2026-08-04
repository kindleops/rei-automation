/**
 * Interactive Street View panorama (constitution R13.11 — interactive is the
 * primary experience; a static image is a fallback, never the product).
 *
 * Mounted once per stable media key. It never remounts on theme change or pane
 * resize because nothing here reads theme or layout state; a resize is handled
 * by triggering Google's `resize` event on the existing panorama instance.
 */
import { useEffect, useRef, useState } from 'react'
import { loadGoogleMaps } from '../../lib/maps/loadGoogleMaps'
import type { MediaFailureReason, PropertyMediaIdentity } from './types'
import { getMapsApiKey } from './urls'

const DEFAULT_POV = { heading: 210, pitch: 2 }
const PANORAMA_RADIUS_METERS = 90

interface Props {
  identity: PropertyMediaIdentity
  /** Recomputed only when the pane is actually shown/hidden. */
  visible: boolean
  onReady?: () => void
  onFailure?: (reason: MediaFailureReason) => void
}

async function resolveLocation(
  maps: typeof google.maps,
  identity: PropertyMediaIdentity,
): Promise<google.maps.LatLng | null> {
  if (identity.lat != null && identity.lng != null) {
    return new maps.LatLng(identity.lat, identity.lng)
  }
  if (!identity.address) return null
  return new Promise((resolve) => {
    const geocoder = new maps.Geocoder()
    geocoder.geocode({ address: identity.address as string }, (results, status) => {
      resolve(status === 'OK' && results?.[0]?.geometry?.location ? results[0].geometry.location : null)
    })
  })
}

export function StreetViewPanorama({ identity, visible, onReady, onFailure }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const panoramaRef = useRef<google.maps.StreetViewPanorama | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const readyRef = useRef(onReady)
  const failureRef = useRef(onFailure)
  readyRef.current = onReady
  failureRef.current = onFailure

  // Keyed on `identity.key` only — not on the identity object, not on pane
  // width, not on theme. This is what makes the panorama survive a resize.
  const mediaKey = identity.key
  const identityRef = useRef(identity)
  identityRef.current = identity

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined
    if (mediaKey === 'none') {
      setPhase('error')
      failureRef.current?.('NO_COORDINATES')
      return undefined
    }
    if (!getMapsApiKey()) {
      setPhase('error')
      failureRef.current?.('KEY_MISSING')
      return undefined
    }

    let cancelled = false
    setPhase('loading')

    void (async () => {
      try {
        const maps = await loadGoogleMaps()
        if (cancelled) return
        const location = await resolveLocation(maps, identityRef.current)
        if (cancelled) return
        if (!location) {
          setPhase('error')
          failureRef.current?.('NO_COORDINATES')
          return
        }

        const service = new maps.StreetViewService()
        type PanoramaHit = { location: { pano: string; latLng: google.maps.LatLng } }
        const found = await new Promise<PanoramaHit | null>((resolve) => {
          service.getPanorama(
            { location, radius: PANORAMA_RADIUS_METERS, source: 'outdoor' },
            (data, status) => resolve(status === 'OK' && data?.location?.pano ? data : null),
          )
        })
        if (cancelled) return
        if (!found?.location?.pano || !found.location.latLng) {
          setPhase('error')
          failureRef.current?.('NO_PANORAMA_AT_LOCATION')
          return
        }

        panoramaRef.current = new maps.StreetViewPanorama(container, {
          pano: found.location.pano,
          position: found.location.latLng,
          pov: DEFAULT_POV,
          zoom: 1,
          addressControl: false,
          linksControl: true,
          panControl: true,
          enableCloseButton: false,
          fullscreenControl: false,
          motionTracking: false,
          motionTrackingControl: false,
          zoomControl: true,
          clickToGo: true,
          scrollwheel: false,
          disableDefaultUI: false,
        })
        if (cancelled) return
        setPhase('ready')
        readyRef.current?.()
      } catch (err) {
        if (cancelled) return
        setPhase('error')
        const message = err instanceof Error ? err.message : ''
        failureRef.current?.(/key/i.test(message) ? 'KEY_MISSING' : 'NETWORK')
      }
    })()

    return () => {
      cancelled = true
      panoramaRef.current?.setVisible(false)
      panoramaRef.current = null
      container.replaceChildren()
    }
  }, [mediaKey])

  // Pane resize / tab switch — nudge the existing instance, never remount.
  useEffect(() => {
    if (!visible || !panoramaRef.current) return
    const frame = requestAnimationFrame(() => {
      if (panoramaRef.current && window.google?.maps?.event) {
        window.google.maps.event.trigger(panoramaRef.current, 'resize')
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [visible])

  return (
    <div className={`lc-media-pano is-${phase}`}>
      <div ref={containerRef} className="lc-media-pano__canvas" />
      {phase === 'loading' ? (
        <div className="lc-media-progress" role="status" aria-live="polite">
          <span className="lc-media-progress__bar" aria-hidden />
          <span className="lc-media-progress__label">Loading Street View…</span>
        </div>
      ) : null}
    </div>
  )
}
