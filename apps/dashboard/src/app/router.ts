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

/**
 * How many entries this session has pushed on top of where it started.
 *
 * `history.length` cannot answer "is there anywhere of MINE to go back to" — it
 * counts entries from before the app was loaded, so acting on it can walk the
 * operator out of the product entirely.
 *
 * The depth is STAMPED INTO `history.state` rather than kept in a counter. A
 * counter looked simpler and was wrong: `pushRoutePath` dispatches a synthetic
 * PopStateEvent to notify subscribers, which is indistinguishable from a real
 * back navigation, so every push immediately undid its own increment and Back
 * never appeared. History state is restored by the browser with its entry, so it
 * reports the true depth after a real back and is untouched by our own event.
 */
const DEPTH_KEY = 'nxDepth'

export const getRouteDepth = (): number => {
  if (typeof window === 'undefined') return 0
  const state = window.history.state as Record<string, unknown> | null
  const depth = Number(state?.[DEPTH_KEY] ?? 0)
  return Number.isFinite(depth) && depth > 0 ? depth : 0
}

export const replaceRoutePath = (path: string) => {
  // Replace keeps the current depth: it is the same entry, renamed.
  window.history.replaceState({ [DEPTH_KEY]: getRouteDepth() }, '', path)
  dispatchRouteChange()
}

export const pushRoutePath = (path: string) => {
  window.history.pushState({ [DEPTH_KEY]: getRouteDepth() + 1 }, '', path)
  dispatchRouteChange()
}

/**
 * Path AND query, because `useRoutePath` reports only the pathname.
 *
 * That is correct for deciding which view mounts, and wrong for anything that
 * depends on the context parameters: `/buyer-match?property_id=X` and
 * `/buyer-match` are the same pathname, so a subscriber watching the path alone
 * never learns that the context was cleared.
 */
export const useRouteLocation = () => {
  const read = () => `${normalizeRoutePath(window.location.pathname)}${window.location.search}`
  const [location, setLocation] = useState(read)

  useEffect(() => {
    const sync = () => {
      const next = read()
      startTransition(() => setLocation(next))
    }
    sync()
    window.addEventListener('popstate', sync)
    return () => window.removeEventListener('popstate', sync)
  }, [])

  return location
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
