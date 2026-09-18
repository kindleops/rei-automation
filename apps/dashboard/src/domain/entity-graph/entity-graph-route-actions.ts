import { pushRoutePath } from '../../app/router'
import { setPropertyLocator } from '../locator/property-locator'
import { openInboxDealIntelligence } from '../../modules/mobile/mobile-inbox-bridge'
import type { EntityGraphAction, UniversalEntityContext } from './entity-graph.types'
import { activeInboxFromUniversalContext } from './universal-entity-context'
import {
  setUniversalEntityContextSnapshot,
  UNIVERSAL_ENTITY_CONTEXT_EVENT,
} from './universal-entity-context-store'

function buildPropertyIntelligenceUrl(patch: Record<string, string>): string {
  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '')
  Object.entries(patch).forEach(([key, value]) => params.set(key, value))
  return `/properties?${params.toString()}`
}

export type EntityGraphRouteActionOptions = {
  onOpenThread?: (context: UniversalEntityContext) => void
  onOpenConversationDraft?: (context: UniversalEntityContext) => void
  onOpenDealIntelligence?: (context: UniversalEntityContext) => void
  onOpenSellerAutomation?: (context: UniversalEntityContext) => void
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
    /**
     * PUBLISH THE DURABLE LOCATOR TOO, NOT JUST THE IN-MEMORY SNAPSHOT.
     *
     * The universal snapshot is the cross-view selected-entity singleton and it
     * does not survive a route change -- InboxPage clears it on any non-Entity
     * Graph route and every dock tap unmounts the current view. The property
     * locator exists for exactly this reason: sessionStorage-backed, published
     * at SELECTION time, and it is what `navigateToApp` reads to focus a
     * destination.
     *
     * Entity Graph wrote only the snapshot, so the locator stayed null and
     * every dock hop out of an Entity Graph subject started from scratch.
     * Measured 2026-09-14: with Deal Intelligence showing 5115 Michigan Ave,
     * Kansas City, tapping Comp Intelligence in the app dock answered
     * "No property selected" -- sessionStorage held no locator at all.
     *
     * setPropertyLocator ignores a payload with no identifiers, so an action on
     * a market or ZIP cannot wipe a good property locator.
     */
    setPropertyLocator({
      propertyId: context.propertyId
        ?? (context.entityType === 'property' ? context.entityId ?? null : null),
      threadKey: context.threadKey ?? null,
      masterOwnerId: context.masterOwnerId
        ?? (context.entityType === 'master_owner' ? context.entityId ?? null : null),
      prospectId: context.prospectId
        ?? (context.entityType === 'prospect' ? context.entityId ?? null : null),
      opportunityId: context.opportunityId ?? null,
      address: null,
    })
  }

  if (action === 'open_thread' || action === 'open_conversation') {
    if (options.onOpenThread) {
      options.onOpenThread(context)
      return true
    }
    syncContext()
    pushRoutePath('/conversation')
    window.dispatchEvent(new CustomEvent(UNIVERSAL_ENTITY_CONTEXT_EVENT, { detail: activeInboxFromUniversalContext(context, 'list') }))
    return true
  }

  if (action === 'create_manual_draft' || action === 'contact_owner' || action === 'contact_person' || action === 'email') {
    if (options.onOpenConversationDraft) {
      options.onOpenConversationDraft(context)
      return true
    }
    syncContext()
    pushRoutePath('/conversation')
    window.dispatchEvent(new CustomEvent(UNIVERSAL_ENTITY_CONTEXT_EVENT, { detail: activeInboxFromUniversalContext(context, 'list') }))
    return true
  }

  if (action === 'open_deal_intelligence') {
    if (options.onOpenDealIntelligence) {
      options.onOpenDealIntelligence(context)
      return true
    }
    syncContext()
    /**
     * PASS THE IDENTITY. The bridge deliberately does not overwrite an
     * established identity when called with nothing, so an argument-free call
     * opened Deal Intelligence on whatever thread the Inbox was already
     * holding. This is the same defect the /deal-intelligence route had --
     * fixed there by reading the URL, but this in-app hop never set one, so it
     * relied on the context snapshot the panel may not have read yet.
     *
     * Never substitute another opportunity just because one exists.
     */
    openInboxDealIntelligence({
      threadKey: context.threadKey ?? undefined,
      propertyId: context.propertyId
        ?? (context.entityType === 'property' ? context.entityId ?? undefined : undefined),
      prospectId: context.prospectId
        ?? (context.entityType === 'prospect' ? context.entityId ?? undefined : undefined),
      masterOwnerId: context.masterOwnerId
        ?? (context.entityType === 'master_owner' ? context.entityId ?? undefined : undefined),
    })
    return true
  }

  if (action === 'open_seller_automation' || action === 'open_workflow_studio') {
    if (options.onOpenSellerAutomation) {
      options.onOpenSellerAutomation(context)
      return true
    }
    return false
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
    /**
     * CARRY THE SUBJECT. Both ways.
     *
     * This was `pushRoutePath('/comp-intelligence')` with no syncContext() and
     * no property id -- unlike the map action three lines up, which syncs.
     * CompIntelligenceWorkspace resolves its subject from ?property_id, then a
     * `thread` prop, then dealContext, and returns null if all three are
     * absent -- so launching it from a selected property landed on
     * "No Subject Selected" while a subject demonstrably existed.
     *
     * syncContext() publishes the universal snapshot (which Comp Intelligence
     * now also reads) and the query parameter survives a reload or a shared
     * link, which the in-memory snapshot cannot.
     */
    syncContext()
    const propertyId = context.propertyId || (context.entityType === 'property' ? context.entityId : null)
    pushRoutePath(propertyId
      ? `/comp-intelligence?property_id=${encodeURIComponent(propertyId)}`
      : '/comp-intelligence')
    return true
  }

  if (action === 'open_buyer_match') {
    if (options.onOpenBuyerMatch) {
      options.onOpenBuyerMatch()
      return true
    }
    /**
     * Same subject-carrying contract as Comp Intelligence above — and it was
     * only a comment until now. This pushed a bare `/buyer-match` and leaned on
     * the ambient locator, which no longer scopes anything (see
     * views/buyer-match/buyer-match-subject). Without the parameter this action
     * now lands on the universal select-a-property state, which is precisely the
     * "Buyer Match does not load" report.
     */
    syncContext()
    const buyerPropertyId = context.propertyId || (context.entityType === 'property' ? context.entityId : null)
    pushRoutePath(buyerPropertyId
      ? `/buyer-match?property_id=${encodeURIComponent(buyerPropertyId)}`
      : '/buyer-match')
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
    if (context.entityType === 'property' && context.propertyId) {
      pushRoutePath(buildPropertyIntelligenceUrl({ pi_q: context.propertyId, pi_page: '1' }))
      return true
    }
    if (context.entityType === 'market' && context.entityId) {
      pushRoutePath(buildPropertyIntelligenceUrl({ pi_market: context.entityId, pi_page: '1' }))
      return true
    }
    if (context.entityType === 'zip' && context.entityId) {
      pushRoutePath(buildPropertyIntelligenceUrl({ pi_q: context.entityId, pi_page: '1' }))
      return true
    }
    pushRoutePath('/properties')
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