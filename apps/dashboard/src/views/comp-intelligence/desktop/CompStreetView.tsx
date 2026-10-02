import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../../../shared/icons'
import { cx } from '../../../shared/lc'
import { getCachedStreetViewStatus, rememberStreetViewResult } from '../../../modules/inbox/utils/streetViewImageCache'
import { acquireSlot, compStreetViewUrl } from './comp-street-view-queue'
import './comp-evidence-media.css'

/**
 * COMP STREET VIEW — the existing Street View path (the record's stored
 * `streetview_image`, else the configured static builder at the comp's
 * coordinates), loaded under the fan-out rule:
 *
 *  - `visible`  loads only once the frame scrolls into view (comp lists)
 *  - `intent`   loads only while the comp is hovered or selected (long lists)
 *  - `eager`    loads now (one selected comp's detail)
 *
 * Every load goes through one bounded queue (MAX_IN_FLIGHT at a time), and a
 * frame that leaves view before its turn never fires. Results are remembered
 * per URL (session cache), so a failed frame is never re-probed and the
 * inspector reuses the row's already-fetched image. No coordinates and no
 * stored image → an honest "no street imagery", never a stand-in picture.
 */

type Status = 'idle' | 'ok' | 'failed'
const cachedStatus = (url: string | null): Status => {
  const s = url ? getCachedStreetViewStatus(url) : 'unknown'
  return s === 'ok' ? 'ok' : s === 'failed' ? 'failed' : 'idle'
}

interface Props {
  photo?: string | null
  lat?: number | null
  lng?: number | null
  address?: string | null
  load: 'visible' | 'intent' | 'eager'
  /** intent mode: the comp is hovered or selected */
  active?: boolean
  size: 'thumb' | 'cell' | 'hero' | 'header'
  className?: string
  /** small overlay (e.g. the comp's rank) */
  badge?: ReactNode
}

export function CompStreetView({ photo, lat, lng, address, load, active = false, size, className, badge }: Props) {
  const url = compStreetViewUrl({ photo, lat, lng })
  const host = useRef<HTMLDivElement | null>(null)
  const release = useRef<(() => void) | null>(null)
  const [status, setStatus] = useState<Status>(() => cachedStatus(url))
  const [granted, setGranted] = useState(() => cachedStatus(url) === 'ok')
  const [shownUrl, setShownUrl] = useState(url)
  if (shownUrl !== url) {
    setShownUrl(url)
    setStatus(cachedStatus(url))
    setGranted(cachedStatus(url) === 'ok')
  }

  const want = load === 'eager' || (load === 'intent' && active)
  useEffect(() => {
    if (!url || granted || status !== 'idle') return
    if (load === 'visible') {
      const el = host.current
      if (!el || typeof IntersectionObserver === 'undefined') return
      let cancel: (() => void) | null = null
      const io = new IntersectionObserver((entries) => {
        const on = entries.some((e) => e.isIntersecting)
        if (on && !cancel) cancel = acquireSlot(() => { release.current = cancel; setGranted(true) })
        else if (!on && cancel && !release.current) { cancel(); cancel = null }
      }, { rootMargin: '120px 0px' })
      io.observe(el)
      return () => { io.disconnect(); if (cancel && !release.current) cancel() }
    }
    if (!want) return
    const cancel = acquireSlot(() => { release.current = cancel; setGranted(true) })
    return () => { if (!release.current) cancel() }
  }, [url, granted, status, load, want])

  // a granted slot is released when the frame settles or the component goes away
  useEffect(() => () => { release.current?.(); release.current = null }, [url])

  const settle = (ok: boolean) => {
    if (url) rememberStreetViewResult(url, ok)
    release.current?.()
    release.current = null
    setStatus(ok ? 'ok' : 'failed')
  }

  const none = !url || status === 'failed'
  const reason = !url ? 'No coordinates — no street imagery' : 'No street imagery at this location'
  return (
    <div
      ref={host}
      className={cx('csv', `csv--${size}`, none && 'is-none', status === 'ok' && 'is-ok', className)}
      title={none ? reason : address ? `Street View · ${address}` : 'Street View'}
    >
      {url && granted && status !== 'failed' ? (
        <img src={url} alt={address ? `Street View of ${address}` : 'Street View of the comparable'} decoding="async"
          onLoad={() => settle(true)} onError={() => settle(false)} />
      ) : null}
      {none ? (
        <span className="csv__none"><Icon name="eye" />{size === 'thumb' || size === 'cell' ? null : <em>{reason}</em>}</span>
      ) : status !== 'ok' ? <span className="csv__wait" aria-hidden="true" /> : null}
      {badge ? <span className="csv__badge">{badge}</span> : null}
    </div>
  )
}
