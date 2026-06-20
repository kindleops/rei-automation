import { useCallback, useEffect, useState } from 'react'
import type { EntityGraphAction } from '../../domain/entity-graph/entity-graph.types'
import { routeEntityGraphAction } from '../../domain/entity-graph/entity-graph-route-actions'
import {
  EMPTY_UNIVERSAL_ENTITY_CONTEXT,
  parseEntityGraphDeepLink,
  syncUniversalContextToUrl,
} from '../../domain/entity-graph/universal-entity-context'
import {
  getUniversalEntityContextSnapshot,
  setUniversalEntityContextSnapshot,
  subscribeUniversalEntityContext,
} from '../../domain/entity-graph/universal-entity-context-store'
import type { UniversalEntityContext } from '../../domain/entity-graph/entity-graph.types'
import { EntityGraphWorkspace } from '../../modules/entity-graph/EntityGraphWorkspace'
import { FullscreenAppShell } from '../../shared/FullscreenAppShell'
import { subscribeSettings } from '../../shared/settings'

function resolveThemeMode(): 'dark' | 'light' {
  if (typeof document === 'undefined') return 'dark'
  const theme = document.documentElement.getAttribute('data-nexus-theme') || 'dark'
  return theme === 'light' ? 'light' : 'dark'
}

export function EntityGraphView() {
  const [themeMode, setThemeMode] = useState<'dark' | 'light'>(resolveThemeMode)
  const [universalContext, setUniversalContext] = useState<UniversalEntityContext>(() => {
    const deepLink = typeof window !== 'undefined' ? parseEntityGraphDeepLink(window.location.pathname) : null
    return deepLink ?? getUniversalEntityContextSnapshot()
  })

  useEffect(() => {
    return subscribeSettings(() => setThemeMode(resolveThemeMode()))
  }, [])

  useEffect(() => {
    return subscribeUniversalEntityContext((next) => setUniversalContext(next))
  }, [])

  useEffect(() => {
    const handlePopState = () => {
      const parsed = parseEntityGraphDeepLink(window.location.pathname)
      setUniversalEntityContextSnapshot(parsed ?? EMPTY_UNIVERSAL_ENTITY_CONTEXT)
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  const handleUniversalContextChange = useCallback((next: UniversalEntityContext, options?: { pushHistory?: boolean }) => {
    setUniversalEntityContextSnapshot(next)
    if (options?.pushHistory) syncUniversalContextToUrl(next, 'push')
  }, [])

  const handleAction = useCallback((action: EntityGraphAction, context: UniversalEntityContext) => {
    routeEntityGraphAction(action, context)
  }, [])

  return (
    <FullscreenAppShell viewId="entity_graph">
      <EntityGraphWorkspace
        paneWidth="100"
        themeMode={themeMode}
        universalContext={universalContext}
        onUniversalContextChange={handleUniversalContextChange}
        onAction={handleAction}
      />
    </FullscreenAppShell>
  )
}