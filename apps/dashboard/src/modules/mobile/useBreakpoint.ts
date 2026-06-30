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