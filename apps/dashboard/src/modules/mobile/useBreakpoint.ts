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
  isMobile: boolean
  width: number
} {
  const [width, setWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1280,
  )

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize, { passive: true })
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const breakpoint = resolveBreakpoint(width)

  return {
    breakpoint,
    isPhone: breakpoint === 'phone',
    isTablet: breakpoint === 'tablet',
    isDesktop: breakpoint === 'desktop',
    isMobile: breakpoint === 'phone',
    width,
  }
}