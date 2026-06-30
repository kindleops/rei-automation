import { useEffect, useRef, useState } from 'react'
import { loadGoogleMaps } from '../../lib/maps/loadGoogleMaps'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

const DEFAULT_POV = { heading: 210, pitch: 2 }
const PANORAMA_RADIUS_METERS = 75

interface InteractiveStreetViewPanoramaProps {
  address?: string | null
  lat?: number | null
  lng?: number | null
  visible: boolean
  onReady?: () => void
  onFailure?: () => void
}

const resolveLatLng = async (
  maps: typeof google.maps,
  {
    address,
    lat,
    lng,
  }: {
    address?: string | null
    lat?: number | null
    lng?: number | null
  },
): Promise<google.maps.LatLng | null> => {
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(Number(lat)) > 0.0001
  if (hasCoords) {
    return new maps.LatLng(Number(lat), Number(lng))
  }
  if (!address?.trim()) return null

  return new Promise((resolve) => {
    const geocoder = new maps.Geocoder()
    geocoder.geocode({ address: address.trim() }, (results, status) => {
      if (status === 'OK' && results?.[0]?.geometry?.location) {
        resolve(results[0].geometry.location)
        return
      }
      resolve(null)
    })
  })
}

const findPanorama = async (
  maps: typeof google.maps,
  location: google.maps.LatLng,
): Promise<{ pano: string; latLng: google.maps.LatLng } | null> => new Promise((resolve) => {
  const service = new maps.StreetViewService()
  service.getPanorama(
    { location, radius: PANORAMA_RADIUS_METERS, source: 'outdoor' },
    (data, status) => {
      if (status === 'OK' && data?.location?.pano && data.location.latLng) {
        resolve({ pano: data.location.pano, latLng: data.location.latLng })
        return
      }
      resolve(null)
    },
  )
})

export const InteractiveStreetViewPanorama = ({
  address,
  lat,
  lng,
  visible,
  onReady,
  onFailure,
}: InteractiveStreetViewPanoramaProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const panoramaRef = useRef<google.maps.StreetViewPanorama | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let cancelled = false
    const container = containerRef.current
    if (!container) return undefined

    const mount = async () => {
      setStatus('loading')
      try {
        const maps = await loadGoogleMaps()
        if (cancelled) return

        const location = await resolveLatLng(maps, { address, lat, lng })
        if (cancelled) return
        if (!location) {
          setStatus('error')
          onFailure?.()
          return
        }

        const panoramaData = await findPanorama(maps, location)
        if (cancelled) return
        if (!panoramaData) {
          setStatus('error')
          onFailure?.()
          return
        }

        const panorama = new maps.StreetViewPanorama(container, {
          pano: panoramaData.pano,
          position: panoramaData.latLng,
          pov: DEFAULT_POV,
          zoom: 1,
          addressControl: false,
          linksControl: true,
          panControl: false,
          enableCloseButton: false,
          fullscreenControl: false,
          motionTracking: false,
          motionTrackingControl: false,
          zoomControl: false,
          clickToGo: true,
          scrollwheel: false,
          disableDefaultUI: true,
        })

        panoramaRef.current = panorama
        if (!cancelled) {
          setStatus('ready')
          onReady?.()
        }
      } catch {
        if (!cancelled) {
          setStatus('error')
          onFailure?.()
        }
      }
    }

    void mount()

    return () => {
      cancelled = true
      panoramaRef.current?.setVisible(false)
      panoramaRef.current = null
      if (container) container.replaceChildren()
    }
  }, [address, lat, lng, onFailure, onReady])

  useEffect(() => {
    if (!visible || !panoramaRef.current) return
    requestAnimationFrame(() => {
      if (panoramaRef.current) {
        google.maps.event.trigger(panoramaRef.current, 'resize')
      }
    })
  }, [visible])

  return (
    <div
      className={cls(
        'nx-di25-street-panorama',
        status === 'ready' && 'is-ready',
        status === 'error' && 'is-error',
      )}
    >
      <div ref={containerRef} className="nx-di25-street-panorama__canvas" />
      {status === 'loading' ? <div className="nx-di25-media__state">Loading Street View…</div> : null}
      {status === 'error' ? <div className="nx-di25-media__state">Street View unavailable</div> : null}
    </div>
  )
}