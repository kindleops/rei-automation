import { useCallback, useEffect, useState } from 'react'
import { pushRoutePath } from '../../app/router'
import type { EntityGraphAction } from '../../domain/entity-graph/entity-graph.types'
import {
  activeInboxFromUniversalContext,
  parseEntityGraphDeepLink,
  syncUniversalContextToUrl,
} from '../../domain/entity-graph/universal-entity-context'
import {
  getUniversalEntityContextSnapshot,
  setUniversalEntityContextSnapshot,
  subscribeUniversalEntityContext,
  UNIVERSAL_ENTITY_CONTEXT_EVENT,
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
      if (parsed) setUniversalEntityContextSnapshot(parsed)
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  const handleUniversalContextChange = useCallback((next: UniversalEntityContext, options?: { pushHistory?: boolean }) => {
    setUniversalEntityContextSnapshot(next)
    if (options?.pushHistory) syncUniversalContextToUrl(next, 'push')
  }, [])

  const handleAction = useCallback((action: EntityGraphAction, context: UniversalEntityContext) => {
    if (action === 'open_in_map' || action === 'show_on_map') {
      setUniversalEntityContextSnapshot(context)
      pushRoutePath('/map')
      window.dispatchEvent(new CustomEvent(UNIVERSAL_ENTITY_CONTEXT_EVENT, { detail: context }))
      return
    }
    if (action === 'open_deal_intelligence') {
      setUniversalEntityContextSnapshot(context)
      pushRoutePath(context.propertyId ? `/deal-intelligence` : '/deal-intelligence')
      return
    }
    if (action === 'open_comp_intelligence') {
      pushRoutePath('/comp-intelligence')
      return
    }
    if (action === 'open_buyer_match') {
      pushRoutePath('/buyer-match')
      return
    }
    if (action === 'create_manual_draft' || action === 'open_thread' || action === 'contact_owner' || action === 'contact_person') {
      setUniversalEntityContextSnapshot(context)
      pushRoutePath('/conversation')
      window.dispatchEvent(new CustomEvent(UNIVERSAL_ENTITY_CONTEXT_EVENT, { detail: activeInboxFromUniversalContext(context, 'entity_graph') }))
    }
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