import { memo, useEffect, useRef, useState } from 'react'
import { usePropertyMedia } from '../../../shared/media/usePropertyMedia'
import { MEDIA_FAILURE_COPY, type MediaFailureReason } from '../../../shared/media/types'
import '../../../shared/media/property-media.css'

export type InboxStreetViewSize = 'rail' | 'row' | 'hero' | 'header'

type Props = {
  address?: string | null
  lat?: number | null
  lng?: number | null
  cachedImageUrl?: string | null
  /**
   * Stable property identity. Preferred over `address` for keying and for
   * recovering coordinates the inbox list view does not carry.
   */
  propertyId?: string | number | null
  size?: InboxStreetViewSize
  className?: string
}

/**
 * `hero` is the only slot large enough to justify a 2x request; the rest are
 * 54–96px tall. The previous implementation tried `builtUrl.replace('600x300',
 * …)` against a URL containing `size=640x400`, so the replace never matched and
 * every row downloaded a 1280x800 image for a 54px slot.
 */
const SIZE_TO_REQUEST = {
  rail: 'thumb',
  row: 'thumb',
  header: 'thumb',
  hero: 'card',
} as const

/**
 * Row slots are ~89px wide. The full reason sentence lives in the `title`
 * tooltip; this is the label that has to survive the slot without clipping.
 */
const SHORT_REASON: Record<MediaFailureReason, string> = {
  NO_COORDINATES: 'No location',
  NO_PANORAMA_AT_LOCATION: 'No imagery',
  PROVIDER_QUOTA: 'Quota',
  PROVIDER_ERROR: 'Error',
  NETWORK: 'Offline',
  KEY_MISSING: 'No key',
}

/**
 * Resolve the row's property id without requiring every call site to pass it.
 *
 * TEMPORARY BRIDGE — the inbox row elements already carry `data-property-id`
 * (InboxSidebar), but the thumb is not handed the value. Reading it from the
 * closest ancestor keeps this lane's fix self-contained. Remove the fallback
 * once InboxSidebar passes `propertyId` directly (see the Lane C request).
 */
function useRowPropertyId(explicit: string | number | null | undefined) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [derived, setDerived] = useState<string | null>(null)

  useEffect(() => {
    if (explicit != null) return
    const host = hostRef.current
    if (!host) return
    const owner = host.closest('[data-property-id]') as HTMLElement | null
    const value = owner?.dataset.propertyId?.trim() || null
    setDerived((prev) => (prev === value ? prev : value))
  })

  return { hostRef, propertyId: explicit != null ? String(explicit) : derived }
}

const InboxStreetViewThumbComponent = ({
  address = null,
  lat = null,
  lng = null,
  cachedImageUrl = null,
  propertyId = null,
  size = 'rail',
  className = '',
}: Props) => {
  const { hostRef, propertyId: resolvedPropertyId } = useRowPropertyId(propertyId)

  // All per-property state lives in the hook and re-syncs on the stable media
  // key, so a recycled virtual-list row can never inherit the previous row's
  // failure. That is why this component needs no `key` at its call sites.
  const media = usePropertyMedia({
    propertyId: resolvedPropertyId,
    address,
    lat,
    lng,
    storedStreetUrl: cachedImageUrl,
    size: SIZE_TO_REQUEST[size],
    resolveMissingCoordinates: true,
  })

  const { status, url, reason, onLoaded, onError } = media.street
  const loaded = status === 'ready'

  return (
    <div
      ref={hostRef}
      className={`nx-inbox-sv-thumb is-size-${size} ${loaded ? 'is-loaded' : ''} ${className}`.trim()}
      data-media-key={media.identity.key}
      data-media-status={status}
    >
      {status === 'probing' ? (
        // Branded pre-paint treatment — never an empty grey rectangle (R13.4).
        <div className="nx-inbox-sv-thumb__placeholder">
          <span className="nx-inbox-sv-thumb__probing" aria-hidden />
          <span className="nx-inbox-sv-thumb__glyph" aria-hidden>⌂</span>
        </div>
      ) : status === 'ready' && url ? (
        <>
          <img
            src={url}
            alt={media.identity.address ? `Street view of ${media.identity.address}` : ''}
            className="nx-inbox-sv-thumb__img"
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={onLoaded}
            onError={onError}
          />
          <div className="nx-inbox-sv-thumb__vignette" />
          <div className="nx-inbox-sv-thumb__sheen" />
        </>
      ) : (
        <div
          className="nx-inbox-sv-thumb__placeholder"
          title={reason ? MEDIA_FAILURE_COPY[reason].detail : undefined}
        >
          <span className="nx-inbox-sv-thumb__glyph" aria-hidden>⌂</span>
          <span className="nx-inbox-sv-thumb__reason">{SHORT_REASON[reason ?? 'PROVIDER_ERROR']}</span>
        </div>
      )}
    </div>
  )
}

export const InboxStreetViewThumb = memo(InboxStreetViewThumbComponent)
InboxStreetViewThumb.displayName = 'InboxStreetViewThumb'
