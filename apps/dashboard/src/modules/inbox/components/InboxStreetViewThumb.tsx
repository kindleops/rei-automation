/**
 * NO LONGER USED BY THE INBOX.
 *
 * The Inbox replaced this with PropertySignalTile (zero network requests) --
 * a 25-row page was firing up to 25 billed Street View Static requests on load
 * and again on every category switch, filter and search.
 *
 * It stays because Pipeline still mounts it (PipelineRichDealCard,
 * PipelineMobileOpportunityDetail), where the operator is looking at one deal
 * rather than scanning a list. Despite living under modules/inbox/, this is
 * Pipeline's component now; do not reintroduce it into an Inbox list.
 */
import { memo, useMemo, useState } from 'react'
import { buildStreetViewUrl } from '../../../domain/inbox/inbox-normalization'
import { getCachedStreetViewStatus, rememberStreetViewResult } from '../utils/streetViewImageCache'

export type InboxStreetViewSize = 'rail' | 'row' | 'hero' | 'header'

type Props = {
  address?: string | null
  lat?: number | null
  lng?: number | null
  cachedImageUrl?: string | null
  size?: InboxStreetViewSize
  className?: string
  /**
   * Render NOTHING when there is no imagery, instead of the placeholder.
   *
   * Conversation puts this inline in the header, where §3 is explicit that an
   * unavailable image must collapse rather than reserve a region -- a grey box
   * with a house glyph is exactly the "giant blank media placeholder" that was
   * ruled out. List surfaces keep the placeholder so their rows stay aligned,
   * so this defaults off.
   */
  collapseWhenUnavailable?: boolean
}

/** Landscape crops — property visible in full at thumbnail scale */
const SIZE_DIMS: Record<InboxStreetViewSize, string> = {
  rail: '184x138',
  row: '200x140',
  header: '208x136',
  hero: '400x240',
}

const InboxStreetViewThumbComponent = ({
  address = null,
  lat = null,
  lng = null,
  cachedImageUrl = null,
  size = 'rail',
  className = '',
  collapseWhenUnavailable = false,
}: Props) => {
  const builtUrl = useMemo(() => buildStreetViewUrl(address, lat, lng), [address, lat, lng])
  const imageUrl = useMemo(() => {
    if (cachedImageUrl) return cachedImageUrl
    if (!builtUrl) return null
    // buildStreetViewUrl emits `size=640x400`; this replaced the literal
    // '600x300', which has not been in that URL for some time, so every
    // caller silently fetched the full 640x400 at scale=2 no matter which
    // size it asked for. Rewrite the parameter instead of a fixed string.
    return builtUrl.replace(/([?&]size=)\d+x\d+/, `$1${SIZE_DIMS[size]}`)
  }, [builtUrl, cachedImageUrl, size])

  const cachedStatus = getCachedStreetViewStatus(imageUrl)
  const [failed, setFailed] = useState(cachedStatus === 'failed')
  const [loaded, setLoaded] = useState(cachedStatus === 'ok')

  const showImage = Boolean(imageUrl) && !failed
  if (!showImage && collapseWhenUnavailable) return null

  return (
    <div
      className={`nx-inbox-sv-thumb is-size-${size} ${loaded && showImage ? 'is-loaded' : ''} ${className}`.trim()}
      aria-hidden
    >
      {showImage ? (
        <>
          <img
            src={imageUrl!}
            alt=""
            className="nx-inbox-sv-thumb__img"
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={() => {
              rememberStreetViewResult(imageUrl!, true)
              setLoaded(true)
            }}
            onError={() => {
              rememberStreetViewResult(imageUrl!, false)
              setFailed(true)
              setLoaded(false)
            }}
          />
          <div className="nx-inbox-sv-thumb__vignette" />
          <div className="nx-inbox-sv-thumb__sheen" />
        </>
      ) : (
        <div className="nx-inbox-sv-thumb__placeholder">
          <span className="nx-inbox-sv-thumb__glyph" aria-hidden>⌂</span>
          <span className="nx-inbox-sv-thumb__placeholder-label">Property</span>
        </div>
      )}
    </div>
  )
}

export const InboxStreetViewThumb = memo(InboxStreetViewThumbComponent)
InboxStreetViewThumb.displayName = 'InboxStreetViewThumb'