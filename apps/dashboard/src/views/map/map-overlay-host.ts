/**
 * Where the Map's floating overlays mount.
 *
 * On a phone the Map is the whole screen, so sheets and cards portal to <body>.
 * On the desktop the Map lives in a pane beside other apps: a sheet portaled to
 * <body> would cover every pane. There, overlays mount into a host inside the
 * map chrome — the pane's glass body is the containing block for their fixed
 * positioning, so they stay inside the Map pane and the other panes stay
 * usable.
 */
import { useEffect, useState } from 'react'

const EVT = 'nexus:map-overlay-host'
let host: HTMLElement | null = null

export function setMapOverlayHost(el: HTMLElement | null) {
  if (host === el) return
  host = el
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(EVT))
}

const isDesktop = () => typeof document !== 'undefined' && document.documentElement.classList.contains('is-desktop-modern')

/** The element a Map overlay should portal into right now. */
export function mapOverlayTarget(): HTMLElement {
  return isDesktop() && host?.isConnected ? host : document.body
}

/** Same, but re-renders once the host mounts, so an overlay open at mount doesn't land on <body>. */
export function useMapOverlayTarget(): HTMLElement | null {
  const [, bump] = useState(0)
  useEffect(() => {
    const on = () => bump((n) => n + 1)
    window.addEventListener(EVT, on)
    return () => window.removeEventListener(EVT, on)
  }, [])
  return typeof document === 'undefined' ? null : mapOverlayTarget()
}
