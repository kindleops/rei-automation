import { startTransition, useCallback, useEffect, useState } from 'react'
import { resolveBreakpoint } from '../modules/mobile/useBreakpoint'
import { resolveViewportMetrics } from '../modules/mobile/viewport-metrics'

export const defaultRoutePath = '/inbox'
/** Where a phone lands: the Home command surface rather than a thread list. */
export const mobileDefaultRoutePath = '/home'

/**
 * Same test the shell uses to decide it is in the mobile layout (portrait phone,
 * including Safari's inflated "desktop website" viewport), so a phone never lands on
 * a route the shell then renders as desktop, or the reverse.
 */
const isMobileLanding = () => {
  if (typeof window === 'undefined') return false
  const viewport = resolveViewportMetrics({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    screenWidth: window.screen?.width,
    screenHeight: window.screen?.height,
    visualViewportWidth: window.visualViewport?.width,
    visualViewportHeight: window.visualViewport?.height,
    orientationPortrait: window.matchMedia?.('(orientation: portrait)')?.matches,
  })
  return resolveBreakpoint(viewport.effectiveWidth) === 'phone' && viewport.isPortrait
}

export const normalizeRoutePath = (pathname: string) => {
  if (!pathname || pathname === '/' || pathname === '/dashboard') {
    return isMobileLanding() ? mobileDefaultRoutePath : defaultRoutePath
  }

  return pathname
}

const dispatchRouteChange = () => {
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export const replaceRoutePath = (path: string) => {
  window.history.replaceState({}, '', path)
  dispatchRouteChange()
}

export const pushRoutePath = (path: string) => {
  window.history.pushState({}, '', path)
  dispatchRouteChange()
}

export const useRoutePath = () => {
  const [path, setPath] = useState(() => normalizeRoutePath(window.location.pathname))

  const syncPath = useCallback(() => {
    const nextPath = normalizeRoutePath(window.location.pathname)
    startTransition(() => {
      setPath(nextPath)
    })
  }, [])

  useEffect(() => {
    const normalizedPath = normalizeRoutePath(window.location.pathname)
    if (window.location.pathname !== normalizedPath) {
      replaceRoutePath(normalizedPath)
    }

    syncPath()

    const handlePopState = () => {
      syncPath()
    }

    window.addEventListener('popstate', handlePopState)
    return () => {
      window.removeEventListener('popstate', handlePopState)
    }
  }, [syncPath])

  return path
}
