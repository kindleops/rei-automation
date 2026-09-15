import { useEffect } from 'react'
import { openInboxDealIntelligence } from '../../modules/mobile/mobile-inbox-bridge'
import { getUniversalEntityContextSnapshot } from '../../domain/entity-graph/universal-entity-context-store'

/**
 * THE ROUTE HAS TO CARRY THE SUBJECT.
 *
 * This called `openInboxDealIntelligence()` with no arguments. The bridge
 * accepts an identity and deliberately does not overwrite an established one
 * when given nothing — so a direct arrival at /deal-intelligence opened the Deal
 * Intelligence pane on whatever thread the Inbox happened to be holding.
 *
 * Measured 2026-09-14: /deal-intelligence?property_id=278442634
 * (3016 Bellefontaine Ave, Kansas City) opened on Bertha A Daniels,
 * 1115 Nw 64th St, Miami — an unrelated seller, with the requested property_id
 * silently discarded.
 *
 * Two sources, in order of explicitness:
 *   1. the URL, which survives a reload and a shared link
 *   2. the universal entity context, for an in-app hop that only published the
 *      snapshot
 * If neither has anything the call stays argument-free, which preserves the
 * bridge's "do not erase an established identity" contract.
 */
function identityFromUrl(): {
  threadKey?: string
  propertyId?: string
  prospectId?: string
  masterOwnerId?: string
} {
  if (typeof window === 'undefined') return {}
  const params = new URLSearchParams(window.location.search)
  const read = (...keys: string[]) => {
    for (const key of keys) {
      const value = params.get(key)
      if (value && value.trim()) return value.trim()
    }
    return undefined
  }
  return {
    threadKey: read('thread_key', 'threadKey'),
    propertyId: read('property_id', 'propertyId'),
    prospectId: read('prospect_id', 'prospectId'),
    masterOwnerId: read('master_owner_id', 'masterOwnerId'),
  }
}

/** Redirect into the Deal Desk inbox workspace — do not mount InboxPage here (state would be lost on /inbox navigation). */
export function DealIntelligenceInboxRoute() {
  useEffect(() => {
    const fromUrl = identityFromUrl()
    const hasUrlIdentity = Boolean(
      fromUrl.threadKey || fromUrl.propertyId || fromUrl.prospectId || fromUrl.masterOwnerId,
    )
    if (hasUrlIdentity) {
      openInboxDealIntelligence(fromUrl)
      return
    }

    const context = getUniversalEntityContextSnapshot()
    const fromContext = {
      threadKey: context?.threadKey ?? undefined,
      propertyId: context?.propertyId
        ?? (context?.entityType === 'property' ? context?.entityId ?? undefined : undefined),
      prospectId: context?.prospectId ?? undefined,
      masterOwnerId: context?.masterOwnerId ?? undefined,
    }
    const hasContextIdentity = Boolean(
      fromContext.threadKey || fromContext.propertyId || fromContext.prospectId || fromContext.masterOwnerId,
    )
    openInboxDealIntelligence(hasContextIdentity ? fromContext : undefined)
  }, [])

  return (
    <div className="nx-route-redirect-shell" aria-busy="true" aria-live="polite">
      <p>Opening Deal Intelligence…</p>
    </div>
  )
}
