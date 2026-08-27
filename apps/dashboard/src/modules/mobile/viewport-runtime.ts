/**
 * Shared mobile viewport runtime.
 *
 * The problem this exists to solve: on real iOS Safari none of the CSS
 * viewport units reliably describe the area the user can actually see.
 *
 *   - `100vh` / `100lvh` is the viewport with the browser chrome hidden, so it
 *     is taller than the visible area whenever the URL bar is showing.
 *   - `100svh` is the viewport with the chrome expanded, so it is shorter than
 *     the visible area once the URL bar collapses — this is what left the shell
 *     ending above the physical bottom with the black body showing through.
 *   - `100dvh` is correct in principle, but it tracks the *layout* viewport.
 *     `position: fixed` also resolves against the layout viewport, and on iOS
 *     Safari the layout viewport and the visually-visible region disagree while
 *     the chrome is animating or when the page cannot scroll. That disagreement
 *     is exactly what makes a `bottom: 0` dock render well above the display
 *     bottom with dead space beneath it.
 *
 * `window.visualViewport` is the only API that reports what is genuinely on
 * screen, so we measure it and publish it as custom properties that CSS can
 * use as a definite length. Desktop and every non-iOS browser resolve these to
 * the same numbers the CSS units already produce, so this is a no-op there.
 *
 * Published on <html>:
 *   --nx-vvh            true visible viewport height, in px
 *   --nx-vv-bottom-gap  how far the bottom of the layout viewport sits below
 *                       the bottom of the visible region. Anything fixed to
 *                       `bottom: 0` must be lifted by this much to remain
 *                       visible; it is 0 on every browser that does not overlay
 *                       its chrome.
 *
 * Deliberately does not touch layout itself: it only reports measurements, and
 * the stylesheets decide what to do with them.
 */

const HTML_ATTR = 'data-nx-viewport-runtime'

/**
 * Installed / Home-Screen app, as opposed to a tab in Safari.
 *
 * This is the whole point of the check: the bottom gap below only ever means
 * "browser chrome is overlaying the layout viewport". A standalone app has no
 * browser chrome, so any delta reported there is measurement noise — on iOS
 * standalone `visualViewport.height` can come back short of the layout viewport
 * by roughly the home-indicator band. Feeding that into the dock's `bottom`
 * lifted it ~100px off the bottom of the display and opened a black strip.
 */
function isStandalone(): boolean {
  const displayMode =
    typeof window.matchMedia === 'function' &&
    (window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches)
  // iOS Safari's own non-standard flag, still the reliable signal on iOS.
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
  return Boolean(displayMode || iosStandalone)
}

/** Last measurement, exposed for on-device diagnostics. */
export type ViewportDebug = {
  standalone: boolean
  displayModeStandalone: boolean
  navigatorStandalone: boolean
  innerHeight: number
  clientHeight: number
  visualViewportHeight: number | null
  visualViewportOffsetTop: number | null
  rawGap: number
  appliedGap: number
  vvh: number
}

let lastDebug: ViewportDebug | null = null
export function getViewportDebug(): ViewportDebug | null {
  return lastDebug
}

function publish(): void {
  const el = document.documentElement
  const vv = window.visualViewport
  const standalone = isStandalone()

  // Layout viewport height — what `100dvh` and `position: fixed` resolve to.
  const layoutH = el.clientHeight || window.innerHeight || 0

  // Visible height. Fall back to the layout viewport where visualViewport is
  // unavailable, which makes every value below collapse to today's behaviour.
  const measuredH = Math.round(vv?.height ?? layoutH)
  const offsetTop = Math.round(vv?.offsetTop ?? 0)
  const rawGap = layoutH - (measuredH + offsetTop)

  // Clamp: a negative gap means the visible region is taller than the layout
  // viewport (mid-collapse), which needs no correction. An absurd gap means we
  // measured during an animation frame and should not shove the dock offscreen.
  const browserGap = Math.max(0, Math.min(rawGap, Math.round(layoutH * 0.4)))

  // In standalone there is no toolbar to compensate for, so the correction is
  // unconditionally zero and the app root is the full layout viewport. Applying
  // the visualViewport delta here would be correcting for chrome that does not
  // exist.
  const appliedGap = standalone ? 0 : browserGap
  const vvh = standalone ? layoutH : measuredH

  if (vvh > 0) el.style.setProperty('--nx-vvh', `${vvh}px`)
  el.style.setProperty('--nx-vv-bottom-gap', `${appliedGap}px`)
  el.setAttribute('data-nx-display-mode', standalone ? 'standalone' : 'browser')

  lastDebug = {
    standalone,
    displayModeStandalone:
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches,
    navigatorStandalone:
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
    innerHeight: window.innerHeight,
    clientHeight: el.clientHeight,
    visualViewportHeight: vv ? Math.round(vv.height) : null,
    visualViewportOffsetTop: vv ? Math.round(vv.offsetTop) : null,
    rawGap,
    appliedGap,
    vvh,
  }
  // Readable from the device via Safari remote inspector or the settings sheet.
  ;(window as Window & { __nxViewport?: ViewportDebug }).__nxViewport = lastDebug
}

let started = false

/** Idempotent: safe to call from module scope and again from a component. */
export function startViewportRuntime(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {}
  }
  if (started) return () => {}
  started = true
  document.documentElement.setAttribute(HTML_ATTR, 'on')

  let frame = 0
  const schedule = () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      publish()
    })
  }

  publish()

  const vv = window.visualViewport
  // `scroll` matters as much as `resize`: iOS reports URL-bar collapse by
  // moving the visual viewport, not always by resizing it.
  vv?.addEventListener('resize', schedule)
  vv?.addEventListener('scroll', schedule)
  window.addEventListener('resize', schedule)
  // The chrome animates after orientation change settles; re-measure once more.
  const onOrientation = () => {
    schedule()
    setTimeout(publish, 350)
  }
  window.addEventListener('orientationchange', onOrientation)

  // Launching from the Home Screen vs opening the same URL in Safari changes
  // whether the bottom gap means anything at all, so react to the transition.
  const standaloneQuery =
    typeof window.matchMedia === 'function' ? window.matchMedia('(display-mode: standalone)') : null
  standaloneQuery?.addEventListener?.('change', schedule)

  return () => {
    if (frame) cancelAnimationFrame(frame)
    vv?.removeEventListener('resize', schedule)
    vv?.removeEventListener('scroll', schedule)
    window.removeEventListener('resize', schedule)
    window.removeEventListener('orientationchange', onOrientation)
    standaloneQuery?.removeEventListener?.('change', schedule)
    started = false
    document.documentElement.removeAttribute(HTML_ATTR)
  }
}
