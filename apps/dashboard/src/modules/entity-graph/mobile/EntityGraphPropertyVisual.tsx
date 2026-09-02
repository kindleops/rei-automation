import { useState } from 'react'
import { Icon } from '../../../shared/icons'
import { InteractiveStreetViewPanorama } from '../../deal-intelligence/InteractiveStreetViewPanorama'
import {
  getCachedStreetViewStatus,
  rememberStreetViewResult,
} from '../../inbox/utils/streetViewImageCache'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined

/**
 * Property visual module.
 *
 * Three tiers, degrading rather than failing:
 *   1. Interactive Street View panorama (drag to look around) — the operator's
 *      real question is "what does this house look like", and a still frame
 *      answers it worse than a pannable one.
 *   2. Static Street View image — cheaper, and the fallback when the panorama
 *      library or a nearby pano is unavailable.
 *   3. A stated reason. Never a grey box that could mean either "no imagery"
 *      or "we didn't try".
 *
 * The panorama is opt-in per record rather than auto-mounted: it pulls the Maps
 * JS bundle and a live pano session, which is wasteful when the operator is
 * paging through records.
 */

type StaticState = 'idle' | 'ok' | 'failed'

/** A previously-known result for this exact URL, so a revisit doesn't re-probe. */
function cachedState(url: string | null): StaticState {
  if (!url) return 'idle'
  const cached = getCachedStreetViewStatus(url)
  return cached === 'ok' ? 'ok' : cached === 'failed' ? 'failed' : 'idle'
}

function staticStreetViewUrl(address: string | null, lat?: number | null, lng?: number | null): string | null {
  if (!MAPS_KEY) return null
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(Number(lat)) > 0.0001
  const location = hasCoords ? `${lat},${lng}` : (address ?? '').trim()
  if (!location) return null
  const params = new URLSearchParams({
    size: '640x360',
    location,
    fov: '78',
    pitch: '4',
    source: 'outdoor',
    key: MAPS_KEY,
  })
  return `https://maps.googleapis.com/maps/api/streetview?${params.toString()}`
}

type Props = {
  address?: string | null
  lat?: number | null
  lng?: number | null
  onOpenMap?: () => void
}

export function EntityGraphPropertyVisual({ address, lat, lng, onOpenMap }: Props) {
  const url = staticStreetViewUrl(address ?? null, lat, lng)

  const [mode, setMode] = useState<'static' | 'interactive'>('static')
  const [panoFailed, setPanoFailed] = useState(false)
  const [staticState, setStaticState] = useState<StaticState>(() => cachedState(url))

  // Reset when the record changes — adjusted during render rather than in an
  // effect, so a new property never shows the previous one's frame for a beat.
  const [renderedUrl, setRenderedUrl] = useState(url)
  if (renderedUrl !== url) {
    setRenderedUrl(url)
    setMode('static')
    setPanoFailed(false)
    setStaticState(cachedState(url))
  }

  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(Number(lat)) > 0.0001

  if (!MAPS_KEY) {
    return (
      <div className="egv is-unavailable">
        <Icon name="eye" />
        <span>Street View needs a Google Maps key; none is configured for this build.</span>
      </div>
    )
  }

  if (!url) {
    return (
      <div className="egv is-unavailable">
        <Icon name="map" />
        <span>No coordinates or address on this record to locate imagery.</span>
      </div>
    )
  }

  return (
    <div className="egv">
      <div className="egv-frame">
        {mode === 'interactive' && !panoFailed ? (
          <InteractiveStreetViewPanorama
            address={address}
            lat={lat}
            lng={lng}
            visible
            onFailure={() => setPanoFailed(true)}
          />
        ) : staticState === 'failed' ? (
          <div className="egv-fallback">
            <Icon name="alert-circle" />
            <span>No Street View imagery published at this location.</span>
          </div>
        ) : (
          <img
            src={url}
            alt={address ? `Street View of ${address}` : 'Street View'}
            loading="lazy"
            onLoad={() => { setStaticState('ok'); rememberStreetViewResult(url, true) }}
            onError={() => { setStaticState('failed'); rememberStreetViewResult(url, false) }}
          />
        )}

        {panoFailed && mode === 'interactive' ? (
          <div className="egv-note">Interactive panorama unavailable here — showing the still frame.</div>
        ) : null}
      </div>

      <div className="egv-actions">
        <button
          type="button"
          className={cls('egv-btn', mode === 'interactive' && !panoFailed && 'is-on')}
          disabled={staticState === 'failed'}
          onClick={() => {
            setPanoFailed(false)
            setMode((m) => (m === 'interactive' ? 'static' : 'interactive'))
          }}
        >
          <Icon name="eye" />
          {mode === 'interactive' && !panoFailed ? 'Still frame' : 'Look around'}
        </button>
        {onOpenMap ? (
          <button type="button" className="egv-btn" onClick={onOpenMap}>
            <Icon name="map" />
            Open in Map
          </button>
        ) : null}
        {!hasCoords ? <span className="egv-hint">Located by address — imagery may be approximate.</span> : null}
      </div>
    </div>
  )
}
