import { useEffect, useState } from 'react'

export type Breakpoint = 'phone' | 'tablet' | 'desktop'

const PHONE_MAX = 767
const TABLET_MAX = 1023

export function resolveBreakpoint(width: number): Breakpoint {
  if (width <= PHONE_MAX) return 'phone'
  if (width <= TABLET_MAX) return 'tablet'
  return 'desktop'
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
} {
  const [dims, setDims] = useState(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 1280,
    height: typeof window !== 'undefined' ? window.innerHeight : 800,
  }))

  useEffect(() => {
    const onResize = () => setDims({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize, { passive: true })
    window.addEventListener('orientationchange', onResize, { passive: true })
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [])

  const { width, height } = dims
  const breakpoint = resolveBreakpoint(width)
  const isPortrait = height >= width
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
  }
}