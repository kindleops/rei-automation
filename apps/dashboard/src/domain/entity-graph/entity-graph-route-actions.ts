import { pushRoutePath } from '../../app/router'
import type { EntityGraphAction, UniversalEntityContext } from './entity-graph.types'
import { activeInboxFromUniversalContext } from './universal-entity-context'
import {
  setUniversalEntityContextSnapshot,
  UNIVERSAL_ENTITY_CONTEXT_EVENT,
} from './universal-entity-context-store'

function buildPropertyIntelligenceUrl(patch: Record<string, string>): string {
  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '')
  Object.entries(patch).forEach(([key, value]) => params.set(key, value))
  return `/deal-intelligence?${params.toString()}`
}

export type EntityGraphRouteActionOptions = {
  onOpenThread?: (context: UniversalEntityContext) => void
  onOpenConversationDraft?: (context: UniversalEntityContext) => void
  onOpenDealIntelligence?: (context: UniversalEntityContext) => void
  onOpenMap?: (context: UniversalEntityContext) => void
  onOpenCompIntelligence?: () => void
  onOpenBuyerMatch?: () => void
}

export function routeEntityGraphAction(
  action: EntityGraphAction,
  context: UniversalEntityContext,
  options: EntityGraphRouteActionOptions = {},
): boolean {
  const syncContext = () => {
    setUniversalEntityContextSnapshot(context)
    window.dispatchEvent(new CustomEvent(UNIVERSAL_ENTITY_CONTEXT_EVENT, { detail: context }))
  }

  if (action === 'open_thread' || action === 'open_conversation') {
    if (options.onOpenThread) {
      options.onOpenThread(context)
      return true
    }
    syncContext()
    pushRoutePath('/conversation')
    window.dispatchEvent(new CustomEvent(UNIVERSAL_ENTITY_CONTEXT_EVENT, { detail: activeInboxFromUniversalContext(context, 'entity_graph') }))
    return true
  }

  if (action === 'create_manual_draft' || action === 'contact_owner' || action === 'contact_person' || action === 'email') {
    if (options.onOpenConversationDraft) {
      options.onOpenConversationDraft(context)
      return true
    }
    syncContext()
    pushRoutePath('/conversation')
    window.dispatchEvent(new CustomEvent(UNIVERSAL_ENTITY_CONTEXT_EVENT, { detail: activeInboxFromUniversalContext(context, 'entity_graph') }))
    return true
  }

  if (action === 'open_deal_intelligence') {
    if (options.onOpenDealIntelligence) {
      options.onOpenDealIntelligence(context)
      return true
    }
    syncContext()
    pushRoutePath('/deal-intelligence')
    return true
  }

  if (action === 'show_on_map' || action === 'open_in_map') {
    if (options.onOpenMap) {
      options.onOpenMap(context)
      return true
    }
    syncContext()
    pushRoutePath('/map')
    return true
  }

  if (action === 'open_comp_intelligence') {
    if (options.onOpenCompIntelligence) {
      options.onOpenCompIntelligence()
      return true
    }
    pushRoutePath('/comp-intelligence')
    return true
  }

  if (action === 'open_buyer_match') {
    if (options.onOpenBuyerMatch) {
      options.onOpenBuyerMatch()
      return true
    }
    pushRoutePath('/buyer-match')
    return true
  }

  if (action === 'apply_market_filter' && context.entityId) {
    pushRoutePath(buildPropertyIntelligenceUrl({ pi_market: context.entityId, pi_page: '1' }))
    return true
  }

  if (action === 'apply_zip_filter' && context.entityId) {
    pushRoutePath(buildPropertyIntelligenceUrl({ pi_q: context.entityId, pi_page: '1' }))
    return true
  }

  if (action === 'view_properties') {
    if (context.entityType === 'market' && context.entityId) {
      pushRoutePath(buildPropertyIntelligenceUrl({ pi_market: context.entityId, pi_page: '1' }))
      return true
    }
    if (context.entityType === 'zip' && context.entityId) {
      pushRoutePath(buildPropertyIntelligenceUrl({ pi_q: context.entityId, pi_page: '1' }))
      return true
    }
    pushRoutePath('/deal-intelligence')
    return true
  }

  if (action === 'view_zip_intelligence' && context.entityId) {
    pushRoutePath(buildPropertyIntelligenceUrl({ pi_q: context.entityId, pi_page: '1' }))
    return true
  }

  if (action === 'view_market_intelligence' && context.entityId) {
    pushRoutePath(buildPropertyIntelligenceUrl({ pi_market: context.entityId, pi_page: '1' }))
    return true
  }

  if (action === 'open_portfolio' || action === 'view_portfolio' || action === 'view_linked_properties') {
    if (context.masterOwnerId) {
      pushRoutePath(buildPropertyIntelligenceUrl({ pi_q: context.masterOwnerId, pi_page: '1' }))
      return true
    }
    if (context.propertyId) {
      pushRoutePath(buildPropertyIntelligenceUrl({ pi_q: context.propertyId, pi_page: '1' }))
      return true
    }
    return false
  }

  if (action === 'view_owner' || action === 'view_master_owner') {
    if (!context.masterOwnerId) return false
    pushRoutePath(`/entity-graph/owner/${encodeURIComponent(context.masterOwnerId)}`)
    return true
  }

  if (action === 'view_prospect' || action === 'view_linked_person') {
    if (!context.prospectId) return false
    pushRoutePath(`/entity-graph/prospect/${encodeURIComponent(context.prospectId)}`)
    return true
  }

  if (action === 'create_opportunity' || action === 'open_opportunity') {
    if (!context.propertyId) return false
    const params = new URLSearchParams()
    params.set('property_id', context.propertyId)
    if (context.masterOwnerId) params.set('master_owner_id', context.masterOwnerId)
    pushRoutePath(`/closing-desk?${params.toString()}`)
    return true
  }

  if (action === 'view_threads') {
    if (options.onOpenThread && context.threadKey) {
      options.onOpenThread(context)
      return true
    }
    return false
  }

  if (action === 'select_contact_method') {
    return true
  }

  return false
}