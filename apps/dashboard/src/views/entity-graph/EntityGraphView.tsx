import { useCallback, useContext, useEffect, useState } from 'react'
import { PaneRouteContext, useRouteLocation } from '../../app/router'
import { setPropertyLocator } from '../../domain/locator/property-locator'
import { useWorkspaceLink } from '../../modules/desktop/workspace/instance-context'
import { useBreakpoint } from '../../modules/mobile/useBreakpoint'
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

type ThemeMode = 'dark' | 'light' | 'red_ops'

function resolveThemeMode(): ThemeMode {
  if (typeof document === 'undefined') return 'dark'
  const theme = document.documentElement.getAttribute('data-nexus-theme') || 'dark'
  if (theme === 'light') return 'light'
  if (theme === 'red_ops') return 'red_ops'
  return 'dark'
}

export function EntityGraphView() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(resolveThemeMode)
  /**
   * A desktop side pane reads ITS OWN path (the shell points a following
   * Entity Graph at /entity-graph/property/:id). Reading window.location there
   * read the primary app's address, so a linked Entity Graph never moved.
   */
  const pane = useContext(PaneRouteContext)
  const location = useRouteLocation()
  const panePath = pane ? location.split('?')[0] : null
  const { follows } = useWorkspaceLink()
  const { isModernDesktop } = useBreakpoint()
  const [universalContext, setUniversalContext] = useState<UniversalEntityContext>(() => {
    const path = panePath ?? (typeof window !== 'undefined' ? window.location.pathname : '')
    const deepLink = path ? parseEntityGraphDeepLink(path) : null
    return deepLink ?? getUniversalEntityContextSnapshot()
  })

  // the pane's own path moved (a linked selection): adopt it — derived during render
  const [seenPanePath, setSeenPanePath] = useState(panePath)
  if (seenPanePath !== panePath) {
    setSeenPanePath(panePath)
    const parsed = panePath ? parseEntityGraphDeepLink(panePath) : null
    if (parsed) setUniversalContext(parsed)
  }

  useEffect(() => subscribeSettings(() => setThemeMode(resolveThemeMode())), [])

  // a pinned pane keeps its subject
  useEffect(() => (follows ? subscribeUniversalEntityContext((next) => setUniversalContext(next)) : undefined), [follows])

  useEffect(() => {
    if (pane) return
    const handlePopState = () => {
      const parsed = parseEntityGraphDeepLink(window.location.pathname)
      setUniversalEntityContextSnapshot(parsed ?? EMPTY_UNIVERSAL_ENTITY_CONTEXT)
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [pane])

  const handleUniversalContextChange = useCallback((next: UniversalEntityContext) => {
    setUniversalEntityContextSnapshot(next)
    syncUniversalContextToUrl(next, 'replace')
    if (!pane) return
    setUniversalContext(next)
  }, [pane])

  // [linked context] a property chosen here is the workspace selection (desk only)
  const selectedPropertyId = universalContext.propertyId ?? (universalContext.entityType === 'property' ? universalContext.entityId : null)
  const publishSelection = useCallback((next: UniversalEntityContext) => {
    if (!isModernDesktop) return
    const propertyId = next.propertyId ?? (next.entityType === 'property' ? next.entityId : null)
    if (!propertyId || propertyId === selectedPropertyId) return
    setPropertyLocator({ propertyId, threadKey: next.threadKey ?? null, masterOwnerId: next.masterOwnerId ?? null, prospectId: next.prospectId ?? null, opportunityId: next.opportunityId ?? null, address: null })
  }, [isModernDesktop, selectedPropertyId])
  const onContextChange = useCallback((next: UniversalEntityContext) => {
    publishSelection(next)
    handleUniversalContextChange(next)
  }, [handleUniversalContextChange, publishSelection])

  const handleAction = useCallback((action: EntityGraphAction, context: UniversalEntityContext) => {
    routeEntityGraphAction(action, context)
  }, [])

  return (
    <FullscreenAppShell viewId="entity_graph">
      <EntityGraphWorkspace
        paneWidth="100"
        themeMode={themeMode}
        universalContext={universalContext}
        onUniversalContextChange={onContextChange}
        onAction={handleAction}
      />
    </FullscreenAppShell>
  )
}