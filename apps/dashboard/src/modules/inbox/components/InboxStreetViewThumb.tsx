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
}

/** Landscape crops — property visible in full at thumbnail scale */
const SIZE_DIMS: Record<InboxStreetViewSize, string> = {
  rail: '184x138',
  row: '200x140',
  header: '160x96',
  hero: '400x240',
}

const InboxStreetViewThumbComponent = ({
  address = null,
  lat = null,
  lng = null,
  cachedImageUrl = null,
  size = 'rail',
  className = '',
}: Props) => {
  const builtUrl = useMemo(() => buildStreetViewUrl(address, lat, lng), [address, lat, lng])
  const imageUrl = useMemo(() => {
    if (cachedImageUrl) return cachedImageUrl
    if (!builtUrl) return null
    return builtUrl.replace('600x300', SIZE_DIMS[size])
  }, [builtUrl, cachedImageUrl, size])

  const cachedStatus = getCachedStreetViewStatus(imageUrl)
  const [failed, setFailed] = useState(cachedStatus === 'failed')
  const [loaded, setLoaded] = useState(cachedStatus === 'ok')

  const showImage = Boolean(imageUrl) && !failed

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