/**
 * Comp Intelligence V4 — property media.
 *
 * Renders approved Street View / property imagery with:
 *  - fixed aspect ratio (no layout shift)
 *  - lazy loading
 *  - graceful designed fallback when the image is missing or fails
 *  - preserved provider attribution (Google) — never cropped out
 */

import { memo, useState } from 'react'
import { rememberStreetViewResult } from '../../../modules/inbox/utils/streetViewImageCache'

interface PropertyMediaProps {
  url: string | null
  alt: string
  className?: string
  /** Show the "Google" attribution chip (required for Street View imagery). */
  attribution?: boolean
}

function PropertyMediaBase({ url, alt, className, attribution = true }: PropertyMediaProps) {
  const [failed, setFailed] = useState(false)
  const isStreetView = Boolean(url && url.includes('maps.googleapis.com'))
  const show = url && !failed

  return (
    <div className={`civ4-media ${className ?? ''}`}>
      {show ? (
        <>
          <img
            className="civ4-media__img"
            src={url ?? undefined}
            alt={alt}
            loading="lazy"
            decoding="async"
            onError={() => {
              if (url) rememberStreetViewResult(url, false)
              setFailed(true)
            }}
            onLoad={() => url && rememberStreetViewResult(url, true)}
          />
          {attribution && isStreetView && <span className="civ4-media__attr">Google</span>}
        </>
      ) : (
        <div className="civ4-media__fallback" aria-label={alt}>
          <span className="civ4-media__fallbackglyph">⌂</span>
        </div>
      )}
    </div>
  )
}

export const PropertyMedia = memo(PropertyMediaBase)
