import { useEffect, useState } from 'react'
import { resolveViewportMetrics } from './viewport-metrics'

export type Breakpoint = 'phone' | 'tablet' | 'desktop'

const PHONE_MAX = 767
const TABLET_MAX = 1023

export function resolveBreakpoint(width: number): Breakpoint {
  if (width <= PHONE_MAX) return 'phone'
  if (width <= TABLET_MAX) return 'tablet'
  return 'desktop'
}

function readViewportState() {
  if (typeof window === 'undefined') {
    return resolveViewportMetrics({
      innerWidth: 1280,
      innerHeight: 800,
    })
  }

  return resolveViewportMetrics({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    screenWidth: window.screen?.width,
    screenHeight: window.screen?.height,
    visualViewportWidth: window.visualViewport?.width,
    visualViewportHeight: window.visualViewport?.height,
    orientationPortrait: window.matchMedia?.('(orientation: portrait)')?.matches,
  })
}

export function useBreakpoint(): {
  breakpoint: Breakpoint
  isPhone: boolean
  isTablet: boolean
  isDesktop: boolean
  /** Phone in either orientation — the mobile shell owns the whole product */
  isMobile: boolean
  /**
   * Phone held sideways. The mobile shell still owns the screen; this exists so
   * explicitly spatial surfaces (full-screen map, workflow canvas) can opt into
   * landscape-specific composition. It is not a fallback to the desktop layout.
   */
  isLandscapeMobile: boolean
  /** Desktop or tablet — never a phone, in any orientation */
  isCommandCenterLayout: boolean
  isPortrait: boolean
  width: number
  height: number
  layoutWidth: number
  layoutHeight: number
} {
  const [viewport, setViewport] = useState(readViewportState)

  useEffect(() => {
    const sync = () => setViewport(readViewportState())
    sync()
    window.addEventListener('resize', sync, { passive: true })
    window.addEventListener('orientationchange', sync, { passive: true })
    window.visualViewport?.addEventListener('resize', sync, { passive: true })
    window.visualViewport?.addEventListener('scroll', sync, { passive: true })
    return () => {
      window.removeEventListener('resize', sync)
      window.removeEventListener('orientationchange', sync)
      window.visualViewport?.removeEventListener('resize', sync)
      window.visualViewport?.removeEventListener('scroll', sync)
    }
  }, [])

  const {
    effectiveWidth: width,
    effectiveHeight: height,
    isPortrait,
    isPhoneClass,
    layoutWidth,
    layoutHeight,
  } = viewport

  // A phone turned sideways is 844px wide, which reads as a tablet on width
  // alone. Device class wins so rotating the handset never hands the operator
  // a different product; `width` keeps reporting the real box for layout.
  //
  // The width rule is kept for PORTRAIT boxes only, which is deliberately
  // narrower than it was: it used to admit any viewport <= 767px, so a desktop
  // window dragged to 700x500 resolved to a landscape phone. Narrowing it to
  // portrait leaves that window on exactly the desktop composition it has
  // today, and confines this change to devices that really are phones.
  const isNarrowPortrait = isPortrait && resolveBreakpoint(width) === 'phone'
  const isPhone = isPhoneClass || isNarrowPortrait
  const breakpoint: Breakpoint = isPhone ? 'phone' : resolveBreakpoint(width)
  const isLandscapeMobile = isPhone && !isPortrait
  const isMobile = isPhone

  return {
    breakpoint,
    isPhone,
    isTablet: breakpoint === 'tablet',
    isDesktop: breakpoint === 'desktop',
    isMobile,
    isLandscapeMobile,
    isCommandCenterLayout: !isMobile,
    isPortrait,
    width,
    height,
    layoutWidth,
    layoutHeight,
  }
}