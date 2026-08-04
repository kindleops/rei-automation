/**
 * The one property media viewer (constitution §13).
 *
 * Replaces the competing Street View implementations that each re-derived their
 * own URL, their own cache, and their own failure handling.
 *
 *  R13.1  keyed by normalized coordinates / property id — see identity.ts
 *  R13.2  no remount on theme change, pane resize, scroll, or reselecting the
 *         same property: the panorama effect depends on `identity.key` alone
 *  R13.3  last valid frame stays on screen while a new property resolves
 *  R13.4  never a raw white/grey/black provider rectangle — every pre-paint
 *         state is the branded treatment below
 *  R13.5  progress is scoped to the media element
 *  R13.6  Street and Aerial retry independently
 *  R13.7  every failure carries one of six typed reasons
 *  R13.11 interactive by default; static image only on interactive failure
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { StreetViewPanorama } from './StreetViewPanorama'
import { usePropertyMedia } from './usePropertyMedia'
import { buildExternalMapsLink } from './urls'
import { MEDIA_FAILURE_COPY, type MediaFailureReason } from './types'
import './property-media.css'

export type MediaTabId = 'street' | 'aerial'

interface Props {
  propertyId?: string | number | null
  address?: string | null
  lat?: number | string | null
  lng?: number | string | null
  storedStreetUrl?: string | null
  storedAerialUrl?: string | null
  /** Controlled tab. Omit for the viewer's own tab state. */
  activeTab?: MediaTabId
  onTabChange?: (tab: MediaTabId) => void
  /** Recover coordinates from `properties` when only a property id is known. */
  resolveMissingCoordinates?: boolean
  className?: string
  /** Static-only mode for surfaces too small to justify a live panorama. */
  staticOnly?: boolean
  /** Hide the built-in tab rail when the host already renders one. */
  showTabs?: boolean
  /**
   * Optional interactive aerial renderer (e.g. a maplibre satellite map).
   * Receives validated coordinates; only called when they exist. Falls back to
   * the static satellite tile otherwise.
   */
  renderInteractiveAerial?: (coords: { lat: number; lng: number; visible: boolean }) => ReactNode
}

function FailureState({
  reason,
  onRetry,
  externalHref,
}: {
  reason: MediaFailureReason
  onRetry: () => void
  externalHref: string | null
}) {
  const copy = MEDIA_FAILURE_COPY[reason]
  const retryable = reason !== 'NO_COORDINATES' && reason !== 'KEY_MISSING'
  return (
    <div className="lc-media-fallback" role="status">
      <div className="lc-media-fallback__mark" aria-hidden>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M3 10.5 12 4l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
          <path d="M9.5 21v-6h5v6" />
        </svg>
      </div>
      <p className="lc-media-fallback__title">{copy.title}</p>
      <p className="lc-media-fallback__detail">{copy.detail}</p>
      <div className="lc-media-fallback__actions">
        {retryable ? (
          <button type="button" className="lc-media-fallback__btn" onClick={onRetry}>
            Retry
          </button>
        ) : null}
        {externalHref ? (
          <a
            className="lc-media-fallback__btn is-ghost"
            href={externalHref}
            target="_blank"
            rel="noreferrer"
          >
            Open in Maps
          </a>
        ) : null}
      </div>
      <span className="lc-media-fallback__code">{reason}</span>
    </div>
  )
}

export function PropertyMediaViewer({
  propertyId,
  address,
  lat,
  lng,
  storedStreetUrl,
  storedAerialUrl,
  activeTab,
  onTabChange,
  resolveMissingCoordinates = true,
  className = '',
  staticOnly = false,
  showTabs = true,
  renderInteractiveAerial,
}: Props) {
  const [ownTab, setOwnTab] = useState<MediaTabId>('street')
  const tab = activeTab ?? ownTab
  const setTab = useCallback(
    (next: MediaTabId) => {
      setOwnTab(next)
      onTabChange?.(next)
    },
    [onTabChange],
  )

  const media = usePropertyMedia({
    propertyId,
    address,
    lat,
    lng,
    storedStreetUrl,
    storedAerialUrl,
    size: 'hero',
    resolveMissingCoordinates,
  })

  // Interactive first; degrade to the static frame only when the live panorama
  // actually fails. Reset per stable key, never per render.
  const [interactiveFailed, setInteractiveFailed] = useState<MediaFailureReason | null>(null)
  const keyRef = useRef(media.identity.key)
  if (keyRef.current !== media.identity.key) {
    keyRef.current = media.identity.key
    if (interactiveFailed) setInteractiveFailed(null)
  }

  const externalHref = useMemo(() => buildExternalMapsLink(media.identity), [media.identity])
  const useInteractive = !staticOnly && !interactiveFailed && media.street.status !== 'failed'

  const retryStreet = useCallback(() => {
    setInteractiveFailed(null)
    media.street.retry()
  }, [media.street])

  const renderStreet = () => {
    if (media.street.status === 'probing') {
      return (
        <div className="lc-media-loading" role="status" aria-live="polite">
          {media.street.lastGoodUrl ? (
            <img src={media.street.lastGoodUrl} alt="" className="lc-media-img is-stale" aria-hidden />
          ) : null}
          <div className="lc-media-progress">
            <span className="lc-media-progress__bar" aria-hidden />
            <span className="lc-media-progress__label">Checking street imagery…</span>
          </div>
        </div>
      )
    }

    if (media.street.status === 'failed') {
      return (
        <FailureState
          reason={interactiveFailed ?? media.street.reason ?? 'PROVIDER_ERROR'}
          onRetry={retryStreet}
          externalHref={externalHref}
        />
      )
    }

    if (useInteractive) {
      return (
        <StreetViewPanorama
          identity={media.identity}
          visible={tab === 'street'}
          onFailure={(reason) => setInteractiveFailed(reason)}
        />
      )
    }

    return (
      <img
        src={media.street.url ?? ''}
        alt={`Street view of ${media.identity.address ?? 'the property'}`}
        className="lc-media-img"
        loading="eager"
        decoding="async"
        onLoad={media.street.onLoaded}
        onError={media.street.onError}
      />
    )
  }

  const renderAerial = () => {
    // Interactive aerial wins when the host supplies one and we have real
    // coordinates (R13.11). It never blocks on the street pane (R13.6).
    if (renderInteractiveAerial && media.identity.lat != null && media.identity.lng != null) {
      return renderInteractiveAerial({
        lat: media.identity.lat,
        lng: media.identity.lng,
        visible: tab === 'aerial',
      })
    }
    if (media.aerial.status === 'failed') {
      return (
        <FailureState
          reason={media.aerial.reason ?? 'PROVIDER_ERROR'}
          onRetry={media.aerial.retry}
          externalHref={externalHref}
        />
      )
    }
    return (
      <img
        src={media.aerial.url ?? ''}
        alt={`Aerial view of ${media.identity.address ?? 'the property'}`}
        className="lc-media-img"
        loading="lazy"
        decoding="async"
        onError={media.aerial.onError}
      />
    )
  }

  return (
    <div className={`lc-media ${className}`.trim()} data-media-key={media.identity.key}>
      {showTabs ? (
      <div className="lc-media__tabs" role="tablist" aria-label="Property imagery">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'street'}
          className={`lc-media__tab ${tab === 'street' ? 'is-active' : ''}`}
          onClick={() => setTab('street')}
        >
          Street
          {media.street.status === 'failed' ? <span className="lc-media__tab-dot" aria-hidden /> : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'aerial'}
          className={`lc-media__tab ${tab === 'aerial' ? 'is-active' : ''}`}
          onClick={() => setTab('aerial')}
        >
          Aerial
          {media.aerial.status === 'failed' ? <span className="lc-media__tab-dot" aria-hidden /> : null}
        </button>
        {media.street.panoDate && tab === 'street' ? (
          <span className="lc-media__meta">Imagery {media.street.panoDate}</span>
        ) : null}
      </div>
      ) : null}

      {/* Both panes stay mounted so switching tabs never re-fetches or
          re-mounts the panorama, and one failing never blanks the other. */}
      <div className="lc-media__stage">
        <div className={`lc-media__pane ${tab === 'street' ? 'is-active' : ''}`} role="tabpanel">
          {renderStreet()}
        </div>
        <div className={`lc-media__pane ${tab === 'aerial' ? 'is-active' : ''}`} role="tabpanel">
          {tab === 'aerial' || media.aerial.status === 'ready' ? renderAerial() : null}
        </div>
      </div>
    </div>
  )
}

/**
 * Idle prefetch of the next likely property (R13.8). Call with the identity a
 * navigation is most likely to land on next.
 */
export function usePrefetchPropertyMedia(nextPropertyId: string | null | undefined) {
  useEffect(() => {
    if (!nextPropertyId) return
    const idle = (window as unknown as {
      requestIdleCallback?: (cb: () => void) => number
    }).requestIdleCallback
    const run = () => {
      void import('./propertyLocations').then((m) => m.requestPropertyLocation(nextPropertyId))
    }
    if (idle) {
      idle(run)
      return
    }
    const t = setTimeout(run, 400)
    return () => clearTimeout(t)
  }, [nextPropertyId])
}
