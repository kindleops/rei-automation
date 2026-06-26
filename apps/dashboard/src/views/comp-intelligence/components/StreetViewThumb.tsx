import { useState } from 'react'
import { buildStreetViewUrl } from '../../../domain/inbox/inbox-normalization'

type ThumbSize = 'subject' | 'row' | 'popover' | 'card'

interface Props {
  address?: string | null
  lat?: number | null
  lng?: number | null
  size?: ThumbSize
  className?: string
}

const DIMS: Record<ThumbSize, string> = {
  subject: '400x260',
  row: '160x110',
  popover: '360x200',
  card: '200x130',
}

export function StreetViewThumb({
  address = null,
  lat = null,
  lng = null,
  size = 'row',
  className = '',
}: Props) {
  const [err, setErr] = useState(false)
  const url = buildStreetViewUrl(address, lat, lng)
  const hasLocation = Boolean(url) && !err

  if (!hasLocation) {
    return (
      <div className={`ci-sv-placeholder ci-sv-placeholder--${size} ${className}`.trim()} aria-hidden>
        <span className="ci-sv-placeholder__icon">⌂</span>
        <span className="ci-sv-placeholder__label">Property view</span>
      </div>
    )
  }

  const sizedUrl = url!.replace('600x300', DIMS[size])

  return (
    <img
      src={sizedUrl}
      alt=""
      className={`ci-sv-img ci-sv-img--${size} ${className}`.trim()}
      loading="lazy"
      decoding="async"
      onError={() => setErr(true)}
    />
  )
}