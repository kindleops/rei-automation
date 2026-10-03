import { memo, useEffect, useRef } from 'react'
import { DENIED_FEATURES, sandboxAttr } from './embed-policy'
import { LOAD_PATIENCE_MS, type SurfaceProps } from './provider'

/**
 * WEB EMBED — one sandboxed iframe per open tab.
 *
 * Security posture (the page is visually inside the cockpit, security-wise
 * outside it):
 *   sandbox          only the tokens the registry proved this domain needs;
 *                    never allow-downloads, allow-top-navigation, allow-modals
 *                    beyond that list
 *   allow            camera, microphone, geolocation, clipboard-write,
 *                    payment, USB, serial, HID, display capture, fullscreen,
 *                    notifications-adjacent features: all 'none'
 *   referrerpolicy   no-referrer — a foreign page never learns which
 *                    LeadCommand screen (or record id) sent it
 *   credentialless   where supported (Chromium): the page gets an ephemeral
 *                    storage partition, so no cookies are shared with the
 *                    operator's own browsing of that site and nothing it
 *                    stores outlives the session
 * No script is injected, nothing is read from the page, and no message
 * channel is opened: the Browser does not listen to postMessage at all.
 *
 * Failure detection: a cross-origin frame cannot be inspected, so the
 * Browser only frames domains the audit proved embeddable, and treats
 * silence past LOAD_PATIENCE_MS (or being offline) as a failure it says out
 * loud. A blank frame is never presented as success without a load event.
 */

export const WebEmbedSurface = memo(function WebEmbedSurface({ tabId, url, title, sandbox, reloadKey, visible, onStatus, onInnerNavigation }: SurfaceProps) {
  const loads = useRef(0)

  useEffect(() => {
    loads.current = 0
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { onStatus(tabId, 'offline'); return }
    onStatus(tabId, 'loading')
    const timer = window.setTimeout(() => { if (loads.current === 0) onStatus(tabId, 'timeout') }, LOAD_PATIENCE_MS)
    const offline = () => { if (loads.current === 0) onStatus(tabId, 'offline') }
    window.addEventListener('offline', offline)
    return () => { window.clearTimeout(timer); window.removeEventListener('offline', offline) }
  }, [tabId, url, reloadKey, onStatus])

  const onLoad = () => {
    loads.current += 1
    if (loads.current === 1) onStatus(tabId, 'loaded')
    else onInnerNavigation(tabId)
  }

  // `credentialless` is not in React's DOM typings yet; React passes it through as an attribute.
  const extra = { credentialless: '' } as Record<string, string>
  return (
    <iframe
      key={`${url}#${reloadKey}`}
      className="lcb-frame"
      src={url}
      title={title}
      sandbox={sandboxAttr(sandbox)}
      allow={DENIED_FEATURES}
      referrerPolicy="no-referrer"
      onLoad={onLoad}
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      {...extra}
    />
  )
})
