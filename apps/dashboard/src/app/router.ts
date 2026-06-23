import { startTransition, useCallback, useEffect, useState } from 'react'

export const defaultRoutePath = '/inbox'

export const normalizeRoutePath = (pathname: string) => {
  if (!pathname || pathname === '/' || pathname === '/dashboard') {
    return defaultRoutePath
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
