import { useEffect, useState } from 'react'
import { type LcBand, resolveBand } from './breakpoints'
import { resolveViewportMetrics } from './viewport-metrics'

export type Breakpoint = 'phone' | 'tablet' | 'desktop'

/**
 * Coarse layout classes, derived from the §15 bands in `breakpoints.ts` so JS
 * and CSS can never disagree again:
 *   phone   = xs + sm  → CSS `(max-width: 767.98px)`
 *   tablet  = md       → CSS `(min-width: 768px) and (max-width: 1023.98px)`
 *   desktop = lg + xl  → CSS `(min-width: 1024px)`
 */
const BAND_TO_BREAKPOINT: Record<LcBand, Breakpoint> = {
  xs: 'phone',
  sm: 'phone',
  md: 'tablet',
  lg: 'desktop',
  xl: 'desktop',
}

export function resolveBreakpoint(width: number): Breakpoint {
  return BAND_TO_BREAKPOINT[resolveBand(width)]
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
  /** Portrait phone — compact single-panel mobile UX */
  isMobile: boolean
  /** Phone in landscape — preserve command-center multi-panel layouts */
  isLandscapeMobile: boolean
  /** Desktop, tablet, or landscape phone */
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

  const { effectiveWidth: width, effectiveHeight: height, isPortrait, layoutWidth, layoutHeight } = viewport
  const breakpoint = resolveBreakpoint(width)
  const isPhone = breakpoint === 'phone'
  const isLandscapeMobile = isPhone && !isPortrait
  const isMobile = isPhone && isPortrait

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